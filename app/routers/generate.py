from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import crud, models, schemas
from app.config import get_settings
from app.database import get_db
from app.routers.deps import require_admin
from app.services.ai import ai_service
from app.services.images import image_urls, insert_images
from app.services.memory import memory
from app.services.trends import SEED_TOPICS as SEED_TOPICS_FALLBACK, trends

router = APIRouter(prefix="/generate", tags=["generate"])


def _to_post(db: Session, topic: str, category_name: str | None, scheduled_at: datetime | None) -> models.Post:
    category: models.Category | None = None
    if category_name:
        category = crud.get_or_create_category(db, category_name)

    data = ai_service.generate_travel_post(
        topic=topic,
        category=category.name if category else "geral",
    )

    slug = crud.generate_slug(db, data["title"])
    content, cover = insert_images(data["content"], image_urls(topic))
    post = crud.create_post(
        db,
        schemas.PostCreate(
            title=data["title"],
            summary=data["summary"],
            content=content,
            status="scheduled" if scheduled_at else "draft",
            scheduled_at=scheduled_at,
            keywords=data["keywords"],
            tags=data["tags"],
            meta_title=data["meta_title"] or data["title"],
            meta_description=data["meta_description"] or data["summary"][:155],
            category_id=category.id if category else None,
        ),
    )
    post.slug = slug
    post.cover_image = cover or data.get("image_prompt", "")
    post.is_ai_generated = True
    db.commit()
    db.refresh(post)

    memory.remember(topic, data.get("facts", {}), post.title, post.slug, category_name)
    return post


@router.post("/post", response_model=schemas.GenerateResponse, status_code=status.HTTP_201_CREATED)
def generate_post(
    request: schemas.GenerateRequest,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    if not ai_service.available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Geração de conteúdo por IA não configurada. Defina AI_API_KEY e AI_MODEL no ambiente.",
        )

    category_name = None
    if request.category_id:
        category = db.get(models.Category, request.category_id)
        if not category:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Categoria não encontrada")
        category_name = category.name

    try:
        post = _to_post(db, request.topic, category_name, request.scheduled_at)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Falha ao gerar conteúdo: {exc}",
        )

    return schemas.GenerateResponse(
        post=schemas.PostRead.model_validate(post),
        message="Artigo gerado. Revise antes de publicar.",
    )


def _topics_of_the_day() -> list[str]:
    """Temas do dia: fila configurada (DAILY_TOPICS) ou tendências → evergreen."""
    settings = get_settings()

    queued = memory.queue_topics()
    if queued:
        return queued

    candidates = trends.daily_candidates()
    evergreen = ai_service.to_evergreen_topics(
        candidates, count=settings.max_posts_per_day + 3
    )
    fresh = [t for t in evergreen if memory._key(t) not in set(memory.data["topics"])]
    return fresh or evergreen or SEED_TOPICS_FALLBACK


@router.get("/topics", response_model=list[str])
def topics_preview(_: None = Depends(require_admin)):
    """Mostra os temas que seriam gerados hoje (não gera nada)."""
    return _topics_of_the_day()


@router.post("/daily", response_model=list[schemas.PostRead])
def generate_daily(
    count: int | None = None,
    publish: bool = False,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin),
):
    """Gera artigos diários para temas ainda não cobertos e agenda a publicação.

    Temas: preferencialmente a fila DAILY_TOPICS; senão, Google Trends do dia
    transformado pela IA em tópicos evergreen (atemporais).
    """
    if not ai_service.available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Geração de conteúdo por IA não configurada.",
        )

    settings = get_settings()
    topics = _topics_of_the_day()
    limit = min(count or settings.max_posts_per_day, settings.max_posts_per_day)
    posts: list[models.Post] = []
    now = datetime.utcnow()

    for i, topic in enumerate(topics[:limit]):
        scheduled_at = now + timedelta(hours=24 + i * 6) if publish else None
        try:
            posts.append(_to_post(db, topic.strip(), None, scheduled_at))
        except Exception:
            continue

    return [schemas.PostRead.model_validate(p) for p in posts]