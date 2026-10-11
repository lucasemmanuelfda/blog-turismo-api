import re
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import crud, models, schemas
from app.database import get_db
from app.routers.deps import require_admin
from app.services.ai import ai_service
from app.services.images import add_attribution, image_urls, insert_images

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/posts", tags=["posts"])


def _image_keyword(post: models.Post) -> str:
    """Descobre o destino para busca de imagens priorizando tags e título."""
    from app.services.images import _extract_clean_keyword
    return _extract_clean_keyword(post.title or "", post.tags or [])


@router.get("", response_model=list[schemas.PostRead])
def list_posts(
    status_f: str | None = Query(default=None, alias="status"),
    category: str | None = None,
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return crud.list_posts(db, status=status_f, category=category, limit=limit, offset=offset)


@router.post("/relink", response_model=dict)
def relink_posts(
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Recalcula aponte para o blog relacionado em todos os posts já criados."""
    return {"related": crud.backfill_related_posts(db)}


@router.get("/{slug_or_id}", response_model=schemas.PostRead)
def get_post(slug_or_id: str, db: Session = Depends(get_db)):
    if slug_or_id.isdigit():
        post = crud.get_post(db, int(slug_or_id))
    else:
        post = crud.get_post_by_slug(db, slug_or_id)
    if not post:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post não encontrado")
    return post


@router.post("", response_model=schemas.PostRead, status_code=status.HTTP_201_CREATED)
def create_post(
    data: schemas.PostCreate,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    return crud.create_post(db, data)


@router.patch("/{post_id}", response_model=schemas.PostRead)
def update_post(
    post_id: int,
    data: schemas.PostUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    post = crud.update_post(db, post_id, data)
    if not post:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post não encontrado")
    return post


@router.post("/{post_id}/publish", response_model=schemas.PostRead)
def publish_post(
    post_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    post = crud.publish_post(db, post_id)
    if not post:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post não encontrado")
    return post


@router.post("/refresh-all-images", response_model=dict)
def refresh_all_images(
    limit: int = 200,
    offset: int = 0,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Atualiza as imagens e atribuição com hiperlink de todos os posts publicados."""
    query = (
        select(models.Post)
        .where(models.Post.status == "published")
        .order_by(models.Post.id.asc())
        .offset(offset)
        .limit(limit)
    )
    posts = db.scalars(query).all()
    updated = 0
    for post in posts:
        try:
            topic = _image_keyword(post)
            urls = image_urls(topic, tags=post.tags or [])
            if urls:
                content = re.sub(r"!\[[^\]]*\]\((?:https?:\/\/[^)\s]+)\)", "", post.content or "")
                content = "\n".join(line for line in content.split("\n") if line.strip())
                content, _ = insert_images(content, urls)
                content = add_attribution(content, urls)
                post.content = content
                post.cover_image = urls[0]
                db.commit()
                updated += 1
        except Exception as exc:
            db.rollback()
            logger.warning(f"Erro ao atualizar imagens do post {post.id}: {exc}")
    return {"total": len(posts), "updated": updated, "offset": offset, "limit": limit}


@router.post("/{post_id}/refresh-images", response_model=schemas.PostRead)
def refresh_images(
    post_id: int,
    keyword: str | None = None,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Substitui as imagens do post por fotos válidas (Wikimedia Commons) e ajusta o crédito."""
    post = db.get(models.Post, post_id)
    if not post:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post não encontrado")

    topic = keyword or _image_keyword(post)
    urls = image_urls(topic, tags=post.tags or [])
    content = re.sub(r"!\[[^\]]*\]\((?:https?:\/\/[^)\s]+)\)", "", post.content or "")
    content = "\n".join(line for line in content.split("\n") if line.strip())
    content, _ = insert_images(content, urls)
    content = add_attribution(content, urls)
    post.content = content
    post.cover_image = urls[0] if urls else post.cover_image
    db.commit()
    db.refresh(post)
    return post


@router.post("/{post_id}/kit", response_model=schemas.PostRead)
def regenerate_kit(
    post_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Gera um kit personalizado para um post existente (sem reescrever o conteúdo)."""
    post = db.get(models.Post, post_id)
    if not post:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post não encontrado")
    kit = ai_service.generate_kit(post.title)
    return crud.update_post(db, post_id, schemas.PostUpdate(kit_recommendations=kit))


@router.delete("/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_post(
    post_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    if not crud.delete_post(db, post_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post não encontrado")
    return None