import os
import requests
from dotenv import load_dotenv

load_dotenv()

headers = {
    "Authorization": f"Bearer {os.getenv('OPENROUTER_API_KEY')}"
}

try:
    response = requests.get("https://openrouter.ai/api/v1/models", headers=headers)
    data = response.json()
    free_models = [m['id'] for m in data.get('data', []) if m['id'].endswith(':free') or ':free' in m['id']]
    print("Modelos GRATUITOS en OpenRouter:")
    for m in free_models:
        print(f"- {m}")
except Exception as e:
    print(f"Error al listar modelos de OpenRouter: {e}")
