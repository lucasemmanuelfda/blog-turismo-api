import json
import urllib.parse
import urllib.request
from urllib.parse import quote

from app.config import get_settings

WIDTH, HEIGHT = 1200, 600

# Impede hotlink externo de adicionar margens (o padrão do LoremFlickr) e
# garante fotos reais: Wikimedia Commons redimensiona proporcionalmente,
# e o frontend recorta para 16:9 com object-fit: cover.


def _commons(keyword: str, n: int) -> list[str]:
    """Fotos livres do Wikimedia Commons relacionadas à palavra-chave."""
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "format": "json",
            "generator": "search",
            "gsrsearch": f"filetype:bitmap {keyword}",
            "gsrnamespace": "6",
            "gsrlimit": str(n),
            "prop": "imageinfo",
            "iiprop": "url|mime",
            "iiurlwidth": str(WIDTH),
        }
    )
    url = "https://commons.wikimedia.org/w/api.php?" + params
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            payload = json.loads(r.read().decode("utf-8"))
        pages = (payload.get("query") or {}).get("pages") or {}
        out: list[str] = []
        for page in pages.values():
            info = (page.get("imageinfo") or [{}])[0]
            thumb = info.get("thumburl") or ""
            if thumb and info.get("mime", "").startswith("image/"):
                out.append(thumb.split("&", 1)[0])
        return out[:n]
    except Exception:
        return []


def _picsum(keyword: str, variant: int) -> str:
    return f"https://picsum.photos/seed/{quote(keyword)}-{variant}/{WIDTH}/{HEIGHT}"


def image_urls(topic: str, n: int = 3, width: int = WIDTH, height: int = HEIGHT) -> list[str]:
    """n imagens 16:9 por tema (nunca placeholder/margem sólida)."""
    keyword = (topic.strip() or "travel").split()[0].lower() or "travel"
    if not get_settings().validate_images:
        return [_picsum(keyword, i) for i in range(1, n + 1)]
    urls = _commons(keyword, n)
    if not urls:
        urls = [_picsum(keyword, i) for i in range(1, n + 1)]
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