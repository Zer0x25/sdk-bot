# Memoria de conversación PERSISTENTE en SQLite (F4-P1/P2).
# Antes era RAM (dict) y se perdía al reiniciar el brain. Ahora:
#   - Persistencia en disco (brain/memory.db, gitignored).
#   - Aislamiento multi-bot desde el diseño: cada mensaje lleva bot_id + user_id
#     (P2). Hoy el gateway envía bot_id = su propio número; con multitenant
#     (F4-P6) cada bot usará el suyo sin migrar nada.
#   - Ventana temporal de 24h: lo más viejo se barre solo.
#   - Truncado por tokens aproximados (chars/4) al armar el contexto.
import os
import sqlite3
import threading
import time

from config import (
    BRAIN_MEMORY_GLOBAL_SWEEP_EVERY,
    BRAIN_MEMORY_MAX_MESSAGES,
    BRAIN_MEMORY_MAX_TOKENS,
    BRAIN_MEMORY_WINDOW_SECONDS,
)

DB_PATH = os.environ.get("BRAIN_MEMORY_DB") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "memory.db"
)

# Constantes de memoria ahora TUNEABLES vía .env.tuning (ver brain/config.py).
# Valores activos por defecto: ventana 24h, 15 mensajes, 2000 tokens, sweep 50.
MAX_HISTORY_MESSAGES = BRAIN_MEMORY_MAX_MESSAGES
MAX_HISTORY_TOKENS = BRAIN_MEMORY_MAX_TOKENS
CHARS_PER_TOKEN = 4             # aproximación chars -> tokens
WINDOW_SECONDS = BRAIN_MEMORY_WINDOW_SECONDS
_GLOBAL_SWEEP_EVERY = BRAIN_MEMORY_GLOBAL_SWEEP_EVERY

_conn = None
_lock = threading.Lock()
_writes_since_global_sweep = 0


def _connect():
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode = WAL")
            _conn.execute("PRAGMA synchronous = NORMAL")
            _conn.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    bot_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            _conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_bot_user_time ON messages(bot_id, user_id, created_at)"
            )
            _conn.commit()
        return _conn


def _sweep_chat(conn, bot_id, user_id):
    # Limpiar mensajes de este chat fuera de la ventana temporal
    cutoff = time.time() - WINDOW_SECONDS
    conn.execute(
        "DELETE FROM messages WHERE bot_id = ? AND user_id = ? AND created_at < ?",
        (bot_id, user_id, cutoff),
    )


def _sweep_global(conn):
    # Barrido global (todos los bots/usuarios): evita que la DB crezca sin límite
    # con chats abandonados. Va throttled por contador de escrituras.
    cutoff = time.time() - WINDOW_SECONDS
    conn.execute("DELETE FROM messages WHERE created_at < ?", (cutoff,))


def get_history(bot_id: str, user_id: str, max_messages: int = 0, max_tokens: int = 0):
    """Contexto del chat: mensajes de la ventana temporal, más recientes al final.

    max_messages / max_tokens (opcionales) acotan el resultado para la PRECARGA
    en presencia (comportamiento "primera página" web-like). Si valen 0 se usan
    los límites globales (BRAIN_MEMORY_MAX_MESSAGES / BRAIN_MEMORY_MAX_TOKENS),
    que es lo que usa /chat al generar la respuesta.
    """
    conn = _connect()
    cutoff = time.time() - WINDOW_SECONDS
    with _lock:
        rows = conn.execute(
            "SELECT role, content FROM messages WHERE bot_id = ? AND user_id = ? AND created_at >= ? "
            "ORDER BY id ASC",  # id = orden de inserción (los timestamps float pueden colisionar en un mismo tick)
            (bot_id, user_id, cutoff),
        ).fetchall()
    msgs = [{"role": r["role"], "content": r["content"]} for r in rows]

    # 1) Truncado por cantidad de mensajes (0 = sin límite)
    cap_messages = max_messages if max_messages and max_messages > 0 else MAX_HISTORY_MESSAGES
    if cap_messages > 0 and len(msgs) > cap_messages:
        msgs = msgs[-cap_messages:]

    # 2) Truncado por tokens aproximados (chars/4), conservando el último intercambio
    cap_tokens = max_tokens if max_tokens and max_tokens > 0 else MAX_HISTORY_TOKENS
    max_chars = cap_tokens * CHARS_PER_TOKEN
    total_chars = sum(len(m["content"]) for m in msgs)
    while total_chars > max_chars and len(msgs) > 2:
        total_chars -= len(msgs.pop(0)["content"])

    return msgs


def append_exchange(bot_id: str, user_id: str, user_msg: str, assistant_msg: str):
    """Guarda un intercambio user/assistant del chat (incremental, sin reescritura)."""
    global _writes_since_global_sweep
    conn = _connect()
    with _lock:
        now = time.time()
        conn.executemany(
            "INSERT INTO messages (bot_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            [
                (bot_id, user_id, "user", user_msg, now),
                (bot_id, user_id, "assistant", assistant_msg, now),
            ],
        )
        _sweep_chat(conn, bot_id, user_id)
        _writes_since_global_sweep += 1
        if _writes_since_global_sweep >= _GLOBAL_SWEEP_EVERY:
            _sweep_global(conn)
            _writes_since_global_sweep = 0
        conn.commit()


def clear_history(bot_id: str, user_id: str):
    """Borra la memoria del chat (comando /limpiar)."""
    conn = _connect()
    with _lock:
        cur = conn.execute(
            "DELETE FROM messages WHERE bot_id = ? AND user_id = ?", (bot_id, user_id)
        )
        conn.commit()
        return cur.rowcount > 0


def get_db_stats():
    """Métricas de la DB para GET /health (F4-P3)."""
    conn = _connect()
    with _lock:
        message_count = conn.execute("SELECT count(*) FROM messages").fetchone()[0]
        user_count = conn.execute(
            "SELECT count(*) FROM (SELECT 1 FROM messages GROUP BY bot_id, user_id)"
        ).fetchone()[0]
    try:
        size_bytes = os.path.getsize(DB_PATH)
    except OSError:
        size_bytes = 0
    return {
        "db_path": DB_PATH,
        "size_bytes": size_bytes,
        "messages": message_count,
        "chats": user_count,
        "window_hours": WINDOW_SECONDS // 3600,
        "max_messages": MAX_HISTORY_MESSAGES,
        "max_tokens": MAX_HISTORY_TOKENS,
    }
