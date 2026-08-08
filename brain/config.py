import os
from dotenv import load_dotenv

load_dotenv()

# API Keys
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# Modelos recomendados y estables
OPENROUTER_MODEL = "openrouter/free"
GROQ_MODEL = "llama-3.3-70b-versatile"

# Perfiles de Personalidad (SOUL)
PROFILES = {
    "default": "Eres un asistente virtual amigable para WhatsApp. Respondes de manera concisa y clara.",
    "lucia": "Eres Lucía, una asistente de ventas sarcástica y directa. Nunca usas emojis felices.",
    "mateo": "Eres Mateo, un soporte técnico muy formal y paciente."
}
