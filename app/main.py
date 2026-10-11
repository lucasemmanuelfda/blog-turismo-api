import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import models
from app.config import get_settings
from app.database import Base, engine, migrate
from app.routers import auth, categories, generate, posts
from app import scheduler as scheduler_module

logging.basicConfig(level=logging.INFO)

settings = get_settings()

_scheduler = None


def _run_images_backfill():
    """Atualiza as fotos e atribuição com hiperlink de todos os posts com fotos antigas."""
    import re
    import time
    from sqlalchemy import select
    from app import models
    from app.database import SessionLocal
    from app.routers.posts import _image_keyword
    from app.services.images import add_attribution, image_urls, insert_images

    time.sleep(5)
    logger = logging.getLogger("backfill")
    try:
        with SessionLocal() as db:
            posts = db.scalars(
                select(models.Post)
                .where(models.Post.status == "published")
                .order_by(models.Post.id.desc())
            ).all()
            pending = [p for p in posts if "[Wikimedia Commons](https://commons.wikimedia.org)" not in (p.content or "")]
            if not pending:
                logger.info("[Backfill] Todos os posts já possuem fotos e atribuição com hiperlink atualizadas.")
                return
            logger.info(f"[Backfill] Iniciando atualização de imagens para {len(pending)} posts...")
            for idx, post in enumerate(pending, 1):
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
                        logger.info(f"[Backfill {idx}/{len(pending)}] Post {post.id} ({post.slug}) atualizado com foto: {urls[0]}")
                    time.sleep(0.5)
                except Exception as exc:
                    db.rollback()
                    logger.warning(f"[Backfill] Falha no post {post.id}: {exc}")
            logger.info("[Backfill] Atualização de todos os posts concluída com sucesso!")
    except Exception as e:
        logger.warning(f"[Backfill] Erro geral no processo de backfill: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _scheduler
    Base.metadata.create_all(bind=engine)
    migrate()
    auth.seed_admin_password()
    if settings.environment == "production":
        _scheduler = scheduler_module.start()
        import threading
        threading.Thread(target=_run_images_backfill, daemon=True).start()
    yield
    if _scheduler:
        scheduler_module.stop(_scheduler)


app = FastAPI(
    title="Blog Turismo",
    description="Backend do blog de turismo com geração automática de conteúdo.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(posts.router)
app.include_router(categories.router)
app.include_router(generate.router)
app.include_router(auth.router)


@app.get("/")
def root():
    return {
        "app": "Blog Turismo",
        "docs": "/docs",
        "health": "/health",
        "environment": settings.environment,
    }


@app.get("/health")
def health():
    return {"status": "ok"}