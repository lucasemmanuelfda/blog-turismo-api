from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

# SQLite é usado como fallback para desenvolvimento local.
# Em produção (Render/Supabase), DATABASE_URL aponta para o PostgreSQL.
DATABASE_URL = settings.database_url or "sqlite:///./blog.db"

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def migrate():
    """Aplica colunas novas que create_all não adiciona em tabelas existentes."""
    if "posts" not in inspect(engine).get_table_names():
        return
    columns = {c["name"] for c in inspect(engine).get_columns("posts")}
    if "kit_recommendations" not in columns:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE posts ADD COLUMN kit_recommendations TEXT NOT NULL DEFAULT '[]'"))


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()