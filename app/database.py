from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

# SQLite é usado como fallback para desenvolvimento local.
# Em produção (Render/Supabase), DATABASE_URL aponta para o PostgreSQL.
DATABASE_URL = settings.database_url or "sqlite:///./blog.db"
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DATABASE_URL.startswith("postgresql://") and not DATABASE_URL.startswith("postgresql+"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg2://", 1)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def migrate():
    """Aplica colunas e índices novos que create_all não adiciona em tabelas existentes."""
    inspector = inspect(engine)
    if "posts" not in inspector.get_table_names():
        return
    columns = {c["name"] for c in inspector.get_columns("posts")}
    with engine.begin() as conn:
        if "kit_recommendations" not in columns:
            conn.execute(text("ALTER TABLE posts ADD COLUMN kit_recommendations TEXT NOT NULL DEFAULT '[]'"))
        if "related_post_id" not in columns:
            conn.execute(text("ALTER TABLE posts ADD COLUMN related_post_id INTEGER REFERENCES posts(id)"))
        
        indexes = {idx["name"] for idx in inspector.get_indexes("posts")}
        for col in ("scheduled_at", "category_id", "related_post_id", "created_at"):
            idx_name = f"ix_posts_{col}"
            if idx_name not in indexes:
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS {idx_name} ON posts ({col})"))


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()