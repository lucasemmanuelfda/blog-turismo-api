import hashlib
import hmac
import secrets
import time

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings

security = HTTPBearer(auto_error=False)


def make_admin_token(admin_key: str, ttl_seconds: int | None = None) -> str:
    """Token curto para o painel admin: '<exp_ts>.<hmac(admin_key, "admin:<exp_ts>")>'."""
    ttl = (
        ttl_seconds
        if ttl_seconds is not None
        else get_settings().admin_session_hours * 3600
    )
    exp = int(time.time()) + ttl
    sig = hmac.new(admin_key.encode(), f"admin:{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def verify_admin_token(admin_key: str, token: str) -> bool:
    """Valida assinatura e validade (exp) de um token emitido por make_admin_token."""
    try:
        exp_str, sig = token.split(".", 1)
        exp = int(exp_str)
    except (ValueError, AttributeError):
        return False
    if exp < int(time.time()):
        return False
    expected = hmac.new(admin_key.encode(), f"admin:{exp_str}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def require_admin(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> None:
    settings = get_settings()
    secret = settings.admin_key or settings.admin_password_hash
    if not secret:
        if settings.environment == "production":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Credenciais de administrador não configuradas em produção",
            )
        return
    cred = credentials.credentials if credentials else ""
    if not cred:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciais de administrador inválidas",
        )
    if (settings.admin_key and secrets.compare_digest(cred, settings.admin_key)) or verify_admin_token(
        secret, cred
    ):
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Credenciais de administrador inválidas",
    )