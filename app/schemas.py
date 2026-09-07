from datetime import datetime
import json

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None


class CategoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    description: str | None = None
    created_at: datetime


class PostBase(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    summary: str = ""
    content: str = ""
    cover_image: str | None = None
    status: str = "draft"
    scheduled_at: datetime | None = None
    keywords: list[str] = []
    tags: list[str] = []
    meta_title: str = ""
    meta_description: str = ""
    category_id: int | None = None


class PostCreate(PostBase):
    pass


class PostUpdate(BaseModel):
    title: str | None = None
    summary: str | None = None
    content: str | None = None
    cover_image: str | None = None
    status: str | None = None
    scheduled_at: datetime | None = None
    keywords: list[str] | None = None
    tags: list[str] | None = None
    meta_title: str | None = None
    meta_description: str | None = None
    category_id: int | None = None


class PostRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    slug: str
    summary: str
    content: str
    cover_image: str | None
    image_prompt: str | None
    status: str
    scheduled_at: datetime | None
    published_at: datetime | None
    keywords: list[str]
    tags: list[str]
    meta_title: str
    meta_description: str
    is_ai_generated: bool
    created_at: datetime
    updated_at: datetime
    category_id: int | None

    @field_validator("keywords", "tags", mode="before")
    @classmethod
    def parse_json_list(cls, value):
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                return parsed if isinstance(parsed, list) else []
            except (ValueError, json.JSONDecodeError):
                return []
        return value


class GenerateRequest(BaseModel):
    topic: str = Field(min_length=3, max_length=200)
    category_id: int | None = None
    scheduled_at: datetime | None = None
    language: str | None = None
    target_audience: str | None = None


class GenerateResponse(BaseModel):
    post: PostRead
    message: str


class PublishCount(BaseModel):
    published: int