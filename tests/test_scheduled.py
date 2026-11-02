"""Testes automatizados para agendamento de posts e persistência de memória."""
from datetime import timedelta

from app import crud, schemas
from app.database import Base, SessionLocal, engine
from app.models import AppSetting
from app.services.memory import MemoryManager, SETTING_KEY
from app.timeutil import utcnow


def setup_function():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def test_list_scheduled_posts_and_publish_due():
    with SessionLocal() as db:
        now = utcnow()
        past = now - timedelta(hours=2)
        future = now + timedelta(hours=24)

        # 1. Cria post agendado no passado (vencido)
        crud.create_post(
            db,
            schemas.PostCreate(
                title="Roteiro Bonito Expirado",
                summary="Resumo",
                content="Conteudo",
                status="scheduled",
                scheduled_at=past,
            ),
        )

        # 2. Cria post agendado no futuro
        crud.create_post(
            db,
            schemas.PostCreate(
                title="Roteiro Gramado Futuro",
                summary="Resumo",
                content="Conteudo",
                status="scheduled",
                scheduled_at=future,
            ),
        )

        # 3. Testa list_posts com status="scheduled"
        scheduled = crud.list_posts(db, status="scheduled")
        assert len(scheduled) == 2
        # Ordenação deve trazer o que vence antes primeiro
        assert scheduled[0].title == "Roteiro Bonito Expirado"
        assert scheduled[1].title == "Roteiro Gramado Futuro"

        # 4. Executa publish_due_posts
        published_count = crud.publish_due_posts(db, now=now)
        assert published_count == 1

        # 5. Verifica se o expirado foi publicado e o futuro segue agendado
        scheduled_remaining = crud.list_posts(db, status="scheduled")
        assert len(scheduled_remaining) == 1
        assert scheduled_remaining[0].title == "Roteiro Gramado Futuro"

        published = crud.list_posts(db, status="published")
        assert len(published) == 1
        assert published[0].title == "Roteiro Bonito Expirado"


def test_memory_persistence_in_database(tmp_path):
    mem_file = str(tmp_path / "test-memory.json")
    mem = MemoryManager(path=mem_file)

    # 1. Registra fato na memória
    mem.remember(
        topic="Fernando de Noronha",
        facts={"Taxa": "TPA ambiental obrigatoria"},
        title="Guia Fernando de Noronha",
        slug="guia-fernando-de-noronha",
    )

    # 2. Confirma que foi salvo no banco (tabela app_settings)
    with SessionLocal() as db:
        row = db.get(AppSetting, SETTING_KEY)
        assert row is not None
        assert "Fernando de Noronha" in row.value
        assert "TPA ambiental obrigatoria" in row.value

    # 3. Cria nova instância da memória simulando reinício do app
    mem2 = MemoryManager(path=str(tmp_path / "another-path.json"))
    assert "noronha" in mem2.context_block("Fernando de Noronha").lower()
