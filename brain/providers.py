from openai import OpenAI

from logging_setup import make_logger

# Gemini es un fallback opcional 3rd: en Termux (bionic) google-genai no tiene
# wheel precompilado y no se instala, así que lo importamos de forma defensiva.
try:
    from google import genai
    from google.genai import types
except ImportError:
    genai = None
    types = None
from config import (
    GEMINI_API_KEY,
    GROQ_API_KEY,
    GROQ_MODEL,
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL,
)

log = make_logger("brain.ai")

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

# 3. Cliente Gemini (solo si el módulo está disponible)
gemini_client = None
if genai is not None and GEMINI_API_KEY:
    gemini_client = genai.Client(api_key=GEMINI_API_KEY)

log = make_logger("brain.ai")


def safe_log(msg: str):
    try:
        log.info(msg)
    except Exception:
        pass

async def generate_ai_response(system_instruction: str, message: str, memory_history: list, user_id: str):
    respuesta_texto = None
    provider_used = f"Groq ({GROQ_MODEL})"
    
    # Preparamos el historial para OpenAI/Groq
    messages_for_openai = [{"role": "system", "content": system_instruction}]
    messages_for_openai.extend(memory_history)
    messages_for_openai.append({"role": "user", "content": message})

    # 🟢 INTENTO 1: Groq (Llama 3.3 70B Versatile) - PRINCIPAL (Max 25s)
    try:
        if not groq_client:
            raise Exception("No hay API Key de Groq configurada")

        completion = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages_for_openai,
            timeout=25.0
        )
        respuesta_texto = completion.choices[0].message.content
        
        new_history = [
            *memory_history,
            {"role": "user", "content": message},
            {"role": "assistant", "content": respuesta_texto}
        ]
        return respuesta_texto, provider_used, new_history

    except Exception as groq_err:
        safe_log(f"\n⚠️ Groq saturado/timeout (25s: {groq_err}). Cambiando a Fallback 1 (OpenRouter)...")
        
        # 🟡 INTENTO 2: OpenRouter (openrouter/free) - SEGUNDO RESPALDO (Max 25s)
        try:
            if not openrouter_client:
                raise Exception("No hay API Key de OpenRouter configurada")

            completion = openrouter_client.chat.completions.create(
                model=OPENROUTER_MODEL,
                messages=messages_for_openai,
                timeout=25.0
            )
            respuesta_texto = completion.choices[0].message.content
            provider_used = f"OpenRouter ({OPENROUTER_MODEL})"
            
            new_history = [
                *memory_history,
                {"role": "user", "content": message},
                {"role": "assistant", "content": respuesta_texto}
            ]
            return respuesta_texto, provider_used, new_history
            
        except Exception as openrouter_err:
            safe_log(f"\n⚠️ OpenRouter fallo (25s: {openrouter_err}). Cambiando a Fallback 2 (Gemini Flash Lite)...")
            
            # 🔴 INTENTO 3: Google Gemini Flash Lite - TERCER RESPALDO (Max 40s para completar 90s total)
            try:
                if not gemini_client:
                    raise Exception("No hay API Key de Gemini configurada")

                # Convertimos el historial OpenAI-style a Gemini-style
                gemini_history = []
                for msg in memory_history:
                    role = "user" if msg["role"] == "user" else "model"
                    gemini_history.append({"role": role, "parts": [{"text": msg["content"]}]})
                
                chat = gemini_client.chats.create(
                    model="gemini-flash-lite-latest",
                    config=types.GenerateContentConfig(
                        system_instruction=system_instruction,
                        http_options=types.HttpOptions(timeout=40000)
                    ),
                    history=gemini_history
                )
                response = chat.send_message(message)
                respuesta_texto = response.text
                provider_used = "Google Gemini Flash Lite"
                
                new_history = [
                    *memory_history,
                    {"role": "user", "content": message},
                    {"role": "assistant", "content": respuesta_texto}
                ]
                return respuesta_texto, provider_used, new_history
            except Exception as gemini_err:
                raise Exception(f"Todos los proveedores fallaron en la cascada de 90s. Groq: {groq_err} | OpenRouter: {openrouter_err} | Gemini: {gemini_err}") from None
