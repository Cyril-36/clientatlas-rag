"""Health and metrics endpoint behaviour."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app

client = TestClient(create_app())


def test_liveness_reports_ok() -> None:
    response = client.get("/health/live")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "ai"}


def test_readiness_reports_configured_checks() -> None:
    response = client.get("/health/ready")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "ok"
    assert body["mode"] == "local"
    assert all(body["checks"].values())


def test_metrics_exposes_build_info_in_prometheus_format() -> None:
    response = client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "# TYPE clientatlas_ai_build_info gauge" in response.text


def test_metrics_reports_hosted_providers_disabled_by_default() -> None:
    response = client.get("/metrics")

    assert "clientatlas_ai_hosted_providers_allowed 0" in response.text
