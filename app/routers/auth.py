"""Login do painel admin: troca usuário+senha por um token curto de sessão.

A senha humana é validada contra um hash bcrypt, na ordem:
hash salvo no banco (trocado pelo próprio painel) → ADMIN_PASSWORD_HASH do
ambiente → ADMIN_KEY (legado). Nenhuma senha em texto puro é armazenada.
ADMIN_KEY é também o segredo de assinatura dos tokens (máquina/CI).
"""
import secrets

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import SessionLocal, get_db
from app.models import AppSetting
from app.routers.deps import make_admin_token, require_admin

router = APIRouter(prefix="/auth", tags=["auth"])

ADMIN_PASSWORD_KEY = "admin_password_hash"
DEFAULT_ADMIN_PASSWORD = "123"  # trocada no 1º login pelo painel
BCRYPT_ROUNDS = 12


class LoginRequest(BaseModel):
    username: str = Field(default="admin", max_length=64)
    password: str = Field(min_length=1, max_length=512)


class LoginResponse(BaseModel):
    token: str
    admin: bool = True
    expires_in: int


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=512)
    new_password: str = Field(min_length=4, max_length=512)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(
        password.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)
    ).decode()


def _stored_hash(db: Session) -> str | None:
    row = db.get(AppSetting, ADMIN_PASSWORD_KEY)
    return row.value if row else None


def _check_bcrypt(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(
            password.encode("utf-8"), hashed.encode("ascii", errors="ignore")
        )
    except ValueError:
        return False


def _password_matches(password: str, settings, stored: str | None) -> bool:
    """Confere a senha contra o hash do banco, o hash do env ou a ADMIN_KEY (legado)."""
    if stored:
        return _check_bcrypt(password, stored)
    if settings.admin_password_hash:
        return _check_bcrypt(password, settings.admin_password_hash)
    return bool(settings.admin_key) and secrets.compare_digest(password, settings.admin_key)


def seed_admin_password() -> None:
    """Cria a senha inicial no banco (login admin/123) para o primeiro acesso."""
    db = SessionLocal()
    try:
        if db.get(AppSetting, ADMIN_PASSWORD_KEY) is None:
            db.add(
                AppSetting(
                    key=ADMIN_PASSWORD_KEY, value=hash_password(DEFAULT_ADMIN_PASSWORD)
                )
            )
            db.commit()
    finally:
        db.close()


@router.post("/login", response_model=LoginResponse)
def login(data: LoginRequest, db: Session = Depends(get_db)):
    settings = get_settings()
    stored = _stored_hash(db)
    secret = settings.admin_key or settings.admin_password_hash
    if not secret and (stored is None or settings.environment == "production"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciais de administrador não configuradas no ambiente",
        )
    same_user = secrets.compare_digest(
        data.username.encode("utf-8"), settings.admin_username.encode("utf-8")
    )
    if not same_user or not _password_matches(data.password, settings, stored):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuário ou senha de administrador inválidos",
        )
    ttl = settings.admin_session_hours * 3600
    return LoginResponse(token=make_admin_token(secret, ttl), expires_in=ttl)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    data: ChangePasswordRequest,
    _: None = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Troca a senha do painel, gravando o novo hash bcrypt no banco."""
    settings = get_settings()
    if not _password_matches(data.current_password, settings, _stored_hash(db)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Senha atual inválida"
        )
    new_hash = hash_password(data.new_password)
    row = db.get(AppSetting, ADMIN_PASSWORD_KEY)
    if row is None:
        db.add(AppSetting(key=ADMIN_PASSWORD_KEY, value=new_hash))
    else:
        row.value = new_hash
    db.commit()
