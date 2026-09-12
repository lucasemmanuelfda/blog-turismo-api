import os
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_blog.db")
os.environ.setdefault("ADMIN_KEY", "teste123")
os.environ.setdefault("MEMORY_FILE", "test_memory.json")
os.environ.setdefault("DAILY_TOPICS", "Destino A,Destino B")
os.environ.setdefault("VALIDATE_IMAGES", "false")

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


def _llm_response(llm_content: str):
    """Resposta fake no formato da API OpenAI (chat.completions)."""

    class FakeMessage:
        content = llm_content

    class FakeChoice:
        message = FakeMessage()

    class FakeResponse:
        choices = [FakeChoice()]

    return FakeResponse()


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


def test_fallback_uses_groq_when_primary_fails(mocker):
    from types import SimpleNamespace as _SN

    from app.services import ai as ai_module

    _json_content = '{"title":"T","meta_title":"T","meta_description":"d","summary":"s","content":"' + ("x" * 400) + '","keywords":["a"],"tags":["b"]}'

    def boom(**kw):
        raise RuntimeError("primario fora")

    fake_primary = _SN(chat=_SN(completions=_SN(create=mocker.Mock(side_effect=boom))))
    fake_fallback = _SN(
        chat=_SN(completions=_SN(create=mocker.Mock(return_value=_llm_response(_json_content))))
    )

    fake_settings = _SN(
        ai_model="g", ai_fallback_model="f", ai_api_key="k", ai_base_url="u",
        ai_fallback_api_key="x", ai_fallback_base_url="y", ai_language="pt-BR",
    )
    mocker.patch.object(ai_module, "time", mocker.Mock(sleep=mocker.Mock()))
    orig = (ai_module.ai_service.client, ai_module.ai_service.fallback_client, ai_module.ai_service.settings)
    ai_module.ai_service.client = fake_primary
    ai_module.ai_service.fallback_client = fake_fallback
    ai_module.ai_service.settings = fake_settings
    try:
        out = ai_module.ai_service.generate_travel_post("topico")
    finally:
        (ai_module.ai_service.client, ai_module.ai_service.fallback_client,
         ai_module.ai_service.settings) = orig
    assert out["title"] == "T"
    assert fake_fallback.chat.completions.create.called


def test_generate_forces_fallback_provider(mocker):
    from types import SimpleNamespace as _SN

    from app.services import ai as ai_module

    _json_content = '{"title":"Groq","meta_title":"Groq","meta_description":"d","summary":"s","content":"' + ("g" * 400) + '","keywords":["a"],"tags":["b"]}'

    fake_primary = _SN(chat=_SN(completions=_SN(create=mocker.Mock())))
    fake_fallback = _SN(
        chat=_SN(completions=_SN(create=mocker.Mock(return_value=_llm_response(_json_content))))
    )
    fake_settings = _SN(
        ai_model="g", ai_fallback_model="f", ai_api_key="k", ai_base_url="u",
        ai_fallback_api_key="x", ai_fallback_base_url="y", ai_language="pt-BR",
    )
    orig = (ai_module.ai_service.client, ai_module.ai_service.fallback_client, ai_module.ai_service.settings)
    ai_module.ai_service.client = fake_primary
    ai_module.ai_service.fallback_client = fake_fallback
    ai_module.ai_service.settings = fake_settings
    try:
        out = ai_module.ai_service.generate_travel_post("topico", provider="fallback")
    finally:
        (ai_module.ai_service.client, ai_module.ai_service.fallback_client,
         ai_module.ai_service.settings) = orig
    assert out["title"] == "Groq"
    assert not fake_primary.chat.completions.create.called
    assert fake_fallback.chat.completions.create.called


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

    def fake_gen(topic, category=None, language=None, target_audience=None, provider="auto"):
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


def test_daily_falls_back_to_trends_evergreen(mocker):
    import app.services.ai as _ai_mod
    import app.services.trends as _tr_mod

    from app.config import get_settings

    settings = get_settings()
    mocker.patch.object(settings, "daily_topics", "")
    mocker.patch.object(settings, "max_posts_per_day", 2)

    mocker.patch.object(
        _tr_mod.trends, "daily_candidates", return_value=["praia trend", "serra trend"]
    )
    evergreen = mocker.patch.object(
        _ai_mod.ai_service, "to_evergreen_topics",
        return_value=["Destino Trend A", "Destino Trend B"],
    )

    fake = {
        "title": "Guia",
        "meta_title": "Guia",
        "meta_description": "desc",
        "summary": "resumo",
        "content": "# T\n\n" + "\n\n".join(f"Parágrafo {j} útil." for j in range(12)),
        "keywords": ["k1"],
        "tags": ["t1"],
        "image_prompt": "img",
        "facts": {},
    }

    def fake_gen(topic, category=None, language=None, target_audience=None, provider="auto"):
        base = dict(fake)
        base["title"] = f"Guia de {topic}"
        return base

    mocker.patch.object(_ai_mod.ai_service, "settings", SimpleNamespace(ai_api_key="k", ai_model="m"))
    mocker.patch.object(_ai_mod.ai_service, "generate_travel_post", side_effect=fake_gen)

    r = client.post("/generate/daily", headers={"Authorization": "Bearer teste123"})
    assert r.status_code == 200, r.text
    posts = r.json()
    assert evergreen.called
    assert len(posts) == 2
    assert {p["title"] for p in posts} == {
        "Guia de Destino Trend A",
        "Guia de Destino Trend B",
    }


def test_trends_falls_back_to_seed(mocker, tmp_path):
    import app.services.trends as _tr_mod

    svc = _tr_mod.trends
    orig_path = svc.path
    orig_data = svc.data
    svc.path = str(tmp_path / "cache.json")
    svc.data = {}
    mocker.patch.object(svc, "_google_trends", return_value=[])
    mocker.patch.object(svc, "_news", return_value=[])
    try:
        candidates = svc.daily_candidates()
    finally:
        svc.path = orig_path
        svc.data = orig_data
    assert candidates
    assert any("lençóis" in c.lower() for c in candidates)


def test_images_never_use_lorem_placeholder(mocker):
    from app.config import get_settings
    from app.services.images import image_urls

    mocker.patch.object(get_settings(), "validate_images", True)

    mocker.patch("app.services.images._wikimedia_search", return_value=[])
    urls = image_urls("gramado", n=3)
    assert len(urls) == 3
    assert all("picsum.photos" in u for u in urls)

    mocker.patch(
        "app.services.images._wikimedia_search",
        return_value=[f"https://thumb.wikimedia.org/t{i}.jpg" for i in range(1, 4)],
    )
    urls_ok = image_urls("gramado", n=3)
    assert len(urls_ok) == 3
    assert all("wikimedia.org" in u for u in urls_ok)


def test_refresh_images_and_attribution(mocker):
    from app.config import get_settings
    from app.services.images import add_attribution

    mocker.patch.object(get_settings(), "validate_images", True)
    content = "texto\n\n![antiga](https://loremflickr.com/1200/600/x?lock=1)\n\nmais texto"
    mocker.patch(
        "app.services.images._wikimedia_search",
        return_value=[f"https://thumb.wikimedia.org/f{i}.jpg" for i in range(1, 4)],
    )
    r = client.post(
        "/posts",
        json={"title": "Post para imagens", "summary": "s", "content": content},
        headers={"Authorization": "Bearer teste123"},
    )
    assert r.status_code == 201, r.text
    pid = r.json()["id"]

    r = client.post(f"/posts/{pid}/refresh-images",
                    headers={"Authorization": "Bearer teste123"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "loremflickr" not in body["content"]
    assert "Fotos: Wikimedia Commons" in body["content"]
    assert "wikimedia.org" in (body["cover_image"] or "")

    assert "Fotos: Wikimedia Commons" not in add_attribution("x", ["https://picsum.photos/a.jpg"])


def test_slugify_boundaries():
    from app.services import slugify, unique_slug

    assert slugify("Serra Gaúcha") == "serra-gaucha"
    assert slugify("Roteiro -- de 3 dias") == "roteiro-de-3-dias"
    assert slugify("  Espaços  e  hífens  ") == "espacos-e-hifens"
    assert len(slugify("a" * 300)) == 200
    assert unique_slug("praia", []) == "praia"
    assert unique_slug("praia", ["praia"]) == "praia-2"
    assert unique_slug("praia", ["praia", "praia-2"]) == "praia-3"