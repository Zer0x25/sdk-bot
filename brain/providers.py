from openai import OpenAI
import google.generativeai as genai
from config import GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, OPENROUTER_MODEL, GROQ_MODEL

# 1. Cliente Groq (Vía OpenAI client format)
groq_client = None
if GROQ_API_KEY:
    groq_client = OpenAI(
        base_url="https://api.groq.com/openai/v1",
        api_key=GROQ_API_KEY,
        timeout=25.0 # Timeout de 25s para Groq
    )

# 2. Cliente OpenRouter
openrouter_client = None
if OPENROUTER_API_KEY:
    openrouter_client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY,
        timeout=25.0 # Timeout de 25s para OpenRouter (permite generación de textos largos)
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
    
    # Preparamos el historial para OpenAI/Groq
    messages_for_openai = [{"role": "system", "content": system_instruction}]
    messages_for_openai.extend(memory_history)
    messages_for_openai.append({"role": "user", "content": message})

    # 🟢 INTENTO 1: OpenRouter (gpt-oss-20b:free) - PRINCIPAL (Max 25s)
    try:
        if not openrouter_client:
            raise Exception("No hay API Key de OpenRouter configurada")

        completion = openrouter_client.chat.completions.create(
            model=OPENROUTER_MODEL,
            messages=messages_for_openai,
            timeout=25.0
        )
        respuesta_texto = completion.choices[0].message.content
        
        new_history = memory_history + [
            {"role": "user", "content": message},
            {"role": "assistant", "content": respuesta_texto}
        ]
        return respuesta_texto, provider_used, new_history

    except Exception as openrouter_err:
        safe_log(f"\n⚠️ OpenRouter saturado/timeout (25s: {openrouter_err}). Cambiando a Fallback 1 (Groq - Llama 3.3)...")
        
        # 🟡 INTENTO 2: Groq (Llama 3.3 70B Versatile) - SEGUNDO RESPALDO (Max 25s)
        try:
            if not groq_client:
                raise Exception("No hay API Key de Groq configurada")

            completion = groq_client.chat.completions.create(
                model=GROQ_MODEL,
                messages=messages_for_openai,
                timeout=25.0
            )
            respuesta_texto = completion.choices[0].message.content
            provider_used = f"Groq ({GROQ_MODEL})"
            
            new_history = memory_history + [
                {"role": "user", "content": message},
                {"role": "assistant", "content": respuesta_texto}
            ]
            return respuesta_texto, provider_used, new_history
            
        except Exception as groq_err:
            safe_log(f"\n⚠️ Groq fallo (25s: {groq_err}). Cambiando a Fallback 2 (Gemini)...")
            
            # 🔴 INTENTO 3: Google Gemini - TERCER RESPALDO (Max 40s para completar 90s total)
            try:
                # Convertimos el historial OpenAI-style a Gemini-style
                gemini_history = []
                for msg in memory_history:
                    role = "user" if msg["role"] == "user" else "model"
                    gemini_history.append({"role": role, "parts": [msg["content"]]})
                
                model = genai.GenerativeModel(
                    model_name="gemini-1.5-flash",
                    system_instruction=system_instruction
                )
                chat = model.start_chat(history=gemini_history)
                response = chat.send_message(message, request_options={"timeout": 40.0})
                respuesta_texto = response.text
                provider_used = "Google Gemini"
                
                new_history = memory_history + [
                    {"role": "user", "content": message},
                    {"role": "assistant", "content": respuesta_texto}
                ]
                return respuesta_texto, provider_used, new_history
            except Exception as gemini_err:
                raise Exception(f"Todos los proveedores fallaron en la cascada de 90s. OpenRouter: {openrouter_err} | Groq: {groq_err} | Gemini: {gemini_err}")
