import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from app import models
from app.config import get_settings
from app.database import Base, engine, migrate, get_db
from sqlalchemy import text
from app.routers import auth, categories, generate, posts
from app import scheduler as scheduler_module

logging.basicConfig(level=logging.INFO)

settings = get_settings()

_scheduler = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _scheduler
    Base.metadata.create_all(bind=engine)
    migrate()
    auth.seed_admin_password()
    if settings.environment == "production":
        _scheduler = scheduler_module.start()
    try:
        yield
    finally:
        if _scheduler:
            scheduler_module.stop(_scheduler)
        engine.dispose()


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


@app.api_route("/", methods=["GET", "HEAD"])
def root():
    return {
        "app": "Blog Turismo",
        "docs": "/docs",
        "health": "/health",
        "environment": settings.environment,
    }


@app.api_route("/health", methods=["GET", "HEAD"])
def health():
    return {"status": "ok"}


@app.api_route("/health/ready", methods=["GET", "HEAD"])
def health_ready():
    start = time.perf_counter()
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        latency_ms = round((time.perf_counter() - start) * 1000, 2)
        return {
            "status": "ready",
            "database": "connected",
            "latency_ms": latency_ms,
            "version": app.version,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database unreachable: {exc}",
        )