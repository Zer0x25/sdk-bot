import os

from dotenv import load_dotenv
from google import genai

from runtime_paths import BRAIN_ENV_PATH

load_dotenv(dotenv_path=BRAIN_ENV_PATH, override=False)
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

print("Modelos disponibles:")
for m in client.models.list():
    print(m.name)
