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


def test_cleanup_stale_drafts():
    with SessionLocal() as db:
        now = utcnow()
        # Rascunho velho (> 30 dias)
        draft_old = crud.create_post(
            db,
            schemas.PostCreate(
                title="Rascunho Esquecido Antigo",
                summary="Resumo",
                content="Conteudo",
                status="draft",
            ),
        )
        draft_old.created_at = now - timedelta(days=45)

        # Rascunho recente (< 30 dias)
        draft_recent = crud.create_post(
            db,
            schemas.PostCreate(
                title="Rascunho Recente",
                summary="Resumo",
                content="Conteudo",
                status="draft",
            ),
        )
        draft_recent.created_at = now - timedelta(days=2)

        # Post publicado antigo (não deve ser deletado)
        published_old = crud.create_post(
            db,
            schemas.PostCreate(
                title="Post Publicado Antigo",
                summary="Resumo",
                content="Conteudo",
                status="published",
            ),
        )
        published_old.created_at = now - timedelta(days=60)
        db.commit()

        # Executa limpeza de rascunhos com mais de 30 dias
        deleted = crud.cleanup_stale_drafts(db, older_than_days=30)
        assert deleted == 1

        # Rascunho recente e post publicado devem continuar intactos
        assert crud.get_post(db, draft_recent.id) is not None
        assert crud.get_post(db, published_old.id) is not None
        # Rascunho velho foi deletado
        assert crud.get_post(db, draft_old.id) is None


def test_cleanup_orphaned_redirects():
    with SessionLocal() as db:
        from app.models import PostRedirect
        # 1. Cria post com redirecionamento valido
        post = crud.create_post(
            db,
            schemas.PostCreate(
                title="Destino com Redirect",
                summary="Resumo",
                content="Conteudo",
                status="published",
            ),
        )
        valid_redirect = PostRedirect(old_slug="antigo-destino-valido", post_id=post.id)
        # Redirecionamento órfão (post_id inexistente)
        orphaned_redirect = PostRedirect(old_slug="antigo-destino-orfao", post_id=999999)
        db.add_all([valid_redirect, orphaned_redirect])
        db.commit()

        # Executa limpeza de redirecionamentos órfãos
        cleaned = crud.cleanup_orphaned_redirects(db)
        assert cleaned == 1

        # Valida que o válido permaneceu e o órfão foi removido
        remaining_slugs = [r.old_slug for r in db.query(PostRedirect).all()]
        assert "antigo-destino-valido" in remaining_slugs
        assert "antigo-destino-orfao" not in remaining_slugs
