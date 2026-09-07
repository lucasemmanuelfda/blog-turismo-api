from urllib.parse import quote


def image_urls(topic: str, n: int = 3, width: int = 1024, height: int = 576) -> list[str]:
    """n imagens free da internet (LoremFlickr) 16:9 por tema, estáveis via lock."""
    keyword = quote((topic.strip() or "travel").split()[0].lower())
    return [f"https://loremflickr.com/{width}/{height}/{keyword}?lock={i}" for i in range(1, n + 1)]


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