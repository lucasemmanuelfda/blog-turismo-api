import re
from datetime import datetime
from typing import Sequence

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import selectinload
from sqlalchemy.orm import Session

from app import models, schemas
from app.services import serialize_list, unique_slug
from app.timeutil import utcnow


# ---------- Categorias ----------

def get_or_create_category(db: Session, name: str, description: str | None = None) -> models.Category:
    cat = db.scalar(select(models.Category).where(models.Category.name == name))
    if cat:
        return cat
    slug = unique_slug(name, _all_category_slugs(db))
    cat = models.Category(name=name, slug=slug, description=description)
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


def _all_category_slugs(db: Session) -> list[str]:
    return list(db.scalars(select(models.Category.slug)).all())


def list_categories(db: Session) -> Sequence[models.Category]:
    return db.scalars(select(models.Category).order_by(models.Category.name)).all()


# ---------- Posts ----------
def _dedupe_tags(tags: list[str]) -> list[str]:
    seen = set()
    out = []
    for t in tags:
        clean = (t or "").strip()
        if not clean:
            continue
        lower = clean.lower()
        if lower not in seen:
            seen.add(lower)
            out.append(clean)
    return out


def _all_post_slugs(db: Session) -> list[str]:
    return list(db.scalars(select(models.Post.slug)).all())


def _post_words(post: models.Post) -> set[str]:
    source = " ".join([
        post.title or "",
        *post.keywords.split(","),
        *post.tags.split(","),
    ])
    return {w for w in re.findall(r"[a-z0-9\u00e0-\u00ff]+", source.lower()) if len(w) > 2}


def _related_score(a: models.Post, b: models.Post) -> int:
    """Quão correlacionados dois posts são: mesma categoria + palavras em comum."""
    score = 10 if (a.category_id and a.category_id == b.category_id) else 0
    score += len(_post_words(a) & _post_words(b))
    return score


def find_related_post(db: Session, post: models.Post) -> models.Post | None:
    """Melhor post de tema correlacionado (publicado > rascunho, sem espelho)."""
    candidates = list(
        db.scalars(
            select(models.Post)
            .where(models.Post.id != post.id)
            .order_by(models.Post.id.desc())
            .limit(50)
        )
    )
    if not candidates:
        return None
    # ponytail: O(n²) por post no backfill; irrelevante para blogs (< 1k posts).
    def key(c: models.Post):
        mirror = 1 if c.related_post_id == post.id else 0
        unpublished = 0 if c.status == "published" else 1
        return (-_related_score(post, c), unpublished, mirror, c.id)

    for c in sorted(candidates, key=key):
        if _related_score(post, c) > 0:
            return c
    return None


def backfill_related_posts(db: Session) -> int:
    """Aponta posts já criados e novos para o blog correlacionado (cadeia padrão)."""
    changed = 0
    for post in db.scalars(select(models.Post).order_by(models.Post.id)).all():
        target = find_related_post(db, post)
        if target and post.related_post_id != target.id:
            post.related_post_id = target.id
            changed += 1
    db.commit()
    return changed


def create_post(db: Session, data: schemas.PostCreate) -> models.Post:
    target_slug = unique_slug(data.title, _all_post_slugs(db))
    db.execute(delete(models.PostRedirect).where(models.PostRedirect.old_slug == target_slug))
    post = models.Post(
        title=data.title,
        slug=target_slug,
        summary=data.summary,
        content=data.content,
        cover_image=data.cover_image,
        status=data.status,
        scheduled_at=data.scheduled_at,
        keywords=serialize_list(data.keywords),
        tags=serialize_list(_dedupe_tags(data.tags)),
        kit_recommendations=serialize_list([k.model_dump() for k in data.kit_recommendations]),
        meta_title=data.meta_title or data.title,
        meta_description=data.meta_description,
        category_id=data.category_id,
        related_post_id=data.related_post_id,
    )
    if not post.related_post_id:
        target = find_related_post(db, post)
        if target and target.id != post.id:
            post.related_post_id = target.id
    elif post.related_post_id == post.id:
        post.related_post_id = None
    if data.status == "published" and not post.published_at:
        post.published_at = utcnow()
    db.add(post)
    db.commit()
    db.refresh(post)
    return post


def list_posts(
    db: Session,
    status: str | None = None,
    category: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> Sequence[models.Post]:
    if status is not None and status not in ("draft", "scheduled", "published"):
        return []
    stmt = (
        select(models.Post)
        .options(selectinload(models.Post.category), selectinload(models.Post.related_post))
    )
    if status:
        stmt = stmt.where(models.Post.status == status)
    if category:
        stmt = stmt.where(models.Post.category.has(models.Category.slug == category))
    if status == "published":
        order = models.Post.published_at.desc().nulls_last()
    elif status == "scheduled":
        order = models.Post.scheduled_at.asc().nulls_last()
    else:
        order = models.Post.created_at.desc()
    return db.scalars(
        stmt.order_by(order, models.Post.id.desc()).limit(limit).offset(offset)
    ).all()


def get_post(db: Session, post_id: int) -> models.Post | None:
    stmt = (
        select(models.Post)
        .options(selectinload(models.Post.category), selectinload(models.Post.related_post))
        .where(models.Post.id == post_id)
    )
    return db.scalar(stmt)


def get_post_by_slug(db: Session, slug: str) -> models.Post | None:
    stmt = (
        select(models.Post)
        .options(selectinload(models.Post.category), selectinload(models.Post.related_post))
        .where(models.Post.slug == slug)
    )
    return db.scalar(stmt)


def get_post_by_slug_or_redirect(db: Session, slug: str) -> tuple[models.Post | None, bool]:
    post = get_post_by_slug(db, slug)
    if post:
        return post, False
    redirect_stmt = select(models.PostRedirect).where(models.PostRedirect.old_slug == slug)
    redir = db.scalar(redirect_stmt)
    if redir:
        post = get_post(db, redir.post_id)
        if post:
            return post, True
    return None, False


def publish_post(db: Session, post_id: int) -> models.Post | None:
    post = db.get(models.Post, post_id)
    if post:
        post.status = "published"
        if not post.published_at:
            post.published_at = utcnow()
        db.commit()
        db.refresh(post)
    return post


def publish_due_posts(db: Session, now: datetime | None = None) -> int:
    """Publica todos os posts agendados cuja data já passou."""
    now = now or utcnow()
    result = db.execute(
        update(models.Post)
        .where(
            models.Post.status == "scheduled",
            models.Post.scheduled_at <= now,
        )
        .values(status="published", published_at=now)
    )
    db.commit()
    return result.rowcount or 0


def update_post(db: Session, post_id: int, data: schemas.PostUpdate) -> models.Post | None:
    post = db.get(models.Post, post_id)
    if not post:
        return None

    old_slug = post.slug
    new_slug = getattr(data, "slug", None)
    if new_slug and new_slug != old_slug and post.published_at is not None:
        # Remova qualquer redirect antigo que aponte para new_slug para evitar loop / auto-redirect
        db.execute(delete(models.PostRedirect).where(models.PostRedirect.old_slug == new_slug))
        existing_redir = db.scalar(select(models.PostRedirect).where(models.PostRedirect.old_slug == old_slug))
        if existing_redir:
            existing_redir.post_id = post.id
        else:
            db.add(models.PostRedirect(old_slug=old_slug, post_id=post.id))
        # 1-hop: atualiza todos os redirects antigos que apontavam para este post garantindo destino direto
        db.execute(
            update(models.PostRedirect)
            .where(models.PostRedirect.post_id == post.id)
            .values(post_id=post.id)
        )

    for field, value in data.model_dump(exclude_unset=True).items():
        if not hasattr(post, field):
            continue
        if field == "tags":
            value = serialize_list(_dedupe_tags(value or []))
        elif field in ("keywords", "kit_recommendations"):
            value = serialize_list(value or [])
        elif field == "related_post_id" and value == post.id:
            value = None
        setattr(post, field, value)

    if post.status == "published" and not post.published_at:
        post.published_at = utcnow()
    db.commit()
    db.refresh(post)
    return post


def delete_post(db: Session, post_id: int) -> bool:
    post = db.get(models.Post, post_id)
    if post:
        # Desvincula posts que tinham este como post relacionado para evitar violação de FK
        db.execute(
            update(models.Post)
            .where(models.Post.related_post_id == post_id)
            .values(related_post_id=None)
        )
        db.execute(delete(models.PostRedirect).where(models.PostRedirect.post_id == post_id))
        db.delete(post)
        db.commit()
        return True
    return False


def generate_slug(db: Session, title: str) -> str:
    return unique_slug(title, _all_post_slugs(db))