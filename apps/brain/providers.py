import asyncio

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
    BRAIN_MAX_OUTPUT_TOKENS,
    BRAIN_PRIMARY_MODEL,
    BRAIN_TEMPERATURE,
    BRAIN_TIMEOUT_GEMINI,
    BRAIN_TIMEOUT_GROQ,
    BRAIN_TIMEOUT_OPENROUTER,
    BRAIN_TOP_P,
    GEMINI_API_KEY,
    GEMINI_MODEL,
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
        timeout=BRAIN_TIMEOUT_GROQ,
    )

# 2. Cliente OpenRouter
openrouter_client = None
if OPENROUTER_API_KEY:
    openrouter_client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY,
        timeout=BRAIN_TIMEOUT_OPENROUTER,
    )

# 3. Cliente Gemini (solo si el módulo está disponible)
gemini_client = None
if genai is not None and GEMINI_API_KEY:
    gemini_client = genai.Client(api_key=GEMINI_API_KEY)

log = make_logger("brain.ai")


def _call_groq(messages_for_openai):
    if not groq_client:
        raise Exception("No hay API Key de Groq configurada")
    completion = groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=messages_for_openai,
        temperature=BRAIN_TEMPERATURE,
        top_p=BRAIN_TOP_P,
        timeout=BRAIN_TIMEOUT_GROQ,
        **({"max_tokens": BRAIN_MAX_OUTPUT_TOKENS} if BRAIN_MAX_OUTPUT_TOKENS > 0 else {}),
    )
    return completion.choices[0].message.content


def _call_openrouter(messages_for_openai):
    if not openrouter_client:
        raise Exception("No hay API Key de OpenRouter configurada")
    completion = openrouter_client.chat.completions.create(
        model=OPENROUTER_MODEL,
        messages=messages_for_openai,
        temperature=BRAIN_TEMPERATURE,
        top_p=BRAIN_TOP_P,
        timeout=BRAIN_TIMEOUT_OPENROUTER,
        **({"max_tokens": BRAIN_MAX_OUTPUT_TOKENS} if BRAIN_MAX_OUTPUT_TOKENS > 0 else {}),
    )
    return completion.choices[0].message.content


def _call_gemini(system_instruction, message, memory_history):
    if not gemini_client:
        raise Exception("No hay API Key de Gemini configurada")
    gemini_history = []
    for msg in memory_history:
        role = "user" if msg["role"] == "user" else "model"
        gemini_history.append({"role": role, "parts": [{"text": msg["content"]}]})
    chat = gemini_client.chats.create(
        model=GEMINI_MODEL,
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=BRAIN_TEMPERATURE,
            top_p=BRAIN_TOP_P,
            **({"max_output_tokens": BRAIN_MAX_OUTPUT_TOKENS} if BRAIN_MAX_OUTPUT_TOKENS > 0 else {}),
            http_options=types.HttpOptions(timeout=int(BRAIN_TIMEOUT_GEMINI * 1000)),
        ),
        history=gemini_history,
    )
    response = chat.send_message(message)
    return response.text


def safe_log(msg: str):
    try:
        log.info(msg)
    except Exception:
        pass


async def generate_ai_response(system_instruction: str, message: str, memory_history: list, user_id: str):
    respuesta_texto = None

    # Preparamos el historial para OpenAI/Groq
    messages_for_openai = [{"role": "system", "content": system_instruction}]
    messages_for_openai.extend(memory_history)
    messages_for_openai.append({"role": "user", "content": message})

    # Orden de la cascada. El primary por defecto es Gemini (barato/rápido, buen
    # español); Groq y OpenRouter quedan como respaldo. Se puede sobreescribir
    # con BRAIN_PRIMARY_MODEL=groq|openrouter|gemini en .env.tuning.
    primary = (BRAIN_PRIMARY_MODEL or "gemini").lower()
    if primary == "groq":
        order = [("Groq", lambda: _call_groq(messages_for_openai), lambda: GROQ_MODEL),
                 ("OpenRouter", lambda: _call_openrouter(messages_for_openai), lambda: OPENROUTER_MODEL),
                 ("Gemini", lambda: _call_gemini(system_instruction, message, memory_history), lambda: GEMINI_MODEL)]
    elif primary == "openrouter":
        order = [("OpenRouter", lambda: _call_openrouter(messages_for_openai), lambda: OPENROUTER_MODEL),
                 ("Groq", lambda: _call_groq(messages_for_openai), lambda: GROQ_MODEL),
                 ("Gemini", lambda: _call_gemini(system_instruction, message, memory_history), lambda: GEMINI_MODEL)]
    else:  # gemini (default)
        order = [("Gemini", lambda: _call_gemini(system_instruction, message, memory_history), lambda: GEMINI_MODEL),
                 ("Groq", lambda: _call_groq(messages_for_openai), lambda: GROQ_MODEL),
                 ("OpenRouter", lambda: _call_openrouter(messages_for_openai), lambda: OPENROUTER_MODEL)]

    errors = []
    for name, fn, model_label in order:
        try:
            respuesta_texto = await asyncio.to_thread(fn)
            provider_used = f"{name} ({model_label()})"
            new_history = [
                *memory_history,
                {"role": "user", "content": message},
                {"role": "assistant", "content": respuesta_texto},
            ]
            return respuesta_texto, provider_used, new_history
        except Exception as err:
            errors.append(f"{name}: {err}")
            safe_log(f"\n⚠️ {name} falló ({type(err).__name__}). Probando siguiente proveedor...")

    raise Exception(
        "Todos los proveedores fallaron en la cascada. "
        + " | ".join(errors)
    ) from None
