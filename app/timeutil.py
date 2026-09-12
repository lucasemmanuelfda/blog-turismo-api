"""Horário UTC: fonte única de timestamps (evita datetime.utcnow, deprecado)."""
from datetime import datetime, timezone


def utcnow() -> datetime:
    """Datetime atual em UTC SEM fuso (mesmo formato de datetime.utcnow())."""
    return datetime.now(timezone.utc).replace(tzinfo=None)