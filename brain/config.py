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
