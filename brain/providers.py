from openai import OpenAI
import google.generativeai as genai
from config import GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, OPENROUTER_MODEL, GROQ_MODEL

# 1. Cliente Groq (Vía OpenAI client format)
groq_client = None
if GROQ_API_KEY:
    groq_client = OpenAI(
        base_url="https://api.groq.com/openai/v1",
        api_key=GROQ_API_KEY,
    )

# 2. Cliente OpenRouter
openrouter_client = None
if OPENROUTER_API_KEY:
    openrouter_client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY,
    )

# 3. Cliente Gemini
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

def safe_log(msg: str):
    try:
        print(msg, flush=True)
    except Exception:
        pass

async def generate_ai_response(system_instruction: str, message: str, memory_history: list, user_id: str):
    respuesta_texto = None
    provider_used = f"OpenRouter ({OPENROUTER_MODEL})"

    # 🟢 INTENTO 1: OpenRouter (gpt-oss-20b:free) - PRINCIPAL
    try:
        if not openrouter_client:
            raise Exception("No hay API Key de OpenRouter configurada")

        messages = [{"role": "system", "content": system_instruction}]
        messages.append({"role": "user", "content": message})

        completion = openrouter_client.chat.completions.create(
            model=OPENROUTER_MODEL,
            messages=messages
        )
        respuesta_texto = completion.choices[0].message.content
        return respuesta_texto, provider_used, memory_history

    except Exception as openrouter_err:
        safe_log(f"\nOpenRouter saturado/fallo ({openrouter_err}). Cambiando a Fallback 1 (Groq - Llama 3.3)...")
        
        # 🟡 INTENTO 2: Groq (Llama 3.3 70B Versatile) - SEGUNDO RESPALDO
        try:
            if not groq_client:
                raise Exception("No hay API Key de Groq configurada")

            messages = [{"role": "system", "content": system_instruction}]
            messages.append({"role": "user", "content": message})

            completion = groq_client.chat.completions.create(
                model=GROQ_MODEL,
                messages=messages
            )
            respuesta_texto = completion.choices[0].message.content
            provider_used = f"Groq ({GROQ_MODEL})"
            return respuesta_texto, provider_used, memory_history
            
        except Exception as groq_err:
            safe_log(f"\nGroq fallo ({groq_err}). Cambiando a Fallback 2 (Gemini)...")
            
            # 🔴 INTENTO 3: Google Gemini - TERCER RESPALDO
            try:
                model = genai.GenerativeModel(
                    model_name="gemini-flash-latest",
                    system_instruction=system_instruction
                )
                chat = model.start_chat(history=memory_history)
                response = chat.send_message(message)
                respuesta_texto = response.text
                provider_used = "Google Gemini"
                return respuesta_texto, provider_used, chat.history
            except Exception as gemini_err:
                raise Exception(f"Todos los proveedores fallaron. OpenRouter: {openrouter_err} | Groq: {groq_err} | Gemini: {gemini_err}")
