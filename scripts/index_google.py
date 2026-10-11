"""Script de indexação via Google Cloud Indexing API.

Permite enviar URLs do Blog Turismo para o Googlebot indexar rapidamente,
superando a limitação manual do Search Console (cota de ~10 URLs na interface
vs 200 URLs/dia na Indexing API).

Uso:
    python scripts/index_google.py --credentials "caminho/para/service_account.json"
    python scripts/index_google.py --sitemap
    python scripts/index_google.py --url "https://blog-turismo-api.lucasemmanuel2005.workers.dev/post/exemplo/"
"""
import argparse
import json
import os
import sys
import time
import xml.etree.ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import requests
from google.oauth2 import service_account
from google.auth.transport.requests import Request

INDEXING_SCOPE = ["https://www.googleapis.com/auth/indexing"]
INDEXING_ENDPOINT = "https://indexing.googleapis.com/v3/urlNotifications:publish"
DEFAULT_HOST = "https://blog-turismo-api.lucasemmanuel2005.workers.dev"
SITEMAP_URL = f"{DEFAULT_HOST}/sitemap.xml"


def get_access_token(credentials_source: str) -> str:
    """Carrega as credenciais da conta de serviço e gera um token OAuth 2.0."""
    creds_data = None
    if os.path.isfile(credentials_source):
        with open(credentials_source, "r", encoding="utf-8") as f:
            creds_data = json.load(f)
    else:
        # Tenta interpretar como string JSON
        try:
            creds_data = json.loads(credentials_source)
        except json.JSONDecodeError:
            raise ValueError(
                f"Credenciais não encontradas no caminho e não são JSON válido: {credentials_source}"
            )

    credentials = service_account.Credentials.from_service_account_info(
        creds_data, scopes=INDEXING_SCOPE
    )
    credentials.refresh(Request())
    return credentials.token


def fetch_sitemap_urls(sitemap_url: str = SITEMAP_URL) -> list[str]:
    """Busca todas as URLs presentes no sitemap XML."""
    print(f"Buscando sitemap em: {sitemap_url}...")
    resp = requests.get(sitemap_url, timeout=30)
    resp.raise_for_status()

    root = ET.fromstring(resp.content)
    # Suporta namespaces comuns de sitemap
    namespaces = {"ns": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = [elem.text.strip() for elem in root.findall(".//ns:loc", namespaces) if elem.text]
    if not locs:
        # Tenta sem namespace
        locs = [elem.text.strip() for elem in root.findall(".//loc") if elem.text]
    return locs


def index_url(url: str, token: str, action: str = "URL_UPDATED") -> tuple[int, str]:
    """Envia uma URL para a Google Indexing API."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {"url": url, "type": action}
    resp = requests.post(INDEXING_ENDPOINT, headers=headers, json=payload, timeout=20)
    return resp.status_code, resp.text


def main():
    parser = argparse.ArgumentParser(description="Indexador Google Cloud Indexing API")
    parser.add_argument(
        "--credentials",
        "-c",
        default=os.getenv("GOOGLE_CREDENTIALS") or os.getenv("GOOGLE_APPLICATION_CREDENTIALS"),
        help="Caminho do arquivo JSON da Service Account ou JSON em string (padrão: env GOOGLE_CREDENTIALS)",
    )
    parser.add_argument(
        "--url",
        "-u",
        help="URL específica para indexar",
    )
    parser.add_argument(
        "--sitemap",
        "-s",
        action="store_true",
        help="Indexar URLs do sitemap (padrão se nenhuma URL específica for passada)",
    )
    parser.add_argument(
        "--limit",
        "-l",
        type=int,
        default=195,
        help="Limite máximo de URLs por execução (limite diário do Google é 200, padrão: 195)",
    )

    args = parser.parse_args()

    print("=" * 65)
    print(" GOOGLE CLOUD INDEXING API - BLOG TURISMO")
    print("=" * 65)

    if not args.credentials:
        print("\n[ERRO] Credenciais da conta de serviço não informadas!")
        print("Como obter e usar:")
        print("  1. No Google Cloud Console (projeto 'blog-turismo-509022'):")
        print("     - Ative a 'Indexing API'")
        print("     - Crie uma Conta de Serviço (Service Account) e baixe a chave JSON")
        print("  2. No Google Search Console:")
        print("     - Adicione o e-mail da conta de serviço como 'Proprietário' (Owner)")
        print("  3. Execute este script:")
        print("     python scripts/index_google.py --credentials chave-servico.json\n")
        sys.exit(1)

    print("\n[1/3] Autenticando com o Google Cloud...")
    try:
        token = get_access_token(args.credentials)
        print("  [OK] Token OAuth 2.0 gerado com sucesso!")
    except Exception as exc:
        print(f"  [ERRO] Falha na autenticação: {exc}")
        sys.exit(1)

    # Coleta URLs
    urls_to_index: list[str] = []
    if args.url:
        urls_to_index = [args.url]
    else:
        try:
            urls_to_index = fetch_sitemap_urls()
            print(f"  [OK] Encontradas {len(urls_to_index)} URLs no sitemap.")
        except Exception as exc:
            print(f"  [ERRO] Falha ao ler sitemap: {exc}")
            sys.exit(1)

    if not urls_to_index:
        print("Nenhuma URL para indexar.")
        sys.exit(0)

    # Aplica limite de segurança (200/dia)
    target_urls = urls_to_index[: args.limit]
    print(f"\n[2/3] Submetendo {len(target_urls)} URLs para a Google Indexing API...")
    print("  (Cota diária da API: 200 requisições por dia por propriedade)")

    success_count = 0
    quota_reached = False

    for idx, url in enumerate(target_urls, 1):
        try:
            code, body = index_url(url, token)
            if code == 200:
                print(f"  [{idx}/{len(target_urls)}] [HTTP 200] OK -> {url}")
                success_count += 1
            elif code == 429:
                print(f"\n  [ALERTA] Cota diária de 200 requisições do Google atingida (HTTP 429).")
                quota_reached = True
                break
            elif code == 403:
                print(f"  [{idx}/{len(target_urls)}] [HTTP 403] Permissão negada!")
                print("  -> Verifique se a conta de serviço é 'Proprietário' (Owner) no Google Search Console.")
                print(f"     Detalhe: {body}")
                break
            else:
                print(f"  [{idx}/{len(target_urls)}] [HTTP {code}] {url} -> {body}")
        except Exception as exc:
            print(f"  [{idx}/{len(target_urls)}] [ERRO] {url}: {exc}")

        time.sleep(0.15)

    print("\n[3/3] Resumo da execução:")
    print(f"  - URLs enviadas com sucesso: {success_count}/{len(target_urls)}")
    if quota_reached:
        print("  - Nota: Cota de hoje concluída. O restante pode ser enviado amanhã.")
    print("=" * 65)


if __name__ == "__main__":
    main()
