import os

from dotenv import load_dotenv

# Carga brain/.env (secretos: API keys). load_dotenv no sobreescribe vars ya
# definidas en el entorno, así que respeta lo que el sistema ya tenga seteado.
load_dotenv()

# 🎛️ TUNING: carga .env.tuning (raíz del repo) SIN pisar brain/.env ni el entorno.
# Usamos override=False para que una var explícita en el sistema gane siempre.
# Así todas las constantes tunables viven en un solo archivo versionable, y las
# keys secretas siguen en brain/.env (gitignored).
_TUNING_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".env.tuning"
)
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
OPENROUTER_MODEL = "openrouter/free"
GROQ_MODEL = "llama-3.3-70b-versatile"

# 🧠 Memoria de conversación (brain/memory.py) — tunables vía .env.tuning
# Valores por defecto (se sobreescriben si están en .env.tuning):
#   WINDOW 24h, MAX_MESSAGES 15, MAX_TOKENS 2000, SWEEP cada 50 escrituras.
BRAIN_MEMORY_WINDOW_SECONDS = int(os.getenv("BRAIN_MEMORY_WINDOW_SECONDS", "86400"))
BRAIN_MEMORY_MAX_MESSAGES = int(os.getenv("BRAIN_MEMORY_MAX_MESSAGES", "15"))
BRAIN_MEMORY_MAX_TOKENS = int(os.getenv("BRAIN_MEMORY_MAX_TOKENS", "2000"))
BRAIN_MEMORY_GLOBAL_SWEEP_EVERY = int(os.getenv("BRAIN_MEMORY_GLOBAL_SWEEP_EVERY", "50"))
