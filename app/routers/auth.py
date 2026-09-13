"""Login do painel admin: troca a senha por um token curto de sessão.

A senha humana é validada contra um hash bcrypt (ADMIN_PASSWORD_HASH) — nenhuma
senha em texto puro fica armazenada. ADMIN_KEY é só credencial de máquina
(CI/API) e segredo de assinatura dos tokens. Logout: o cliente apaga o cookie.
"""
import secrets

import bcrypt
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.config import get_settings
from app.routers.deps import make_admin_token

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str = Field(min_length=1, max_length=512)


class LoginResponse(BaseModel):
    token: str
    admin: bool = True
    expires_in: int


def _password_matches(password: str, settings) -> bool:
    """Confere a senha contra o hash bcrypt; senha em texto puro nunca é comparada."""
    if settings.admin_password_hash:
        try:
            return bcrypt.checkpw(
                password.encode("utf-8"),
                settings.admin_password_hash.encode("ascii", errors="ignore"),
            )
        except ValueError:
            return False
    # Legado (sem hash configurado): aceita a ADMIN_KEY como senha.
    return bool(settings.admin_key) and secrets.compare_digest(password, settings.admin_key)


@router.post("/login", response_model=LoginResponse)
def login(data: LoginRequest):
    settings = get_settings()
    if not settings.admin_key and not settings.admin_password_hash:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciais de administrador não configuradas no ambiente",
        )
    if not _password_matches(data.password, settings):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Senha de administrador inválida",
        )
    secret = settings.admin_key or settings.admin_password_hash
    ttl = settings.admin_session_hours * 3600
    return LoginResponse(token=make_admin_token(secret, ttl), expires_in=ttl)