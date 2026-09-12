from datetime import datetime
from typing import Sequence

from sqlalchemy import or_, select, update
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

def _all_post_slugs(db: Session) -> list[str]:
    return list(db.scalars(select(models.Post.slug)).all())


def create_post(db: Session, data: schemas.PostCreate) -> models.Post:
    post = models.Post(
        title=data.title,
        slug=unique_slug(data.title, _all_post_slugs(db)),
        summary=data.summary,
        content=data.content,
        cover_image=data.cover_image,
        status=data.status,
        scheduled_at=data.scheduled_at,
        keywords=serialize_list(data.keywords),
        tags=serialize_list(data.tags),
        kit_recommendations=serialize_list([k.model_dump() for k in data.kit_recommendations]),
        meta_title=data.meta_title or data.title,
        meta_description=data.meta_description,
        category_id=data.category_id,
    )
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
    stmt = select(models.Post)
    if status:
        stmt = stmt.where(models.Post.status == status)
    if category:
        stmt = stmt.where(models.Post.category.has(models.Category.slug == category))
    return db.scalars(
        stmt.order_by(models.Post.created_at.desc()).limit(limit).offset(offset)
    ).all()


def get_post(db: Session, post_id: int) -> models.Post | None:
    return db.get(models.Post, post_id)


def get_post_by_slug(db: Session, slug: str) -> models.Post | None:
    return db.scalar(select(models.Post).where(models.Post.slug == slug))


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

    for field, value in data.model_dump(exclude_unset=True).items():
        if not hasattr(post, field):
            continue
        if field in ("keywords", "tags", "kit_recommendations"):
            value = serialize_list(value or [])
        setattr(post, field, value)

    if post.status == "published" and not post.published_at:
        post.published_at = utcnow()
    db.commit()
    db.refresh(post)
    return post


def delete_post(db: Session, post_id: int) -> bool:
    post = db.get(models.Post, post_id)
    if post:
        db.delete(post)
        db.commit()
        return True
    return False


def generate_slug(db: Session, title: str) -> str:
    return unique_slug(title, _all_post_slugs(db))