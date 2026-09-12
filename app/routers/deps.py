import secrets

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings

security = HTTPBearer(auto_error=False)


def require_admin(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> None:
    settings = get_settings()
    if not settings.admin_key:
        if settings.environment == "production":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="ADMIN_KEY não configurada em produção",
            )
        return
    if credentials is None or not secrets.compare_digest(
        credentials.credentials, settings.admin_key
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciais de administrador inválidas",
        )