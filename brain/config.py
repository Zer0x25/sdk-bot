import os

from dotenv import load_dotenv

load_dotenv()

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
