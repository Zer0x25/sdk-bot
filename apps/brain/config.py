import os

from dotenv import load_dotenv

from runtime_paths import BRAIN_ENV_PATH, REPO_ROOT

# Carga brain/.env (secretos: API keys). load_dotenv no sobreescribe vars ya
# definidas en el entorno, así que respeta lo que el sistema ya tenga seteado.
load_dotenv(dotenv_path=BRAIN_ENV_PATH, override=False)

# 🎛️ TUNING: carga .env.tuning (raíz del repo) SIN pisar brain/.env ni el entorno.
# Usamos override=False para que una var explícita en el sistema gane siempre.
# Así todas las constantes tunables viven en un solo archivo versionable, y las
# keys secretas siguen en brain/.env (gitignored).
_TUNING_PATH = REPO_ROOT / ".env.tuning"
if os.path.exists(_TUNING_PATH):
    load_dotenv(dotenv_path=_TUNING_PATH, override=False)

# API Keys
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# Seguridad (Fase 2, S1): si se define BRAIN_API_KEY, el middleware exige el
# header X-API-Key en TODAS las rutas excepto /. El gateway la lee de este
# mismo .env, así que solo hay que pegarla una vez.
BRAIN_API_KEY = os.getenv("BRAIN_API_KEY", "")

# Host de escucha: por defecto SOLO local (el gateway vive en la misma máquina).
# Si algún día quieres el brain en otra máquina, pon BRAIN_HOST=0.0.0.0 + API key.
BRAIN_HOST = os.getenv("BRAIN_HOST", "127.0.0.1")

# Modelos recomendados y estables
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openrouter/free")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
# Primary por defecto del bot (tunable vía .env.tuning -> BRAIN_PRIMARY_MODEL).
# Gemini 3.1 Flash Lite: barato, rápido, buen español. Groq/OpenRouter quedan
# como respaldo en la cascada de providers.py.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
BRAIN_PRIMARY_MODEL = os.getenv("BRAIN_PRIMARY_MODEL", "gemini")

# Timeouts por proveedor (segundos). Antes hardcodeados en providers.py.
BRAIN_TIMEOUT_GROQ = float(os.getenv("BRAIN_TIMEOUT_GROQ", "25"))
BRAIN_TIMEOUT_OPENROUTER = float(os.getenv("BRAIN_TIMEOUT_OPENROUTER", "25"))
BRAIN_TIMEOUT_GEMINI = float(os.getenv("BRAIN_TIMEOUT_GEMINI", "40"))

# Ventana del rate-limit (segundos). Antes hardcodeada en 60.0 en main.py.
BRAIN_RATE_LIMIT_WINDOW = float(os.getenv("BRAIN_RATE_LIMIT_WINDOW", "60"))

# Muestreo / "voz" del bot (capa de humanización). 0 = sin tope de salida.
BRAIN_TEMPERATURE = float(os.getenv("BRAIN_TEMPERATURE", "0.7"))
BRAIN_TOP_P = float(os.getenv("BRAIN_TOP_P", "0.9"))
BRAIN_MAX_OUTPUT_TOKENS = int(os.getenv("BRAIN_MAX_OUTPUT_TOKENS", "0"))

# Estilo global de "imitación humana" inyectado en TODOS los perfiles (rol
# aparte). Reglas de voz consistentes sin repetirlas en cada .md. Tunable.
BRAIN_STYLE_GLOBAL = os.getenv(
    "BRAIN_STYLE_GLOBAL",
    "Hablar como un humano real por WhatsApp: mensajes cortos y cálidos, un solo "
    "emoji como mucho por globo, saltos de línea para separar ideas, y sin sonar "
    "robótico ni como manual de instrucciones. Responder en el idioma del cliente.",
)

# 🧠 Memoria de conversación (brain/memory.py) — tunables vía .env.tuning
# Valores por defecto (se sobreescriben si están en .env.tuning):
#   WINDOW 24h, MAX_MESSAGES 15, MAX_TOKENS 2000, SWEEP cada 50 escrituras.
BRAIN_MEMORY_WINDOW_SECONDS = int(os.getenv("BRAIN_MEMORY_WINDOW_SECONDS", "86400"))
BRAIN_MEMORY_MAX_MESSAGES = int(os.getenv("BRAIN_MEMORY_MAX_MESSAGES", "15"))
BRAIN_MEMORY_MAX_TOKENS = int(os.getenv("BRAIN_MEMORY_MAX_TOKENS", "2000"))
BRAIN_MEMORY_GLOBAL_SWEEP_EVERY = int(os.getenv("BRAIN_MEMORY_GLOBAL_SWEEP_EVERY", "50"))

# Respuestas durables para replay de GenerateReply. El Gateway conserva trabajos
# reintentables hasta 24 h; estos valores deben cubrir esa ventana.
BRAIN_GENERATION_RESPONSE_TTL_SECONDS = int(
    os.getenv("BRAIN_GENERATION_RESPONSE_TTL_SECONDS", str(7 * 24 * 60 * 60))
)
BRAIN_GENERATION_TOMBSTONE_TTL_SECONDS = int(
    os.getenv("BRAIN_GENERATION_TOMBSTONE_TTL_SECONDS", str(30 * 24 * 60 * 60))
)
BRAIN_GENERATION_MAX_RESPONSE_BYTES = int(
    os.getenv("BRAIN_GENERATION_MAX_RESPONSE_BYTES", str(64 * 1024))
)
BRAIN_GENERATION_MAX_RESPONSES = int(os.getenv("BRAIN_GENERATION_MAX_RESPONSES", "5000"))
BRAIN_GENERATION_RETENTION_SWEEP_SECONDS = int(
    os.getenv("BRAIN_GENERATION_RETENTION_SWEEP_SECONDS", "3600")
)

_MIN_GENERATION_REPLAY_TTL_SECONDS = 24 * 60 * 60
if BRAIN_GENERATION_RESPONSE_TTL_SECONDS < _MIN_GENERATION_REPLAY_TTL_SECONDS:
    raise ValueError("BRAIN_GENERATION_RESPONSE_TTL_SECONDS must cover the 24h replay window")
if BRAIN_GENERATION_TOMBSTONE_TTL_SECONDS < _MIN_GENERATION_REPLAY_TTL_SECONDS:
    raise ValueError("BRAIN_GENERATION_TOMBSTONE_TTL_SECONDS must cover the 24h replay window")
if min(
    BRAIN_GENERATION_MAX_RESPONSE_BYTES,
    BRAIN_GENERATION_MAX_RESPONSES,
    BRAIN_GENERATION_RETENTION_SWEEP_SECONDS,
) <= 0:
    raise ValueError("Brain generation retention limits must be positive")
