"""Tests de la memoria persistente SQLite (brain/memory.py, F4-P1/P2).

Correr: venv/bin/python -m pytest tests/ (desde brain/).
Cada test usa un archivo .db temporal vía BRAIN_MEMORY_DB y resetea la
conexión global del módulo (nunca toca brain/memory.db de prod).
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import memory as M


def _nueva_db(tmp_path):
    """Apunta memory a un .db temporal y resetea la conexión global."""
    M._conn = None
    M._writes_since_global_sweep = 0
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
