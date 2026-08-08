from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
from config import OPENROUTER_MODEL, GROQ_MODEL
from memory import get_history, update_history, clear_history
from providers import generate_ai_response, safe_log
from profiles import (
    build_system_prompt, list_profiles, get_profiles, get_profile_file,
    import_profile, refresh_profiles
)

app = FastAPI(title="SDK-Bot Brain API (Modular Multi-Provider Router)")

class ChatRequest(BaseModel):
    user_id: str
    message: str
    bot_profile: str = "default"
    saved_name: Optional[str] = None
    push_name: Optional[str] = None
    user_name: Optional[str] = None
    phone_number: Optional[str] = None
    lid: Optional[str] = None
    country: Optional[str] = None
    language: Optional[str] = None
    bio: Optional[str] = None
    is_business: Optional[bool] = None

class ResetMemoryRequest(BaseModel):
    user_id: str

class ImportProfileRequest(BaseModel):
    key: str
    content: str

@app.post("/reset-memory")
async def reset_memory_endpoint(request: ResetMemoryRequest):
    cleared = clear_history(request.user_id)
    safe_log(f"🧹 [MEMORIA REINICIADA] Para usuario: {request.user_id} (Resultado: {cleared})")
    return {"status": "ok", "cleared": cleared, "user_id": request.user_id}

@app.get("/profiles")
def profiles_endpoint():
    return {"profiles": list_profiles()}

@app.get("/profiles/{profile_key}")
def profile_detail_endpoint(profile_key: str):
    if profile_key not in get_profiles():
        raise HTTPException(status_code=404, detail=f"Perfil '{profile_key}' no encontrado")
    return {
        "key": profile_key,
        "nombre": get_profiles()[profile_key][1]["nombre"],
        "descripcion": get_profiles()[profile_key][1]["descripcion"],
        "prompt": build_system_prompt(profile_key)
    }

@app.get("/profiles/{profile_key}/file")
def profile_file_endpoint(profile_key: str):
    """Exporta el .md crudo de un perfil para editar y re-subir."""
    content, filename = get_profile_file(profile_key)
    if content is None:
        raise HTTPException(status_code=404, detail=f"Perfil '{profile_key}' no encontrado")
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(content, media_type="text/markdown")

@app.post("/profiles/import")
def profile_import_endpoint(request: ImportProfileRequest):
    """Recibe un perfil .md editado (crea o actualiza el archivo en profiles/)."""
    result = import_profile(request.key, request.content)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    safe_log(f"📥 [PERFIL IMPORTADO] {result['key']} ({result['nombre']}) | {result['reglas']} reglas, {result['ejemplos']} ejemplos")
    return {"status": "ok", **result}

@app.post("/profiles/reload")
def profile_reload_endpoint():
    """Fuerza la recarga de la carpeta profiles/ (aunque ya es automática por mtime)."""
    refresh_profiles()
    return {"status": "ok", "profiles": len(get_profiles())}

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    base_instruction = build_system_prompt(request.bot_profile)
    
    # Enriquecer el prompt con metadatos del interlocutor
    user_info_parts = []
    
    if request.saved_name:
        user_info_parts.append(f"Nombre en Agenda del Admin: \"{request.saved_name}\"")
    if request.push_name and request.push_name != request.saved_name:
        user_info_parts.append(f"Nombre Público WhatsApp: \"{request.push_name}\"")
    elif not request.saved_name and request.user_name and request.user_name != "Desconocido":
        user_info_parts.append(f"Nombre: \"{request.user_name}\"")
        
    if request.country and request.country != "Desconocido":
        user_info_parts.append(f"Ubicación/País: {request.country}")

    if request.language:
        user_info_parts.append(f"Idioma Nativo del País de Origen: {request.language} (Si el usuario te escribe en su idioma nativo o si es oportuno, puedes responder u ofrecer continuar la atención en {request.language})")
        
    if request.bio:
        user_info_parts.append(f"Estado/Bio de WhatsApp: \"{request.bio}\"")
        
    if request.is_business:
        user_info_parts.append("Tipo de Cuenta: Empresa/Business")

    if user_info_parts:
        system_instruction = f"{base_instruction}\n[Contexto de la Persona en WhatsApp: {', '.join(user_info_parts)}]"
    else:
        system_instruction = base_instruction

    history = get_history(request.user_id)
    display_log_name = request.saved_name or request.push_name or request.user_name or 'Desconocido'
    safe_log(f"\n📩 [CEREBRO RECIBE] De: {display_log_name} ({request.user_id}) | Tel: {request.phone_number or 'N/A'} | LID: {request.lid or 'N/A'} | Bio: {request.bio or 'N/A'}")

    try:
        response_text, provider_used, updated_history = await generate_ai_response(
            system_instruction=system_instruction,
            message=request.message,
            memory_history=history,
            user_id=request.user_id
        )
        update_history(request.user_id, updated_history)
        safe_log(f"🤖 [{provider_used} RESPONDE A {display_log_name}]: {response_text}\n")
        return {"response": response_text, "provider": provider_used}
    except Exception as err:
        safe_log(f"❌ Error en router de proveedores: {err}")
        return {"error": str(err)}

@app.get("/")
def health_check():
    return {
        "status": "ok",
        "primary": f"Groq ({GROQ_MODEL})",
        "fallbacks": [f"OpenRouter ({OPENROUTER_MODEL})", "Gemini (gemini-flash-lite-latest)"]
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
