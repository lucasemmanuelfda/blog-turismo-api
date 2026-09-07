import urllib.request
from urllib.parse import quote

from app.config import get_settings

WIDTH, HEIGHT = 1024, 576


def _valid_lorem(url: str) -> bool:
    """Só considera a foto real do LoremFlickr; ignora o placeholder 'X vermelho'."""
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=15) as r:
            final = r.geturl()
            content_type = r.headers.get("Content-Type", "")
            return "defaultImage" not in final and content_type.startswith("image/")
    except Exception:
        return False


def _source(keyword: str, variant: int) -> str:
    fallback = f"https://picsum.photos/seed/{quote(keyword)}-{variant}/{WIDTH}/{HEIGHT}"
    lorem = f"https://loremflickr.com/{WIDTH}/{HEIGHT}/{quote(keyword)}?lock={variant}"
    if not get_settings().validate_images or _valid_lorem(lorem):
        return lorem
    return fallback


def image_urls(topic: str, n: int = 3, width: int = WIDTH, height: int = HEIGHT) -> list[str]:
    """n imagens 16:9 por tema: LoremFlickr (relacionada ao tema) ou Picsum
    como garantia — nunca um placeholder vazio/vermelho."""
    keyword = quote((topic.strip() or "travel").split()[0].lower() or "travel")
    return [_source(keyword, i) for i in range(1, n + 1)]


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