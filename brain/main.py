import atexit
import os
import secrets
import signal
import socket
import sys
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from config import (
    BRAIN_API_KEY,
    BRAIN_HOST,
    BRAIN_PRIMARY_MODEL,
    BRAIN_RATE_LIMIT_WINDOW,
    GEMINI_MODEL,
    GROQ_MODEL,
    OPENROUTER_MODEL,
)
from logging_setup import make_logger
from memory import append_exchange, clear_history, get_db_stats, get_history
from profiles import (
    build_system_prompt,
    delete_profile,
    get_profile_file,
    get_profiles,
    import_profile,
    list_profiles,
    refresh_profiles,
)
from providers import generate_ai_response, safe_log

START_TIME = time.time()

app = FastAPI(title="SDK-Bot Brain API (Modular Multi-Provider Router)")

# 🔐 S1 — Autenticación opcional por API key (header X-API-Key).
# Si BRAIN_API_KEY está definida en .env, toda ruta excepto la salud
# ("/", "/health") exige el header. La comparación es en tiempo constante.
@app.middleware("http")
async def require_api_key(request: Request, call_next):
    if BRAIN_API_KEY and request.url.path not in ("/", "/health", "/history"):
        provided = request.headers.get("X-API-Key", "")
        if not secrets.compare_digest(provided, BRAIN_API_KEY):
            return JSONResponse(status_code=401, content={"detail": "API key inválida o faltante"})
    return await call_next(request)

class ChatRequest(BaseModel):
    user_id: str
    message: str
    bot_profile: str = "default"
    saved_name: str | None = None
    push_name: str | None = None
    user_name: str | None = None
    phone_number: str | None = None
    lid: str | None = None
    country: str | None = None
    language: str | None = None
    bio: str | None = None
    is_business: bool | None = None
    bot_id: str | None = None  # F4-P2: aislamiento de memoria por bot (default 'single')

class ResetMemoryRequest(BaseModel):
    user_id: str
    bot_id: str | None = None

class ImportProfileRequest(BaseModel):
    key: str
    content: str

@app.post("/reset-memory")
async def reset_memory_endpoint(request: ResetMemoryRequest):
    bot_id = request.bot_id or "single"
    cleared = clear_history(bot_id, request.user_id)
    safe_log(f"🧹 [MEMORIA REINICIADA] Para usuario: {request.user_id} (Resultado: {cleared})")
    return {"status": "ok", "cleared": cleared, "user_id": request.user_id}

@app.get("/profiles")
def profiles_endpoint():
    return {"profiles": list_profiles()}

@app.get("/profiles/{profile_key}")
def profile_detail_endpoint(profile_key: str):
    if profile_key not in get_profiles():
        raise HTTPException(status_code=404, detail=f"Perfil '{profile_key}' no encontrado")
    return {
        "key": profile_key,
        "nombre": get_profiles()[profile_key][1]["nombre"],
        "descripcion": get_profiles()[profile_key][1]["descripcion"],
        "prompt": build_system_prompt(profile_key)
    }

@app.get("/profiles/{profile_key}/file")
def profile_file_endpoint(profile_key: str):
    """Exporta el .md crudo de un perfil para editar y re-subir."""
    content, _filename = get_profile_file(profile_key)
    if content is None:
        raise HTTPException(status_code=404, detail=f"Perfil '{profile_key}' no encontrado")
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(content, media_type="text/markdown")

@app.post("/profiles/import")
def profile_import_endpoint(request: ImportProfileRequest):
    """Recibe un perfil .md editado (crea o actualiza el archivo en profiles/)."""
    result = import_profile(request.key, request.content)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    safe_log(f"📥 [PERFIL IMPORTADO] {result['key']} ({result['nombre']}) | {result['reglas']} reglas, {result['ejemplos']} ejemplos")
    return {"status": "ok", **result}

@app.post("/profiles/reload")
def profile_reload_endpoint():
    """Fuerza la recarga de la carpeta profiles/ (aunque ya es automática por mtime)."""
    refresh_profiles()
    return {"status": "ok", "profiles": len(get_profiles())}

@app.delete("/profiles/{profile_key}")
def profile_delete_endpoint(profile_key: str):
    """Elimina el .md de un perfil (default está protegido)."""
    result = delete_profile(profile_key)
    if not result["success"]:
        status = 400 if result["message"].startswith(("Clave", "'default'")) else 404
        raise HTTPException(status_code=status, detail=result["message"])
    safe_log(f"🗑️ [PERFIL ELIMINADO] {result['key']}")
    return {"status": "ok", **result}

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    if RATE_LIMIT_ENABLED and _is_rate_limited(request.user_id):
        safe_log(f"⏱️ [RATE LIMIT] {request.user_id} excedió {RATE_LIMIT_MAX} llamadas/min")
        raise HTTPException(status_code=429, detail="Demasiados mensajes por minuto. Espera unos segundos.")

    base_instruction = build_system_prompt(request.bot_profile)
    
    # Enriquecer el prompt con metadatos del interlocutor
    user_info_parts = []
    
    if request.saved_name:
        user_info_parts.append(f"Nombre en Agenda del Admin: \"{request.saved_name}\"")
    if request.push_name and request.push_name != request.saved_name:
        user_info_parts.append(f"Nombre Público WhatsApp: \"{request.push_name}\"")
    elif not request.saved_name and request.user_name and request.user_name != "Desconocido":
        user_info_parts.append(f"Nombre: \"{request.user_name}\"")
        
    if request.country and request.country != "Desconocido":
        user_info_parts.append(f"Ubicación/País: {request.country}")

    if request.language:
        user_info_parts.append(f"Idioma Nativo del País de Origen: {request.language} (Si el usuario te escribe en su idioma nativo o si es oportuno, puedes responder u ofrecer continuar la atención en {request.language})")
        
    if request.bio:
        user_info_parts.append(f"Estado/Bio de WhatsApp: \"{request.bio}\"")
        
    if request.is_business:
        user_info_parts.append("Tipo de Cuenta: Empresa/Business")

    if user_info_parts:
        system_instruction = f"{base_instruction}\n[Contexto de la Persona en WhatsApp: {', '.join(user_info_parts)}]"
    else:
        system_instruction = base_instruction

    bot_id = request.bot_id or "single"
    # /chat SIEMPRE usa el contexto completo (ventana global 7d / 5000 tok) para
    # generar la respuesta. La precarga en presencia es SOLO señal de intervención
    # (etapa 1) y NO se inyecta aquí (etapa 2 = respuesta con contexto total).
    history = get_history(bot_id, request.user_id)
    display_log_name = request.saved_name or request.push_name or request.user_name or 'Desconocido'
    safe_log(f"\n📩 [CEREBRO RECIBE] De: {display_log_name} ({request.user_id}) | Tel: {request.phone_number or 'N/A'} | LID: {request.lid or 'N/A'} | Bio: {request.bio or 'N/A'}")

    try:
        response_text, provider_used, _updated_history = await generate_ai_response(
            system_instruction=system_instruction,
            message=request.message,
            memory_history=history,
            user_id=request.user_id
        )
        append_exchange(bot_id, request.user_id, request.message, response_text)
        safe_log(f"🤖 [{provider_used} RESPONDE A {display_log_name}]: {response_text}\n")
        return {"response": response_text, "provider": provider_used}
    except Exception as err:
        safe_log(f"❌ Error en router de proveedores: {err}")
        return {"error": str(err)}

@app.get("/history")
def history_endpoint(user_id: str, bot_id: str | None = None,
                     max_messages: int = 0, max_tokens: int = 0):
    """Devuelve el contexto de memoria de un chat (sin generar respuesta).
    Usado por la precarga del gateway en eventos de presencia (F-preload, etapa 1).
    max_messages / max_tokens acotan el resultado a una "primera página" web-like;
    si valen 0 se usan los límites globales."""
    bid = bot_id or "single"
    return {"user_id": user_id, "bot_id": bid, "history": get_history(bid, user_id, max_messages, max_tokens)}


@app.get("/")
def health_check():
    return {
        "status": "ok",
        "primary": f"Gemini ({GEMINI_MODEL})" if (BRAIN_PRIMARY_MODEL or "gemini").lower() == "gemini" else f"Groq ({GROQ_MODEL})",
        "fallbacks": [f"Groq ({GROQ_MODEL})", f"OpenRouter ({OPENROUTER_MODEL})"]
    }

@app.get("/health")
def health_endpoint():
    """Salud y métricas para la futura dashboard (F4-P3). Sin API key."""
    return {
        "status": "ok",
        "uptime_seconds": round(time.time() - START_TIME),
        "providers": {
            "primary": f"Gemini ({GEMINI_MODEL})" if (BRAIN_PRIMARY_MODEL or "gemini").lower() == "gemini" else f"Groq ({GROQ_MODEL})",
            "fallbacks": [f"Groq ({GROQ_MODEL})", f"OpenRouter ({OPENROUTER_MODEL})"],
        },
        "rate_limit": {
            "enabled": RATE_LIMIT_ENABLED,
            "max_per_min": RATE_LIMIT_MAX,
            "users_tracked": len(_rate_hits),
        },
        "memory": get_db_stats(),
    }


# -------------------------------------------------------------
# ⏱️ S2 — Rate limit por user_id en /chat (ventana deslizante, tunable)
RATE_LIMIT_ENABLED = os.getenv("BRAIN_RATE_LIMIT_ENABLED", "1") == "1"
RATE_LIMIT_MAX = int(os.getenv("BRAIN_RATE_LIMIT_PER_MIN", "10"))
RATE_LIMIT_WINDOW = BRAIN_RATE_LIMIT_WINDOW
_rate_hits = {}  # user_id -> [timestamps]

def _is_rate_limited(user_id: str) -> bool:
    now = time.time()
    # Podar si la tabla crece demasiado (memoria contenida)
    if len(_rate_hits) > 5000:
        for key in list(_rate_hits):
            _rate_hits[key] = [t for t in _rate_hits[key] if now - t < RATE_LIMIT_WINDOW]
            if not _rate_hits[key]:
                del _rate_hits[key]
    arr = [t for t in _rate_hits.get(user_id, []) if now - t < RATE_LIMIT_WINDOW]
    if len(arr) >= RATE_LIMIT_MAX:
        _rate_hits[user_id] = arr
        return True
    arr.append(now)
    _rate_hits[user_id] = arr
    return False


# -------------------------------------------------------------
# 🔒 INSTANCIA ÚNICA (evita "address already in use" confuso)
# - Si ya hay un Brain corriendo (lock + PID vivo), avisa y sale.
# - Uso: `python main.py --restart` cierra el Brain anterior y arranca uno nuevo.
# -------------------------------------------------------------
log_instancia = make_logger("brain.instancia")

BRAIN_PORT = int(os.getenv("BRAIN_PORT", "5100"))
BRAIN_LOCK_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".brain.lock")


def _is_pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _port_in_use(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("0.0.0.0", port))
            return False
    except OSError:
        return True


def _read_lock():
    try:
        with open(BRAIN_LOCK_FILE, encoding="utf-8") as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def _remove_lock():
    try:
        if _read_lock() == os.getpid():
            os.remove(BRAIN_LOCK_FILE)
    except OSError:
        pass


def ensure_singleton(allow_restart=False):
    existing = _read_lock()
    if existing and _is_pid_alive(existing):
        if existing == os.getpid():
            # El lock apunta a ESTE mismo proceso. Ocurre en contenedores donde el
            # servicio corre siempre como PID 1 y, al reiniciar el contenedor
            # (restart: unless-stopped), el lock persiste en su capa escribible.
            # No es otra instancia: limpiamos y continuamos (evita el crash-loop).
            log_instancia.info(f"[info] Lock apunta a este mismo proceso (PID {existing}). Ignorando y continuando.")
            try:
                os.remove(BRAIN_LOCK_FILE)
            except OSError:
                pass
        elif allow_restart:
            log_instancia.info(f"[restart] Brain anterior detectado (PID {existing}). Cerrando y reiniciando...")
            try:
                os.kill(existing, signal.SIGTERM)
                for _ in range(20):
                    if not _is_pid_alive(existing):
                        break
                    time.sleep(0.25)
            except Exception as e:
                log_instancia.error(f"⚠️ No pude detener la instancia anterior ({e}).")
        else:
            log_instancia.info(f"🔒 El Brain YA está corriendo (PID {existing}). Revisa: `ss -tlnp | grep {BRAIN_PORT}`")
            log_instancia.info("   → Para reiniciarlo sin tocar nada: `python main.py --restart`")
            sys.exit(1)
    elif existing:
        log_instancia.info(f"🧹 Lock huérfano detectado (PID {existing} ya no existe). Limpiando...")
        try:
            os.remove(BRAIN_LOCK_FILE)
        except OSError:
            pass

    if _port_in_use(BRAIN_PORT):
        log_instancia.info(f"🔒 El puerto {BRAIN_PORT} ya está ocupado por otro proceso.")
        log_instancia.info("   → Si es un Brain: `python main.py --restart`. Si es otro programa, libéralo primero.")
        sys.exit(1)

    _write_lock()

    # 🧹 Limpieza del lock en cualquier salida normal (finally), en salida
    # excepcional (atexit) y ante señales (SIGTERM/SIGINT).
    atexit.register(_remove_lock)


def _handle_shutdown_signal(sig, frame):
    # uvicorn, al cerrar, RE-EMITE la señal capturada con el handler original
    # restaurado. Si dejamos el default (SIG_DFL), el proceso muere al instante
    # sin ejecutar finally/atexit. Con nuestro handler limpiamos el lock y
    # salimos de forma ordenada.
    _remove_lock()
    sys.exit(0)


def _write_lock():
    try:
        with open(BRAIN_LOCK_FILE, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass


if __name__ == "__main__":
    import uvicorn

    # Nuestro handler de señal debe estar registrado ANTES de uvicorn.run():
    # uvicorn guarda y restaura los handlers originales al capturar señales.
    signal.signal(signal.SIGTERM, _handle_shutdown_signal)
    signal.signal(signal.SIGINT, _handle_shutdown_signal)

    ensure_singleton(allow_restart="--restart" in sys.argv)
    try:
        uvicorn.run(app, host=BRAIN_HOST, port=BRAIN_PORT)
    finally:
        # uvicorn no garantiza el retorno normal: limpiar el lock si llegamos aquí
        _remove_lock()
