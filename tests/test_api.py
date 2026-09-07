import os
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_blog.db")
os.environ.setdefault("ADMIN_KEY", "teste123")
os.environ.setdefault("MEMORY_FILE", "test_memory.json")
os.environ.setdefault("DAILY_TOPICS", "Destino A,Destino B")

from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.services.memory import memory  # noqa: E402

Base.metadata.drop_all(bind=engine)
Base.metadata.create_all(bind=engine)

if os.path.exists("test_memory.json"):
    os.remove("test_memory.json")
memory.data = {"topics": {}}

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_post_crud():
    r = client.post(
        "/categories",
        json={"name": "Roteiros", "description": "Roteiros de viagem"},
        headers={"Authorization": "Bearer teste123"},
    )
    assert r.status_code == 201, r.text
    cat = r.json()
    assert cat["slug"] == "roteiros"

    r = client.post(
        "/posts",
        json={
            "title": "Roteiro de 3 dias em Gramado",
            "summary": "O que fazer e onde comer",
            "content": "# Gramado\n\nDurante 3 dias você pode...",
            "status": "draft",
            "category_id": cat["id"],
            "keywords": ["gramado", "roteiro"],
            "tags": ["sul", "serra gaúcha"],
        },
        headers={"Authorization": "Bearer teste123"},
    )
    assert r.status_code == 201, r.text
    post = r.json()
    assert post["slug"] == "roteiro-de-3-dias-em-gramado"
    assert post["category_id"] == cat["id"]

    r = client.get("/posts/" + post["slug"])
    assert r.status_code == 200
    assert r.json()["id"] == post["id"]

    r = client.patch(
        f"/posts/{post['id']}",
        json={"status": "scheduled", "scheduled_at": "2020-01-01T00:00:00"},
        headers={"Authorization": "Bearer teste123"},
    )
    assert r.status_code == 200

    r = client.post(
        f"/posts/{post['id']}/publish",
        headers={"Authorization": "Bearer teste123"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "published"
    assert r.json()["published_at"] is not None

    r = client.post("/posts", json={"title": "x", "content": "y"})
    assert r.status_code == 401

    r = client.delete(
        f"/posts/{post['id']}", headers={"Authorization": "Bearer teste123"}
    )
    assert r.status_code == 204


def test_generate_uses_ai_service(mocker):
    from app.services import ai as ai_module

    fake = {
        "title": "Melhor época para ir a Paris",
        "meta_title": "Melhor época para ir a Paris",
        "meta_description": "Descubra a melhor época do ano.",
        "summary": "Resumo curto.",
        "content": "# Paris\n\n"
        + "\n\n".join(
            f"Parágrafo {i} com informações úteis e detalhadas sobre Paris." for i in range(15)
        ),
        "keywords": ["paris", "quando ir"],
        "tags": ["europa"],
        "image_prompt": "Paris in spring",
    }

    mocker.patch.object(
        ai_module.ai_service, "settings", SimpleNamespace(ai_api_key="k", ai_model="m")
    )
    mocker.patch.object(ai_module.ai_service, "generate_travel_post", return_value=fake)

    r = client.post(
        "/generate/post",
        json={"topic": "Paris"},
        headers={"Authorization": "Bearer teste123"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["post"]["is_ai_generated"] is True
    assert body["post"]["slug"] == "melhor-epoca-para-ir-a-paris"


def test_generate_requires_config(mocker):
    from app.services import ai as ai_module

    mocker.patch.object(
        ai_module.ai_service, "settings", SimpleNamespace(ai_api_key="", ai_model="")
    )
    r = client.post(
        "/generate/post",
        json={"topic": "Paris"},
        headers={"Authorization": "Bearer teste123"},
    )
    assert r.status_code == 503, r.text


def test_generate_daily_uses_memory(mocker):
    from app.services import ai as ai_module

    fake = {
        "title": "Guia",
        "meta_title": "Guia",
        "meta_description": "desc",
        "summary": "resumo",
        "content": "# T\n\n" + "\n\n".join(f"Parágrafo {j} útil sobre o destino." for j in range(12)),
        "keywords": ["k1"],
        "tags": ["t1"],
        "image_prompt": "img",
        "facts": {"melhor_epoca": "epoca", "custo_medio": "baixo"},
    }

    mocker.patch.object(
        ai_module.ai_service, "settings", SimpleNamespace(ai_api_key="k", ai_model="m")
    )

    import app.services.ai as _ai_mod

    first = True

    def fake_gen(topic, category=None, language=None, target_audience=None):
        nonlocal first
        i = 1 if first else 2
        first = False
        fake["title"] = f"Guia de {topic}"
        fake["facts"] = {"melhor_epoca": f"epoca-{i}", "custo_medio": "baixo"}
        return dict(fake)

    mocker.patch.object(_ai_mod.ai_service, "generate_travel_post", side_effect=fake_gen)

    r = client.post("/generate/daily?publish=true", headers={"Authorization": "Bearer teste123"})
    assert r.status_code == 200, r.text
    posts = r.json()
    assert len(posts) == 2
    assert all(p["status"] == "scheduled" for p in posts)
    assert any(p["is_ai_generated"] for p in posts)