"""Tests de integración para FastAPI endpoints del brain (main.py).

Prueba:
- GET / y GET /health
- GET /profiles y GET /profiles/{key}
- GET /history y POST /reset-memory
- Autenticación por X-API-Key
"""
import os
import sys
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main as brain_main
import memory as M


def setup_module():
    """Usa una base de datos SQLite temporal para la suite."""
    M._conn = None
    M.DB_PATH = "/tmp/sdk_bot_test_brain_main.db"
    try:
        os.unlink(M.DB_PATH)
    except OSError:
        pass


def teardown_module():
    try:
        os.unlink("/tmp/sdk_bot_test_brain_main.db")
    except OSError:
        pass


def test_health_check():
    client = TestClient(brain_main.app)
    res = client.get("/")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert "primary" in data
    assert "fallbacks" in data


def test_health_endpoint():
    client = TestClient(brain_main.app)
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert "uptime_seconds" in data


def test_list_profiles():
    client = TestClient(brain_main.app)
    res = client.get("/profiles")
    assert res.status_code == 200
    data = res.json()
    assert "profiles" in data
    assert any(p["key"] == "default" for p in data["profiles"])


def test_profile_detail_and_not_found():
    client = TestClient(brain_main.app)
    res = client.get("/profiles/default")
    assert res.status_code == 200
    data = res.json()
    assert data["key"] == "default"
    assert "prompt" in data

    res_404 = client.get("/profiles/perfil_inexistente_12345")
    assert res_404.status_code == 404


def test_history_and_reset_memory():
    client = TestClient(brain_main.app)
    user = "user_test_main_1"
    M.append_exchange("single", user, "pregunta", "respuesta")

    res = client.get(f"/history?user_id={user}")
    assert res.status_code == 200
    data = res.json()
    assert len(data["history"]) == 2

    # Reset memory
    res_reset = client.post("/reset-memory", json={"user_id": user})
    assert res_reset.status_code == 200
    assert res_reset.json()["status"] == "ok"

    res_empty = client.get(f"/history?user_id={user}")
    assert res_empty.json()["history"] == []


def test_require_api_key_middleware():
    client = TestClient(brain_main.app)

    with patch.object(brain_main, "BRAIN_API_KEY", "secret-test-key-999"):
        # Solo salud pública; el contexto privado exige credencial (BUG-013).
        assert client.get("/").status_code == 200
        assert client.get("/health").status_code == 200
        M.append_exchange("single", "private-auth-test", "privado", "respuesta")
        for headers in ({}, {"X-API-Key": "wrong-key"}):
            denied = client.get("/history?user_id=private-auth-test", headers=headers)
            assert denied.status_code == 401
            assert "privado" not in denied.text
        history = client.get("/history?user_id=private-auth-test", headers={
            "X-API-Key": "secret-test-key-999"
        })
        assert history.status_code == 200
        assert history.json()["history"][0]["content"] == "privado"

        # Rutas protegidas sin header -> 401
        res_blocked = client.get("/profiles")
        assert res_blocked.status_code == 401
        assert "API key inválida" in res_blocked.json()["detail"]

        # Con header incorrecto -> 401
        res_bad_key = client.get("/profiles", headers={"X-API-Key": "wrong-key"})
        assert res_bad_key.status_code == 401

        # Con header correcto -> 200
        res_ok = client.get("/profiles", headers={"X-API-Key": "secret-test-key-999"})
        assert res_ok.status_code == 200
