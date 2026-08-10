import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

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
