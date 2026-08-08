from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
from config import PROFILES, OPENROUTER_MODEL, GROQ_MODEL
from memory import get_history, update_history
from providers import generate_ai_response, safe_log

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
    bio: Optional[str] = None
    is_business: Optional[bool] = None

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    base_instruction = PROFILES.get(request.bot_profile, PROFILES["default"])
    
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
        "primary": f"OpenRouter ({OPENROUTER_MODEL})",
        "fallbacks": [GROQ_MODEL, "Gemini"]
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
