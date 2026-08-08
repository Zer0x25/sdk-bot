# AGENTS.md

Plataforma WhatsApp multi-bot: `gateway/` (Node.js + Baileys) + `brain/` (Python FastAPI). No hay CI, lint ni tests (`npm test` es placeholder).

## Arranque (orden importa)

1. Brain primero: `cd brain; venv\Scripts\python.exe main.py` → FastAPI en `0.0.0.0:8000`
2. Gateway: `cd gateway; npm start` (o `node index.js`)

## Arquitectura

- `gateway/index.js` — entrada Baileys (syncFullHistory, presenceSubscribe). El admin se detecta solo (`state.ADMIN_PHONE/LID`).
- `gateway/services/storageService.js` — persistencia `contacts_db.json` + `settings_db.json` con debounce 2s y flush en SIGINT/SIGTERM.
- `gateway/services/metadataService.js` — país/idioma por prefijo, TTL 24h foto/bio, resuelve Phone y LID dual.
- `gateway/services/brainService.js` — cliente REST del brain + simulación humana (typing/multi-bubble ~220 chars).
- `gateway/handlers/messageHandler.js` — pipeline, de-bounce estocástico (5s-12s, 1-2m al 12%, 3-4m al 5%), handoff.
- `brain/main.py` — endpoints `POST /chat`, `POST /reset-memory`, `GET /profiles`, `GET /profiles/{key}` (prompt compilado).
- `brain/providers.py` — cascada real: **Groq → OpenRouter → Gemini** (25s/25s/40s, 90s total). README/PLAN están desactualizados; confiar en el código.
- `brain/config.py` — modelos `llama-3.3-70b-versatile`, `openrouter/free`; Gemini `gemini-flash-lite-latest` hardcodeado en providers.py.
- `brain/profiles.py` — perfiles SOUL estructurados (`default`, `lucia`, `mateo`, `ventas`, `cobranzas`, `recepcion`): nombre, personalidad, reglas, formato y ejemplos. `build_system_prompt()` compila cada perfil a un system prompt; `list_profiles()` alimenta `GET /profiles`.
- Perfil por contacto: campo `perfil` en cada registro de `contacts_db.json` (opcional). El brain recibe `metadata.perfil || state.CURRENT_PROFILE`; el global se persiste en `settings_db.json` como `currentProfile`.

## Gotchas

- El brain debe estar corriendo o el gateway envía alerta al self-chat (nunca al cliente).
- Memoria del brain es solo RAM (15 msgs); reiniciar `brain` borra conversaciones. `/limpiar` llama a `/reset-memory`.
- `brain/.env` (gitignored, sin `.example`): `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`.
- Estado por contacto: `estado` (`neutro`/`permitido`/`ignorado`/`handoff`) + `globalMode` (`allowed_all`/`ignored_all`) en `settings_db.json`.
- `settings_db.json` e `ignored_numbers.json` están versionados; `contacts_db.json`/`allowed_numbers.json` no. `allowed_numbers.json`/`ignored_numbers.json` son legado (obsoletos).
- Comandos admin solo en self-chat (mensaje a ti mismo); texto normal ahí = asistente IA. `/` de clientes = bloqueado (seguridad).
- Responder/citar un mensaje con un comando extrae automáticamente el teléfono o LID.
- `/perfil` valida contra `GET /profiles` (brain encendido); con brain apagado lista vacía y rechaza cambios. Soporta: `/perfil <key>` (global), `/perfil <key> <num>` o citar con `/perfil <key>` (por contacto), `/perfil ver <key>` (prompt compilado).
- `settings_db.json` guarda `globalMode` y `currentProfile`; `state.CURRENT_PROFILE` se recarga desde ahí al arrancar.
- Verificar cambios: arrancar brain + gateway manualmente (no hay tests).
- Código, logs y comentarios en español.
