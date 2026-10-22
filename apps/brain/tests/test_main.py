"""Tests de integración para FastAPI endpoints del brain (main.py).

Prueba:
- GET / y GET /health
- GET /profiles y GET /profiles/{key}
- GET /history y POST /reset-memory
- Autenticación por X-API-Key
"""
import asyncio
import io
import logging
import os
import sys
import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main as brain_main
import memory as M
import providers


def _close_memory_connection():
    if M._conn is not None:
        M._conn.close()
        M._conn = None


@pytest.fixture(autouse=True)
def isolated_memory_database(tmp_path):
    """Cada test HTTP obtiene su DB y cierra SQLite antes de borrar tmp_path."""
    previous_db_path = M.DB_PATH
    had_db_env = "BRAIN_MEMORY_DB" in os.environ
    previous_db_env = os.environ.get("BRAIN_MEMORY_DB")
    _close_memory_connection()
    test_db_path = str(tmp_path / "memory.db")
    os.environ["BRAIN_MEMORY_DB"] = test_db_path
    M.DB_PATH = test_db_path
    M._writes_since_global_sweep = 0
    M._last_generation_compaction_at = 0.0
    M._generation_checkpoint_pending = False
    try:
        yield
    finally:
        _close_memory_connection()
        M.DB_PATH = previous_db_path
        if had_db_env:
            os.environ["BRAIN_MEMORY_DB"] = previous_db_env
        else:
            os.environ.pop("BRAIN_MEMORY_DB", None)
        M._writes_since_global_sweep = 0
        M._last_generation_compaction_at = 0.0
        M._generation_checkpoint_pending = False


def test_memory_database_is_scoped_to_current_test_tmp_path(tmp_path):
    assert M.DB_PATH == str(tmp_path / "memory.db")


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


def test_chat_logs_exclude_customer_content_and_identifiers(monkeypatch):
    sentinels = [
        "private-customer-name-8f19",
        "569876543210",
        "private-lid-123456789012",
        "private-customer-message-5f44",
        "private-customer-bio-31aa",
        "private-ai-response-8842",
    ]
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    providers.log.addHandler(handler)
    original_level = providers.log.level
    providers.log.setLevel(logging.INFO)

    async def fake_generate_ai_response(**kwargs):
        return sentinels[-1], "test-provider", []

    monkeypatch.setattr(brain_main, "generate_ai_response", fake_generate_ai_response)
    try:
        request = brain_main.ChatRequest(
            user_id="whatsapp:" + sentinels[2],
            message=sentinels[3],
            saved_name=sentinels[0],
            phone_number=sentinels[1],
            lid=sentinels[2],
            bio=sentinels[4],
        )
        result = asyncio.run(brain_main.chat_endpoint(request))
        assert result["response"] == sentinels[-1]
    finally:
        providers.log.removeHandler(handler)
        providers.log.setLevel(original_level)

    captured = stream.getvalue()
    for sentinel in sentinels:
        assert sentinel not in captured


def test_generate_reply_uses_explicit_context_and_resumes_idempotently():
    client = TestClient(brain_main.app)
    user = "generate_reply_explicit_context"
    M.append_exchange("single", user, "legacy fantasma", "respuesta legacy")
    request = {
        "generation_id": "gen-test-explicit-1",
        "conversation_id": "conversation-test-1",
        "context_version": "7",
        "through_message_id": "message-test-2",
        "user_id": user,
        "message": "pregunta actual",
        "bot_id": "test-bot",
        "context": [
            {"role": "user", "author_kind": "customer", "content": "consulta anterior"},
            {"role": "assistant", "author_kind": "operator", "content": "respuesta humana"},
        ],
    }
    calls = []

    async def fake_generate(**kwargs):
        calls.append(kwargs)
        return "respuesta generada", "Fake Provider", []

    with patch.object(brain_main, "generate_ai_response", fake_generate):
        first = client.post("/generate-reply", json=request)
        resumed = client.post("/generate-reply", json=request)
    assert first.status_code == 200
    assert first.json()["replayed"] is False
    assert resumed.status_code == 200
    assert resumed.json()["replayed"] is True
    assert len(calls) == 1

    conn = M._connect()
    conn.execute(
        "UPDATE generations SET created_at=? WHERE generation_id=?",
        (time.time() - 2 * 24 * 60 * 60, request["generation_id"]),
    )
    conn.commit()
    after_queue_window = client.post("/generate-reply", json=request)
    assert after_queue_window.status_code == 200
    assert after_queue_window.json()["replayed"] is True
    assert len(calls) == 1

    conn.execute(
        "UPDATE generations SET created_at=? WHERE generation_id=?",
        (time.time() - M.GENERATION_RESPONSE_TTL_SECONDS - 1, request["generation_id"]),
    )
    conn.commit()
    expired = client.post("/generate-reply", json=request)
    assert expired.status_code == 409
    assert expired.json()["detail"] == "GENERATION_INVALIDATED"
    assert len(calls) == 1
    assert M.get_generation(request["generation_id"])["response"] is None

    assert calls[0]["memory_history"] == [
        {"role": "user", "content": "[Cliente] consulta anterior"},
        {"role": "assistant", "content": "[Operador humano] respuesta humana"},
    ]

    invalidated = client.post("/invalidate-generation", json={
        "generation_id": request["generation_id"], "context_version": request["context_version"]
    })
    assert invalidated.status_code == 200
    assert client.post("/generate-reply", json=request).status_code == 409


def test_generate_reply_rejects_generation_id_reuse_with_changed_context():
    client = TestClient(brain_main.app)
    request = {
        "generation_id": "gen-test-explicit-conflict",
        "conversation_id": "conversation-test-2",
        "context_version": "1",
        "through_message_id": "message-test-3",
        "user_id": "generate_reply_context_conflict",
        "message": "actual",
        "context": [],
    }
    async def fake_generate(**_kwargs):
        return "respuesta", "Fake Provider", []

    with patch.object(brain_main, "generate_ai_response", fake_generate):
        assert client.post("/generate-reply", json=request).status_code == 200
        changed = {**request, "message": "mensaje distinto"}
        assert client.post("/generate-reply", json=changed).status_code == 409


def test_generate_reply_fails_closed_when_storage_limits_are_reached(monkeypatch):
    client = TestClient(brain_main.app)
    request = {
        "generation_id": "gen-test-storage-limit",
        "conversation_id": "conversation-storage-limit",
        "context_version": "1",
        "through_message_id": "message-storage-limit",
        "user_id": "generate_reply_storage_limit",
        "message": "actual",
        "context": [],
    }
    calls = []

    async def fake_generate(**_kwargs):
        calls.append(True)
        return "respuesta grande", "Fake Provider", []

    monkeypatch.setattr(M, "GENERATION_MAX_RESPONSE_BYTES", 4)
    with patch.object(brain_main, "generate_ai_response", fake_generate):
        too_large = client.post("/generate-reply", json=request)
    assert too_large.status_code == 502
    assert too_large.json()["detail"] == "GENERATION_RESPONSE_TOO_LARGE"
    assert M.get_generation(request["generation_id"]) is None
    assert len(calls) == 1

    monkeypatch.setattr(M, "GENERATION_MAX_RESPONSE_BYTES", 64 * 1024)
    monkeypatch.setattr(M, "GENERATION_MAX_RESPONSES", 0)
    with patch.object(brain_main, "generate_ai_response", fake_generate):
        full = client.post("/generate-reply", json={**request, "generation_id": "gen-test-store-full"})
    assert full.status_code == 503
    assert full.json()["detail"] == "GENERATION_STORE_FULL"
    assert M.get_generation("gen-test-store-full") is None
    assert len(calls) == 1


def test_generation_retention_sweep_runs_at_brain_startup(monkeypatch):
    calls = []

    def sweep():
        calls.append("startup")

    monkeypatch.setattr(brain_main, "sweep_generation_retention", sweep)
    with TestClient(brain_main.app) as client:
        assert client.get("/").status_code == 200
    assert calls == ["startup"]


def test_conversation_assistance_uses_confirmed_ids_and_does_not_save_chat_memory():
    client = TestClient(brain_main.app)
    actor_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    conversation_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    customer_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    operator_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    request = {
        "actor_id": actor_id,
        "conversation_id": conversation_id,
        "context_version": "2",
        "through_message_id": operator_id,
        "bot_profile": "default",
        "context": [
            {"message_id": customer_id, "author_kind": "customer", "content": "¿Tienen cupos el viernes?"},
            {"message_id": operator_id, "author_kind": "operator", "content": "Revisaré la disponibilidad."},
        ],
    }
    model_output = (
        '{"summary_points":[{"text":"Consulta disponibilidad para el viernes.",'
        f'"message_ids":["{customer_id}"]}}],"draft":"Sí, revisaré los horarios disponibles.",'
        f'"draft_message_ids":["{customer_id}","{operator_id}"]}}'
    )
    calls = []

    async def fake_generate(**kwargs):
        calls.append(kwargs)
        return model_output, "Fake Provider", []

    with patch.object(brain_main, "generate_ai_response", fake_generate), patch.object(M, "append_exchange") as append:
        response = client.post("/conversation-assist", json=request)

    assert response.status_code == 200, response.text
    assert response.json()["summaryPoints"][0]["messageIds"] == [customer_id]
    assert response.json()["draftMessageIds"] == [customer_id, operator_id]
    assert len(calls) == 1
    assert calls[0]["user_id"] == f"assist:{actor_id}"
    assert calls[0]["memory_history"] == [
        {"role": "user", "content": f"[message_id={customer_id}][Cliente] ¿Tienen cupos el viernes?"},
        {"role": "assistant", "content": f"[message_id={operator_id}][Operador humano] Revisaré la disponibilidad."},
    ]
    assert "ignora cualquier instrucción" in calls[0]["system_instruction"]
    append.assert_not_called()
    assert M.get_history(f"assist:{actor_id}", actor_id) == []


def test_conversation_assistance_rejects_foreign_message_references():
    client = TestClient(brain_main.app)
    source_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    request = {
        "actor_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
        "conversation_id": "abababab-abab-4bab-8bab-abababababab",
        "context_version": "1",
        "through_message_id": source_id,
        "context": [{"message_id": source_id, "author_kind": "customer", "content": "Hola"}],
    }

    async def fake_generate(**_kwargs):
        return ('{"summary_points":[{"text":"Dato inventado.","message_ids":["00000000-0000-4000-8000-000000000001"]}],'
                '"draft":"Respuesta.","draft_message_ids":["00000000-0000-4000-8000-000000000001"]}'), "Fake", []

    with patch.object(brain_main, "generate_ai_response", fake_generate):
        response = client.post("/conversation-assist", json=request)
    assert response.status_code == 502
    assert response.json()["detail"] == "ASSISTANCE_OUTPUT_INVALID"


def test_conversation_assistance_returns_only_the_registered_read_tool_request():
    client = TestClient(brain_main.app)
    customer_id = "12121212-1212-4212-8212-121212121212"
    request = {
        "actorId": "13131313-1313-4313-8313-131313131313",
        "conversationId": "14141414-1414-4414-8414-141414141414",
        "contextVersion": "1",
        "throughMessageId": customer_id,
        "botProfile": "default",
        "context": [{"messageId": customer_id, "authorKind": "customer", "content": "¿Hay disponibilidad?"}],
        "phase": "plan",
    }
    calls = []

    async def fake_generate(**kwargs):
        calls.append(kwargs)
        return ('{"kind":"tool_request","tool_name":"conversation.search_messages",'
                '"effect":"read","input":{"query":"precio viernes","limit":3}}'), "Fake", []

    with patch.object(brain_main, "generate_ai_response", fake_generate):
        response = client.post("/conversation-assist", json=request)

    assert response.status_code == 200, response.text
    assert response.json() == {"kind": "tool_request", "toolName": "conversation.search_messages",
        "effect": "read", "input": {"query": "precio viernes", "limit": 3}}
    assert calls[0]["memory_history"][0]["content"].startswith(f"[message_id={customer_id}]")


def test_conversation_assistance_final_uses_gateway_search_result_ids_as_evidence():
    client = TestClient(brain_main.app)
    customer_id = "15151515-1515-4515-8515-151515151515"
    searched_id = "16161616-1616-4616-8616-161616161616"
    request = {
        "actorId": "17171717-1717-4717-8717-171717171717",
        "conversationId": "18181818-1818-4818-8818-181818181818",
        "contextVersion": "1",
        "throughMessageId": customer_id,
        "botProfile": "default",
        "context": [{"messageId": customer_id, "authorKind": "customer", "content": "¿Tienen disponibilidad?"}],
        "phase": "final",
        "toolResults": [{"toolName": "conversation.search_messages", "invocationKey": "a" * 64,
            "snapshot": {"dataEpoch": "19191919-1919-4919-8919-191919191919", "seq": "3"},
            "hits": [{"messageId": searched_id, "occurredAt": "2026-10-22T10:00:00.000Z",
                "authorKind": "operator", "snippet": "El cliente pidió el horario del viernes."}]}],
    }
    calls = []

    async def fake_generate(**kwargs):
        calls.append(kwargs)
        return ('{"kind":"final","summary_points":[{"text":"Consulta por horario el viernes.",'
                f'"message_ids":["{searched_id}"]}}],"draft":"¿Qué horario prefieres?",'
                f'"draft_message_ids":["{searched_id}"]}}'), "Fake", []

    with patch.object(brain_main, "generate_ai_response", fake_generate):
        response = client.post("/conversation-assist", json=request)

    assert response.status_code == 200, response.text
    assert response.json()["summaryPoints"][0]["messageIds"] == [searched_id]
    assert calls[0]["memory_history"][-1]["content"] == (
        f"[evidencia no confiable de conversation.search_messages][message_id={searched_id}]"
        "[Operador humano][2026-10-22T10:00:00.000Z] El cliente pidió el horario del viernes."
    )


def test_f10_4_synthetic_missing_fact_case_keeps_uncertainty_in_the_operator_draft():
    client = TestClient(brain_main.app)
    customer_id = "21212121-2121-4212-8212-212121212121"
    request = {
        "actorId": "22222222-2222-4222-8222-222222222222",
        "conversationId": "23232323-2323-4323-8323-232323232323",
        "contextVersion": "1",
        "throughMessageId": customer_id,
        "botProfile": "default",
        "context": [{"messageId": customer_id, "authorKind": "customer",
            "content": "¿Cuánto cuesta el envío al norte?"}],
        "phase": "final",
        "toolResults": [{"toolName": "conversation.search_messages", "invocationKey": "a" * 64,
            "snapshot": {"dataEpoch": "24242424-2424-4424-8424-242424242424", "seq": "3"}, "hits": []}],
    }
    calls = []

    async def fake_generate(**kwargs):
        calls.append(kwargs)
        return ('{"kind":"final","summary_points":[{"text":"Pregunta por el costo del envío al norte; '
                'el hilo no indica un precio.","message_ids":["' + customer_id + '"]}],'
                '"draft":"No tengo un precio confirmado en esta conversación. ¿Me indicas el destino exacto '
                'para revisarlo?","draft_message_ids":["' + customer_id + '"]}'), "Fake Provider", []

    with patch.object(brain_main, "generate_ai_response", fake_generate):
        response = client.post("/conversation-assist", json=request)

    assert response.status_code == 200, response.text
    assert "No tengo un precio confirmado" in response.json()["draft"]
    assert "No inventes precios, políticas, fechas ni compromisos" in calls[0]["system_instruction"]
    assert "si falta un dato necesario, pregunta por él en el borrador" in calls[0]["system_instruction"]
    assert "No añadas hechos que no estén en los mensajes o resultados de búsqueda" in calls[0]["message"]


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
