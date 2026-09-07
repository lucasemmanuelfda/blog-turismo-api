from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    posts: Mapped[list["Post"]] = relationship(back_populates="category")


class Post(Base):
    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(200), index=True)
    slug: Mapped[str] = mapped_column(String(240), unique=True, index=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    cover_image: Mapped[str | None] = mapped_column(String(500), nullable=True)
    image_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)

    # draft | scheduled | published
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    keywords: Mapped[str] = mapped_column(Text, default="")  # JSON list
    tags: Mapped[str] = mapped_column(Text, default="")  # JSON list

    meta_title: Mapped[str] = mapped_column(String(200), default="")
    meta_description: Mapped[str] = mapped_column(Text, default="")

    is_ai_generated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id"), nullable=True
    )
    category: Mapped[Category | None] = relationship(back_populates="posts")