import logging
import re
import urllib.parse
from urllib.parse import quote

from app.config import get_settings
from app.services import http_get_json

logger = logging.getLogger(__name__)

# 16:9 fixo: Wikimedia Commons redimensiona proporcionalmente e o frontend
# recorta com object-fit: cover — sem hotlink com margens (padrão do LoremFlickr).
WIDTH, HEIGHT = 1200, 600

ATTRIBUTION = "*Fotos: [Wikimedia Commons](https://commons.wikimedia.org)*"

BAD_TERMS = {
    "map", "mapa", "plan", "diagram", "chart", "flag", "bandeira",
    "coat of arms", "brasao", "brasão", "escudo", "logo", "locator",
    "satellite", "satelite", "document", "esquema", "icon", ".gif",
    "infographic", "infografico", "simbolo", "símbolo", ".tif", ".tiff",
    "lossy-page", "specimen"
}


def _is_valid_travel_photo(title: str, mime: str, thumb_url: str) -> bool:
    """Valida se o arquivo é uma foto real em formato JPEG e não mapa/gráfico/vetor/TIFF."""
    mime_lower = (mime or "").lower()
    thumb_lower = (thumb_url or "").lower()
    title_lower = (title or "").lower()

    # Rejeita explicitamente formatos problemáticos (TIFFs quebram o renderizador da Wikimedia)
    if any(ext in thumb_lower or ext in title_lower for ext in (".tif", ".tiff", ".svg", ".gif", "lossy-page")):
        return False

    # Deve ser mime image/jpeg ou terminar em .jpg/.jpeg
    if mime_lower and not (mime_lower.startswith("image/jpeg") or mime_lower.startswith("image/jpg")):
        return False

    is_jpeg = ".jpg" in thumb_lower or ".jpeg" in thumb_lower
    if not is_jpeg:
        return False

    return not any(term in title_lower for term in BAD_TERMS)


def is_image_url_live(url: str, timeout: float = 5.0) -> bool:
    """Verifica ativamente se a URL responde com HTTP 200 e tipo MIME de imagem real."""
    if not url or not url.startswith("http"):
        return False
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 BlogTurismo/1.0"
    }
    try:
        req = urllib.request.Request(url, headers=headers, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                ct = (resp.headers.get("Content-Type") or "").lower()
                return "image/" in ct
    except urllib.error.HTTPError as err:
        if err.code not in (405, 301, 302, 307, 308):
            return False
    except Exception:
        return False

    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                ct = (resp.headers.get("Content-Type") or "").lower()
                chunk = resp.read(512)
                return bool(chunk) and "image/" in ct
            return False
    except Exception:
        return False


def _wikimedia_search(keyword: str, n: int) -> list[str]:
    """Fotos livres do Wikimedia Commons com filtro rigoroso e verificação ativa de status HTTP 200."""
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "format": "json",
            "generator": "search",
            "gsrsearch": f"filetype:bitmap {keyword}",
            "gsrnamespace": "6",
            "gsrlimit": str(max(n * 5, 15)),
            "prop": "imageinfo",
            "iiprop": "url|mime",
            "iiurlwidth": str(WIDTH),
        }
    )
    url = "https://commons.wikimedia.org/w/api.php?" + params
    headers = {
        "User-Agent": "BlogTurismoAPI/1.0 (https://github.com/lucasemmanuelfda/blog-turismo-api)"
    }
    try:
        payload = http_get_json(url, timeout=20, headers=headers)
        pages = (payload.get("query") or {}).get("pages") or {}
        out: list[str] = []
        for page in pages.values():
            info = (page.get("imageinfo") or [{}])[0]
            thumb = info.get("thumburl") or ""
            mime = info.get("mime", "")
            title = page.get("title", "")
            if thumb and _is_valid_travel_photo(title, mime, thumb):
                clean_thumb = thumb.split("&", 1)[0]
                if clean_thumb not in out and is_image_url_live(clean_thumb):
                    out.append(clean_thumb)
            if len(out) >= n:
                break
        return out[:n]
    except Exception as exc:
        logger.warning("Wikimedia Commons indisponível: %s", exc)
        return []


def has_commons_image(keyword: str) -> bool:
    """True se o Wikimedia Commons tem foto para a palavra-chave."""
    return bool(_wikimedia_search(keyword, 1))


def _picsum(keyword: str, variant: int) -> str:
    return f"https://picsum.photos/seed/{quote(keyword)}-{variant}/{WIDTH}/{HEIGHT}"


_STOPWORDS_DESTINO = {
    "guia", "roteiro", "dicas", "melhor", "melhores", "como", "onde", "quando", "ir",
    "viagem", "destinos", "sobre", "visitar", "fazer", "dias", "turismo", "ecoturismo",
    "completo", "completa", "pratico", "pratica", "primeira", "expedicao", "expedição",
    "alem", "além", "para", "sua", "pelo", "pela", "tudo", "vale", "pena", "passeio", "passeios"
}


def _extract_clean_keyword(topic: str, tags: list[str] | None = None) -> str:
    """Extrai o destino geográfico real priorizando tags e palavras-chave específicas."""
    if tags:
        for tag in tags:
            tag_str = re.sub(r"[-_]+", " ", str(tag).strip())
            cleaned_tag = re.sub(r"[^a-zA-Z0-9\u00C0-\u00FF\s]", "", tag_str).strip()
            if cleaned_tag and len(cleaned_tag) > 2 and cleaned_tag.lower() not in _STOPWORDS_DESTINO:
                return cleaned_tag

    cleaned = re.sub(r"[^a-zA-Z0-9\u00C0-\u00FF\s]", " ", (topic or "").strip().lower())
    words = [w for w in cleaned.split() if len(w) > 2 and w not in _STOPWORDS_DESTINO]
    if len(words) >= 2:
        return f"{words[0]} {words[1]}"
    if words:
        return words[0]
    return "brasil turismo"


def image_urls(topic: str, tags: list[str] | None = None, n: int = 3) -> list[str]:
    """n imagens 16:9 por tema (sem mapas, apenas fotos de paisagem real e ativamente verificadas via HTTP)."""
    keyword = _extract_clean_keyword(topic, tags)
    if not get_settings().validate_images:
        return [_picsum(keyword, i) for i in range(1, n + 1)]
    urls = _wikimedia_search(keyword, n)
    if not urls and " " in keyword:
        # Tenta com o termo simples se a combinação composta não retornar nada
        urls = _wikimedia_search(keyword.split()[0], n)
    if not urls:
        urls = [u for u in [_picsum(keyword, i) for i in range(1, n + 1)] if is_image_url_live(u)]
    return urls[:n]


def insert_images(content: str, urls: list[str]) -> tuple[str, str]:
    """Espalha as imagens ao longo do texto e retorna (novo conteúdo, capa)."""
    if not urls:
        return content, ""
    lines = content.split("\n")
    out: list[str] = []
    inserted = 0
    total = max(len(lines), 1)
    for i, line in enumerate(lines):
        out.append(line)
        ratio = (i + 1) / total
        while inserted < len(urls) and ratio >= (inserted + 1) * 0.25:
            alt = urls[inserted].split("/")[-1].split("?")[0]
            out.append("")
            out.append(f"![{alt}]({urls[inserted]})")
            inserted += 1
    return "\n".join(out), urls[0]


def add_attribution(content: str, urls: list[str]) -> str:
    """Adiciona o crédito humano das fotos apenas com hiperlink limpo."""
    content = re.sub(r"\n*\*Fotos:.*?\*", "\n", content).strip("\n")
    if any("wikimedia.org" in (url or "") for url in urls):
        return content + "\n\n" + ATTRIBUTION
    return content