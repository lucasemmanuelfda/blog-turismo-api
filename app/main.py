import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import models
from app.config import get_settings
from app.database import Base, engine, migrate
from app.routers import categories, generate, posts
from app import scheduler as scheduler_module

logging.basicConfig(level=logging.INFO)

settings = get_settings()

_scheduler = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _scheduler
    Base.metadata.create_all(bind=engine)
    migrate()
    if settings.environment == "production":
        _scheduler = scheduler_module.start()
    yield
    if _scheduler:
        scheduler_module.stop(_scheduler)


app = FastAPI(
    title="Blog Turismo IA",
    description="Backend de blog de turismo com geração de conteúdo por IA.",
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


@app.get("/")
def root():
    return {
        "app": "Blog Turismo IA",
        "docs": "/docs",
        "health": "/health",
        "environment": settings.environment,
    }


@app.get("/health")
def health():
    return {"status": "ok"}