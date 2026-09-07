from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings

security = HTTPBearer(auto_error=False)


def require_admin(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> None:
    settings = get_settings()
    if not settings.admin_key:
        return
    if credentials is None or credentials.credentials != settings.admin_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciais de administrador inválidas",
        )