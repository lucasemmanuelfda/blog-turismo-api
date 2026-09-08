import re

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import crud, models, schemas
from app.database import get_db
from app.routers.deps import require_admin
from app.services.images import add_attribution, image_urls, insert_images

router = APIRouter(prefix="/posts", tags=["posts"])

_STOPWORDS = {
    "de", "do", "da", "dos", "das", "e", "o", "a", "os", "as", "em", "no",
    "na", "para", "com", "um", "uma", "u", "guia", "roteiro", "como",
    "sobre", "ms", "sp", "rj", "mg", "sc", "rs", "pr", "ba", "pe", "pa",
    "go", "mt", "dias", "ano", "anos",
}


def _image_keyword(post: models.Post) -> str:
    """Descobre a palavra-chave de imagens: URL antiga do post, depois título."""
    from app.services.images import _commons

    old = re.search(r"loremflickr\.com/\d+/\d+/([^/?]+)", post.content or "")
    if old and _commons(old.group(1), 1):
        return old.group(1)
    words = re.sub(r"[^a-z0-9\s]", " ", (post.title or "").lower()).split()
    for word in words[::-1]:
        if word.isdigit() or word in _STOPWORDS or len(word) < 3:
            continue
        if _commons(word, 1):
            return word
    return words[-1] if words else (post.title or "travel")


@router.get("", response_model=list[schemas.PostRead])
def list_posts(
    status_f: str | None = Query(default=None, alias="status"),
    category: str | None = None,
    limit: int = Query(default=20, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return crud.list_posts(db, status=status_f, category=category, limit=limit, offset=offset)


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
    urls = image_urls(topic)
    content = re.sub(r"!\[[^\]]*\]\((?:https?:\/\/[^)\s]+)\)", "", post.content or "")
    content = "\n".join(line for line in content.split("\n") if line.strip())
    content, _ = insert_images(content, urls)
    content = add_attribution(content, urls)
    post.content = content
    post.cover_image = urls[0] if urls else post.cover_image
    db.commit()
    db.refresh(post)
    return post


@router.delete("/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_post(
    post_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    if not crud.delete_post(db, post_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post não encontrado")
    return None