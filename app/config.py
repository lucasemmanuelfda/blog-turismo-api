from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: str = "development"
    host: str = "0.0.0.0"
    port: int = 8000

    admin_key: str = ""

    database_url: str = ""

    ai_base_url: str = ""
    ai_api_key: str = ""
    ai_model: str = ""
    ai_language: str = "pt-BR"

    # Provedor reserva (ex.: Groq grátis) usado quando o principal falha
    ai_fallback_base_url: str = ""
    ai_fallback_api_key: str = ""
    ai_fallback_model: str = ""

    publish_interval_minutes: int = 10
    max_posts_per_day: int = 5

    # Segundo cérebro: arquivo que acumula fatos de cada destino/tema
    memory_file: str = "blog-memory.json"
    # Temas usados na geração diária automática (separados por vírgula)
    daily_topics: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()