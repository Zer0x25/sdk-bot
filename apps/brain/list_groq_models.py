import os

from dotenv import load_dotenv
from openai import OpenAI

from runtime_paths import BRAIN_ENV_PATH

load_dotenv(dotenv_path=BRAIN_ENV_PATH, override=False)

client = OpenAI(
    base_url="https://api.groq.com/openai/v1",
    api_key=os.getenv("GROQ_API_KEY")
)

try:
    models = client.models.list()
    print("Modelos disponibles en Groq:")
    for m in models.data:
        print(f"- {m.id}")
except Exception as e:
    print(f"Error al listar modelos de Groq: {e}")
