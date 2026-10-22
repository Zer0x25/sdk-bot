"""Tests de la memoria persistente SQLite (apps/brain/memory.py, F4-P1/P2).

Ejecutar: python -m pytest tests/ (desde apps/brain/).
Cada test usa un archivo .db temporal vía BRAIN_MEMORY_DB y resetea la
conexión global del módulo (nunca toca brain/memory.db del runtime).
"""
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import memory as M


def _nueva_db(tmp_path):
    """Apunta memory a un .db temporal y resetea la conexión global."""
    if M._conn is not None:
        M._conn.close()
    M._conn = None
    M._writes_since_global_sweep = 0
    M._last_generation_compaction_at = 0.0
    M._generation_checkpoint_pending = False
    os.environ["BRAIN_MEMORY_DB"] = str(tmp_path / "memoria_test.db")
    M.DB_PATH = os.environ["BRAIN_MEMORY_DB"]


def test_append_y_get_roundtrip(tmp_path):
    _nueva_db(tmp_path)
    M.append_exchange("bot1", "user1", "hola", "¡hola!")
    M.append_exchange("bot1", "user1", "precio", "10 USD")
    history = M.get_history("bot1", "user1")
    assert history == [
        {"role": "user", "content": "hola"},
        {"role": "assistant", "content": "¡hola!"},
        {"role": "user", "content": "precio"},
        {"role": "assistant", "content": "10 USD"},
    ]


def test_aislamiento_por_bot(tmp_path):
    """P2: el mismo user_id en bots distintos NO comparte memoria."""
    _nueva_db(tmp_path)
    M.append_exchange("botA", "user1", "hola A", "resp A")
    M.append_exchange("botB", "user1", "hola B", "resp B")
    assert M.get_history("botA", "user1") == [
        {"role": "user", "content": "hola A"},
        {"role": "assistant", "content": "resp A"},
    ]
    assert M.get_history("botB", "user1") == [
        {"role": "user", "content": "hola B"},
        {"role": "assistant", "content": "resp B"},
    ]
    assert M.get_history("botC", "user1") == []


def test_clear_history(tmp_path):
    _nueva_db(tmp_path)
    M.append_exchange("bot1", "user1", "hola", "adiós")
    assert M.clear_history("bot1", "user1") is True
    assert M.get_history("bot1", "user1") == []
    # Ya vacío -> False (sin cambios)
    assert M.clear_history("bot1", "user1") is False


def test_generation_ledger_is_idempotent_and_invalidated_generations_cannot_return(tmp_path):
    _nueva_db(tmp_path)
    assert M.save_generation("gen1", "fingerprint", "2", "respuesta", "fake") == {
        "status": "generated", "response": "respuesta", "provider": "fake"
    }
    assert M.get_generation("gen1")["response"] == "respuesta"
    assert M.save_generation("gen1", "fingerprint", "2", "otra", "fake")["response"] == "respuesta"
    M.invalidate_generation("gen2", "3")
    assert M.get_generation("gen2")["status"] == "invalidated"
    try:
        M.save_generation("gen2", "fingerprint", "3", "tardía", "fake")
        raise AssertionError("una generación invalidada no puede quedar disponible")
    except ValueError as error:
        assert str(error) == "GENERATION_INVALIDATED"


def test_generation_retention_expires_response_then_purges_tombstone(tmp_path, monkeypatch):
    monkeypatch.setattr(M, "GENERATION_RESPONSE_TTL_SECONDS", 7 * 24 * 60 * 60)
    monkeypatch.setattr(M, "GENERATION_TOMBSTONE_TTL_SECONDS", 30 * 24 * 60 * 60)
    monkeypatch.setattr(M, "GENERATION_RETENTION_SWEEP_SECONDS", 0)
    monkeypatch.setattr(M, "GENERATION_MAX_RESPONSE_BYTES", 64 * 1024)
    _nueva_db(tmp_path)

    M.save_generation("retained", "fingerprint", "1", "x" * 32768, "fake")
    conn = M._connect()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    pages_with_response = conn.execute("PRAGMA page_count").fetchone()[0]

    now = time.time()
    conn.execute(
        "UPDATE generations SET created_at=? WHERE generation_id='retained'",
        (now - 2 * 24 * 60 * 60,),
    )
    conn.commit()
    assert M.get_generation("retained")["response"] == "x" * 32768

    conn.execute(
        "UPDATE generations SET created_at=? WHERE generation_id='retained'",
        (time.time() - M.GENERATION_RESPONSE_TTL_SECONDS - 1,),
    )
    conn.commit()
    expired = M.get_generation("retained")
    assert expired["status"] == "invalidated"
    assert expired["response"] is None
    assert expired["provider"] is None
    assert conn.execute("PRAGMA page_count").fetchone()[0] < pages_with_response
    with pytest.raises(ValueError, match="GENERATION_INVALIDATED"):
        M.save_generation("retained", "fingerprint", "1", "respuesta nueva", "fake")

    conn.execute(
        "UPDATE generations SET created_at=? WHERE generation_id='retained'",
        (time.time() - M.GENERATION_TOMBSTONE_TTL_SECONDS - 1,),
    )
    conn.commit()
    assert M.sweep_generation_retention()["purged"] == 1
    assert M.get_generation("retained") is None


def test_generation_response_size_and_active_count_are_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(M, "GENERATION_MAX_RESPONSE_BYTES", 5)
    monkeypatch.setattr(M, "GENERATION_MAX_RESPONSES", 1)
    _nueva_db(tmp_path)

    with pytest.raises(ValueError, match="GENERATION_RESPONSE_TOO_LARGE"):
        M.save_generation("too-large", "fp", "1", "123456", "fake")
    M.save_generation("first", "fp", "1", "12345", "fake")
    with pytest.raises(ValueError, match="GENERATION_STORE_FULL"):
        M.save_generation("second", "fp", "1", "ok", "fake")

    # La cancelación debe poder dejar tombstone aunque el cupo de respuestas activas esté lleno.
    M.invalidate_generation("second", "1")
    with pytest.raises(ValueError, match="GENERATION_INVALIDATED"):
        M.save_generation("second", "fp", "1", "ok", "fake")
    M.invalidate_generation("first", "1")
    assert M.save_generation("third", "fp", "1", "ok", "fake")["status"] == "generated"


def test_truncado_por_cantidad(tmp_path, monkeypatch):
    # Fija el límite de cantidad para validar el recorte, independiente del
    # default activo en .env.tuning (que puede ser 0 = sin límite).
    monkeypatch.setattr(M, "MAX_HISTORY_MESSAGES", 15)
    _nueva_db(tmp_path)
    for i in range(40):  # 20 intercambios > MAX_HISTORY_MESSAGES (15)
        M.append_exchange("bot1", "user1", f"u{i}", f"a{i}")
    history = M.get_history("bot1", "user1")
    assert len(history) == M.MAX_HISTORY_MESSAGES
    # Se conservan los MÁS RECIENTES
    assert history[-1] == {"role": "assistant", "content": "a39"}


def test_truncado_por_tokens(tmp_path, monkeypatch):
    # Fija el tope de tokens para validar el recorte, independiente del default.
    monkeypatch.setattr(M, "MAX_HISTORY_TOKENS", 2000)
    monkeypatch.setattr(M, "MAX_HISTORY_MESSAGES", 15)
    _nueva_db(tmp_path)
    for _i in range(6):
        M.append_exchange("bot1", "user1", "x" * 400, "y" * 400)  # 800 chars por intercambio
    history = M.get_history("bot1", "user1")
    total_chars = sum(len(m["content"]) for m in history)
    # El techo por tokens es aproximado, pero debe recortar bastante
    assert total_chars <= M.MAX_HISTORY_TOKENS * M.CHARS_PER_TOKEN + 2
    # Nunca deja el historial vacío (conserva el último intercambio)
    assert len(history) >= 2
    assert history[-1] == {"role": "assistant", "content": "y" * 400}


def test_ventana_temporal_24h(tmp_path, monkeypatch):
    # Fija la ventana a 24h para validar el sweep, independiente del default
    # activo en .env.tuning (que puede ser 7 días).
    monkeypatch.setattr(M, "WINDOW_SECONDS", 24 * 60 * 60)
    _nueva_db(tmp_path)
    M.append_exchange("bot1", "user1", "viejo", "mensaje viejo")
    # Envejecer artificialmente los mensajes 25 horas
    conn = M._connect()
    conn.execute("UPDATE messages SET created_at = ?", (time.time() - 25 * 3600,))
    conn.commit()
    M.append_exchange("bot1", "user1", "nuevo", "mensaje nuevo")
    history = M.get_history("bot1", "user1")
    # El par viejo se barrió solo (sweep al escribir) y no aparece
    assert history == [
        {"role": "user", "content": "nuevo"},
        {"role": "assistant", "content": "mensaje nuevo"},
    ]
