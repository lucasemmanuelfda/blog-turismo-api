import logging

from apscheduler.schedulers.background import BackgroundScheduler

from app.config import get_settings

logger = logging.getLogger("scheduler")


def publish_job() -> None:
    from app import crud
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        count = crud.publish_due_posts(db)
        if count:
            logger.info("Publicados %d posts agendados", count)
    finally:
        db.close()


def start() -> BackgroundScheduler:
    settings = get_settings()
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(
        publish_job,
        trigger="interval",
        minutes=max(settings.publish_interval_minutes, 1),
        id="publish_due_posts",
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()
    logger.info("Agendador iniciado (intervalo de %d min)", settings.publish_interval_minutes)
    return scheduler


def stop(scheduler: BackgroundScheduler) -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)