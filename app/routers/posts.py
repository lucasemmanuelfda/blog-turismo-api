from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import crud, schemas
from app.database import get_db
from app.routers.deps import require_admin

router = APIRouter(prefix="/posts", tags=["posts"])


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


@router.delete("/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_post(
    post_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    if not crud.delete_post(db, post_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Post não encontrado")
    return None