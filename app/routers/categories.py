from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import crud, schemas
from app.database import get_db
from app.routers.deps import require_admin

router = APIRouter(prefix="/categories", tags=["categories"])


@router.get("", response_model=list[schemas.CategoryRead])
def list_categories(db: Session = Depends(get_db)):
    return crud.list_categories(db)


@router.post("", response_model=schemas.CategoryRead, status_code=status.HTTP_201_CREATED)
def create_category(
    data: schemas.CategoryCreate,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    return crud.get_or_create_category(db, data.name.strip(), data.description)