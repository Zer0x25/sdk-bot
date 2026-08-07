import os
from fastapi import FastAPI
from pydantic import BaseModel
import google.generativeai as genai
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

# 1. Cliente Groq (Vía OpenAI client format)
groq_key = os.getenv("GROQ_API_KEY")
groq_client = None
if groq_key:
    groq_client = OpenAI(
        base_url="https://api.groq.com/openai/v1",
        api_key=groq_key,
    )

# 2. Cliente OpenRouter
openrouter_key = os.getenv("OPENROUTER_API_KEY")
openrouter_client = None
if openrouter_key:
    openrouter_client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=openrouter_key,
    )

# 3. Cliente Gemini
gemini_key = os.getenv("GEMINI_API_KEY")
if gemini_key:
    genai.configure(api_key=gemini_key)

app = FastAPI(title="SDK-Bot Brain API (Stable Free Router)")

class ChatRequest(BaseModel):
    user_id: str
    message: str
    bot_profile: str = "default"

PROFILES = {
    "default": "Eres un asistente virtual amigable para WhatsApp. Respondes de manera concisa y clara.",
    "lucia": "Eres Lucía, una asistente de ventas sarcástica y directa. Nunca usas emojis felices.",
    "mateo": "Eres Mateo, un soporte técnico muy formal y paciente."
}

memory_db = {}

# Modelos recomendados y estables
OPENROUTER_MODEL = "openai/gpt-oss-20b:free"
GROQ_MODEL = "llama-3.3-70b-versatile"

def safe_log(msg: str):
    try:
        print(msg, flush=True)
    except Exception:
        pass

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    system_instruction = PROFILES.get(request.bot_profile, PROFILES["default"])
    
    if request.user_id not in memory_db:
        memory_db[request.user_id] = []
        
    respuesta_texto = None
    provider_used = f"OpenRouter ({OPENROUTER_MODEL})"

    # 🟢 INTENTO 1: OpenRouter (gpt-oss-20b:free) - PRINCIPAL
    try:
        if not openrouter_client:
            raise Exception("No hay API Key de OpenRouter configurada")

        messages = [{"role": "system", "content": system_instruction}]
        messages.append({"role": "user", "content": request.message})

        completion = openrouter_client.chat.completions.create(
            model=OPENROUTER_MODEL,
            messages=messages
        )
        respuesta_texto = completion.choices[0].message.content

    except Exception as openrouter_err:
        safe_log(f"\nOpenRouter saturado/fallo ({openrouter_err}). Cambiando a Fallback 1 (Groq - Llama 3.3)...")
        
        # 🟡 INTENTO 2: Groq (Llama 3.3 70B Versatile) - SEGUNDO RESPALDO
        try:
            if not groq_client:
                raise Exception("No hay API Key de Groq configurada")

            messages = [{"role": "system", "content": system_instruction}]
            messages.append({"role": "user", "content": request.message})

            completion = groq_client.chat.completions.create(
                model=GROQ_MODEL,
                messages=messages
            )
            respuesta_texto = completion.choices[0].message.content
            provider_used = f"Groq ({GROQ_MODEL})"
            
        except Exception as groq_err:
            safe_log(f"\nGroq fallo ({groq_err}). Cambiando a Fallback 2 (Gemini)...")
            
            # 🔴 INTENTO 3: Google Gemini - TERCER RESPALDO
            try:
                model = genai.GenerativeModel(
                    model_name="gemini-flash-latest",
                    system_instruction=system_instruction
                )
                chat = model.start_chat(history=memory_db[request.user_id])
                response = chat.send_message(request.message)
                respuesta_texto = response.text
                memory_db[request.user_id] = chat.history
                provider_used = "Google Gemini"
            except Exception as gemini_err:
                return {"error": f"Todos los proveedores fallaron. OpenRouter: {openrouter_err} | Groq: {groq_err} | Gemini: {gemini_err}"}

    # Imprimir log de respuesta en consola
    safe_log(f"\n[{provider_used} RESPONDE A {request.user_id}]: {respuesta_texto}\n")

    return {"response": respuesta_texto, "provider": provider_used}

@app.get("/")
def health_check():
    return {
        "status": "ok",
        "primary": f"OpenRouter ({OPENROUTER_MODEL})",
        "fallbacks": [GROQ_MODEL, "Gemini"]
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
