"""Interface CLI unificada de gerenciamento do Blog Turismo.

Permite testar conexões, semear dados, verificar estatísticas,
publicar posts agendados, gerar artigos via IA e iniciar o servidor.

Uso:
    python -m app.cli test-connections
    python -m app.cli seed
    python -m app.cli stats
    python -m app.cli publish-due
    python -m app.cli relink
    python -m app.cli generate "Roteiro em Bonito MS"
    python -m app.cli daily
    python -m app.cli serve
"""
import argparse
import sys
from datetime import datetime

# Garante compatibilidade com consoles Windows e UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from sqlalchemy import func, select

from app import crud, models
from app.config import get_settings
from app.database import Base, SessionLocal, engine, migrate
from app.routers import auth


def cmd_test_connections():
    """Testa conexões locais e serviços externos (DB, IA, Wikimedia, Trends)."""
    settings = get_settings()
    print("=" * 60)
    print(" DIAGNOSTICO DE CONEXOES - BLOG TURISMO")
    print("=" * 60)

    # 1. Banco de Dados
    print("\n[1/4] Banco de Dados:")
    try:
        Base.metadata.create_all(bind=engine)
        migrate()
        with SessionLocal() as db:
            post_count = db.scalar(select(func.count(models.Post.id))) or 0
        db_type = "SQLite" if "sqlite" in (settings.database_url or "sqlite") else "PostgreSQL"
        print(f"  [OK] Conexao com banco ({db_type}): OK ({post_count} posts registrados)")
    except Exception as exc:
        print(f"  [ERRO] Falha na conexao com banco: {exc}")

    # 2. Wikimedia Commons
    print("\n[2/4] Wikimedia Commons API:")
    try:
        from app.services.images import _wikimedia_search
        test_images = _wikimedia_search("brasil", 1)
        if test_images:
            print("  [OK] Wikimedia Commons: OK (encontrada foto de teste)")
        else:
            print("  [AVISO] Wikimedia Commons: Nenhuma foto retornada (usando fallback Picsum)")
    except Exception as exc:
        print(f"  [ERRO] Erro ao consultar Wikimedia: {exc}")

    # 3. Provedor de IA
    print("\n[3/4] Provedor de Inteligencia Artificial:")
    from app.services.ai import ai_service
    if ai_service.available:
        print(f"  [OK] Provedor principal configurado: {settings.ai_model}")
        print(f"       Base URL: {settings.ai_base_url or 'OpenAI default'}")
    else:
        print("  [AVISO] IA principal: Nenhuma chave ou modelo definido (AI_API_KEY/AI_MODEL)")
    if ai_service.fallback_available:
        print(f"  [OK] Provedor fallback configurado: {settings.ai_fallback_model}")
    else:
        print("  - Provedor fallback nao configurado")

    # 4. Tendencias e Noticias
    print("\n[4/4] Tendencias & Pesquisa:")
    if settings.news_api_key:
        print("  [OK] NewsAPI: Chave configurada")
    else:
        print("  - NewsAPI: Nao configurada (opcional)")
    print(f"  - Pais das tendencias: {settings.trends_country}")
    print("=" * 60)
    print("Diagnostico concluido.\n")


def cmd_seed():
    """Inicializa tabelas, senha de admin e categorias padrao."""
    print("Inicializando banco e migracoes...")
    Base.metadata.create_all(bind=engine)
    migrate()
    auth.seed_admin_password()
    print("  [OK] Senha do admin verificada/semeada.")

    default_categories = [
        ("Roteiros", "Roteiros completos e praticos de viagem"),
        ("Ecoturismo", "Natureza, trilhas e cachoeiras"),
        ("Praias", "Destinos de praia e litoral"),
        ("Gastronomia", "Onde comer e pratos tipicos"),
        ("Dicas Praticas", "Informacoes essenciais para sua viagem"),
    ]

    with SessionLocal() as db:
        for name, desc in default_categories:
            cat = crud.get_or_create_category(db, name, desc)
            print(f"  [OK] Categoria: {cat.name} ({cat.slug})")

    print("Inicializacao concluida com sucesso!")


def cmd_stats():
    """Exibe estatisticas atuais do blog."""
    with SessionLocal() as db:
        total = db.scalar(select(func.count(models.Post.id))) or 0
        published = db.scalar(select(func.count(models.Post.id)).where(models.Post.status == "published")) or 0
        scheduled = db.scalar(select(func.count(models.Post.id)).where(models.Post.status == "scheduled")) or 0
        drafts = db.scalar(select(func.count(models.Post.id)).where(models.Post.status == "draft")) or 0
        categories = list(crud.list_categories(db))

    print("=" * 40)
    print(" ESTATISTICAS DO BLOG TURISMO")
    print("=" * 40)
    print(f"Total de posts: {total}")
    print(f"  - Publicados: {published}")
    print(f"  - Agendados:  {scheduled}")
    print(f"  - Rascunhos:  {drafts}")
    print(f"\nCategorias cadastradas ({len(categories)}):")
    for c in categories:
        print(f"  - {c.name} ({c.slug})")
    print("=" * 40)


def cmd_publish_due():
    """Publica posts agendados cuja data ja expirou."""
    with SessionLocal() as db:
        count = crud.publish_due_posts(db)
    print(f"Posts agendados publicados agora: {count}")


def cmd_relink():
    """Recalcula links de artigos relacionados."""
    with SessionLocal() as db:
        changed = crud.backfill_related_posts(db)
    print(f"Posts atualizados com temas correlacionados: {changed}")


def cmd_generate(topic: str, category_name: str | None = None):
    """Gera um artigo usando o servico de IA."""
    from app.routers.generate import _to_post
    print(f"Iniciando geracao de artigo para o tema: '{topic}'...")
    with SessionLocal() as db:
        post = _to_post(db, topic, category_name, scheduled_at=None)
        print(f"[OK] Artigo gerado com sucesso!")
        print(f"  Titulo: {post.title}")
        print(f"  Slug:   {post.slug}")
        print(f"  Status: {post.status}")


def cmd_daily(count: int = 1):
    """Executa o ciclo diario de geracao."""
    from app.routers.generate import _to_post, _topics_of_the_day
    from app.timeutil import utcnow
    topics = _topics_of_the_day()
    print(f"Topicos selecionados para hoje: {topics[:count]}")
    with SessionLocal() as db:
        for t in topics[:count]:
            print(f"Gerando post para: {t}...")
            post = _to_post(db, t.strip(), None, scheduled_at=utcnow())
            print(f"  [OK] Post criado: {post.title} ({post.slug})")


def cmd_serve(host: str = "127.0.0.1", port: int = 8000, reload: bool = True):
    """Inicia o servidor de desenvolvimento."""
    import uvicorn
    print(f"Iniciando Blog Turismo API em http://{host}:{port} (docs em /docs)...")
    uvicorn.run("app.main:app", host=host, port=port, reload=reload)


def cmd_index_google(credentials: str | None = None, url: str | None = None, limit: int = 195):
    """Envia URLs do blog para a Google Cloud Indexing API."""
    import subprocess
    cmd = [sys.executable, "scripts/index_google.py", "--limit", str(limit)]
    if credentials:
        cmd.extend(["--credentials", credentials])
    if url:
        cmd.extend(["--url", url])
    else:
        cmd.append("--sitemap")
def cmd_refresh_all_images():
    """Atualiza as fotos e atribuição com hiperlink de todos os posts publicados."""
    import re
    from app.routers.posts import _image_keyword
    from app.services.images import add_attribution, image_urls, insert_images
    print("Iniciando atualização de imagens e atribuição com hiperlink...")
    with SessionLocal() as db:
        posts = db.scalars(select(models.Post).where(models.Post.status == "published")).all()
        print(f"Total de posts publicados encontrados: {len(posts)}")
        for idx, post in enumerate(posts, 1):
            topic = _image_keyword(post)
            print(f"[{idx}/{len(posts)}] Atualizando fotos de '{post.title}' (destino: {topic})...")
            urls = image_urls(topic, tags=post.tags or [])
            if urls:
                content = re.sub(r"!\[[^\]]*\]\((?:https?:\/\/[^)\s]+)\)", "", post.content or "")
                content = "\n".join(line for line in content.split("\n") if line.strip())
                content, _ = insert_images(content, urls)
                content = add_attribution(content, urls)
                post.content = content
                post.cover_image = urls[0]
                print(f"  [OK] Novas fotos aplicadas. Capa: {urls[0]}")
            else:
                print(f"  [AVISO] Nenhuma foto encontrada para '{topic}'.")
        db.commit()
    print("Atualização concluída com sucesso!")


def main():
    parser = argparse.ArgumentParser(description="Blog Turismo CLI de Gerenciamento")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # test-connections
    subparsers.add_parser("test-connections", help="Testa conectividade com DB, IA e APIs")

    # seed
    subparsers.add_parser("seed", help="Inicializa tabelas, senha de admin e categorias padrao")

    # stats
    subparsers.add_parser("stats", help="Exibe estatisticas de posts e categorias")

    # publish-due
    subparsers.add_parser("publish-due", help="Publica posts agendados vencidos")

    # relink
    subparsers.add_parser("relink", help="Recalcula referencias entre artigos relacionados")

    # generate
    gen_parser = subparsers.add_parser("generate", help="Gera um artigo via IA")
    gen_parser.add_argument("topic", type=str, help="Tema do artigo a gerar")
    gen_parser.add_argument("--category", type=str, default=None, help="Nome da categoria")

    # daily
    daily_parser = subparsers.add_parser("daily", help="Gera lote diario de posts")
    daily_parser.add_argument("--count", type=int, default=1, help="Quantidade de posts a gerar")

    # serve
    serve_parser = subparsers.add_parser("serve", help="Inicia o servidor FastAPI local")
    serve_parser.add_argument("--host", type=str, default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8000)
    serve_parser.add_argument("--no-reload", action="store_true", help="Desabilita auto-reload")

    # index-google
    index_parser = subparsers.add_parser("index-google", help="Envia URLs para Google Cloud Indexing API")
    index_parser.add_argument("--credentials", "-c", type=str, default=None, help="Caminho do JSON da Service Account")
    index_parser.add_argument("--url", "-u", type=str, default=None, help="URL especifica para indexar")
    index_parser.add_argument("--limit", "-l", type=int, default=195, help="Limite diario (padrao: 195)")

    # refresh-all-images
    subparsers.add_parser("refresh-all-images", help="Atualiza fotos e atribuicoes de todos os posts")

    args = parser.parse_args()

    if args.command == "test-connections":
        cmd_test_connections()
    elif args.command == "seed":
        cmd_seed()
    elif args.command == "stats":
        cmd_stats()
    elif args.command == "publish-due":
        cmd_publish_due()
    elif args.command == "relink":
        cmd_relink()
    elif args.command == "generate":
        cmd_generate(args.topic, args.category)
    elif args.command == "daily":
        cmd_daily(args.count)
    elif args.command == "serve":
        cmd_serve(args.host, args.port, reload=not args.no_reload)
    elif args.command == "index-google":
        cmd_index_google(args.credentials, args.url, args.limit)
    elif args.command == "refresh-all-images":
        cmd_refresh_all_images()


if __name__ == "__main__":
    main()
