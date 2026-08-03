"""Architectural guard for the model-service boundary.

The AI service must never acquire tenant database access. Every tenant query,
including the pgvector search, belongs to the Next.js application so that the
RLS transaction contract exists in exactly one place.

That is a design decision, and design decisions decay. These tests make the
decision enforceable: adding a database driver here fails the build rather than
quietly creating a second, untested path to tenant data.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

from app.config import Settings

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"

FORBIDDEN_PACKAGES = frozenset(
    {
        "asyncpg",
        "psycopg",
        "psycopg2",
        "psycopg2-binary",
        "sqlalchemy",
        "sqlmodel",
        "databases",
        "supabase",
        "pgvector",
        "alembic",
    }
)

FORBIDDEN_SETTING_FRAGMENTS = ("database", "postgres", "dsn", "service_role")


def _declared_requirements() -> list[str]:
    data: dict[str, Any] = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))

    project: dict[str, Any] = data.get("project", {})
    groups: dict[str, Any] = data.get("dependency-groups", {})

    requirements: list[str] = list(project.get("dependencies", []))
    for group in groups.values():
        requirements.extend(group)

    return requirements


def _requirement_name(requirement: str) -> str:
    name = requirement
    for separator in ("[", ">", "<", "=", "!", "~", ";", " "):
        name = name.split(separator, maxsplit=1)[0]
    return name.strip().lower()


def test_service_declares_no_database_driver() -> None:
    declared = {_requirement_name(requirement) for requirement in _declared_requirements()}
    offenders = declared & FORBIDDEN_PACKAGES

    assert not offenders, (
        f"The model service must not depend on a database package, found: {sorted(offenders)}. "
        "Tenant queries belong to the Next.js application."
    )


def test_settings_expose_no_database_credentials() -> None:
    offenders = [
        field
        for field in Settings.model_fields
        if any(fragment in field.lower() for fragment in FORBIDDEN_SETTING_FRAGMENTS)
    ]

    assert not offenders, (
        f"The model service must not be configurable with database credentials, found: {offenders}."
    )


def test_hosted_generation_is_disabled_by_default() -> None:
    assert Settings().allow_hosted_providers is False
