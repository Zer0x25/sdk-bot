# AGENTS.md

Plataforma WhatsApp multi-bot: `gateway/` (Node.js + Baileys) + `brain/` (Python FastAPI). No hay CI, lint ni tests (`npm test` es placeholder).

## Arranque (orden importa)

1. Brain primero: `cd brain; python main.py` (venv: `venv/bin/python` Linux / `venv\Scripts\python.exe` Windows) → FastAPI en `0.0.0.0:8000`. El puerto es fijo: `gateway/config.js` tiene `BRAIN_API_URL` hardcodeado a `http://127.0.0.1:8000/chat`.
2. Gateway: `cd gateway; npm start` (o `node index.js`).
3. QR nuevo / re-sincronizar libreta: `cd gateway; npm run reset` (borra `auth_info_baileys/` tras confirmar y lanza index.js).

Setup primera vez (Linux Debian/Ubuntu): `sudo apt install python3-venv` → `cd brain; python3 -m venv venv && venv/bin/pip install -r requirements.txt`. Windows: `python -m venv venv && venv\Scripts\pip install -r requirements.txt`.

## Arquitectura

- `gateway/index.js` — entrada Baileys (`syncFullHistory: true`, `presenceSubscribe`, `markOnlineOnConnect`). El admin se detecta solo (`state.ADMIN_PHONE/LID`).
- `gateway/config.js` — `state` global (`CURRENT_PROFILE`, `GLOBAL_MODE`, `IS_BOT_PAUSED`) + registro anti-bucle `botSentMessageIds` (expira a los 60s).
- `gateway/services/storageService.js` — persistencia `contacts_db.json` (write atómico tmp+rename) + `settings_db.json` con debounce 2s y flush en SIGINT/SIGTERM.
- `gateway/services/metadataService.js` — país/idioma por prefijo (América + Europa), TTL 24h foto/bio, resuelve Phone y LID dual.
- `gateway/services/brainService.js` — cliente REST del brain (timeout global 90s) + simulación humana (typing 7-10 char/s, multi-bubble ~220 chars).
- `gateway/handlers/messageHandler.js` — pipeline, de-bounce estocástico (5-7s corto, 7.5-12s largo/múltiple; 12% → 1-2m; 5% → 3-4m), TTL de tecleo 5s, handoff por palabras clave.
- `gateway/handlers/commandHandler.js` — comandos admin del self-chat; citar un mensaje extrae teléfono/LID automáticamente.
- `brain/main.py` — endpoints `POST /chat`, `POST /reset-memory`, `GET /profiles`, `GET /profiles/{key}` (prompt compilado), `GET /profiles/{key}/file`, `POST /profiles/import`, `POST /profiles/reload`.
- `brain/providers.py` — cascada real: **Groq → OpenRouter → Gemini** (25s/25s/40s, 90s total). README/PLAN dicen OpenRouter primero; están desactualizados.
- `brain/config.py` — `GROQ_MODEL = llama-3.3-70b-versatile`, `OPENROUTER_MODEL = openrouter/free`; Gemini `gemini-flash-lite-latest` hardcodeado en providers.py.
- `brain/profiles.py` — perfiles SOUL en `brain/profiles/*.md` (`default`, `lucia`, `mateo`, `ventas`, `cobranzas`, `recepcion`), parseo Markdown (`# nombre`, descripción, `## Personalidad`, `## Reglas` con viñetas, `## Formato`, `## Ejemplos` en pares `**Cliente:**`/`**Asistente:**`), cache por mtime (recarga en caliente al editar). `build_system_prompt()` cae a `default` si el key no existe.
- Perfil por contacto: campo `perfil` en `contacts_db.json` (opcional). El brain recibe `metadata.perfil || state.CURRENT_PROFILE`; el global se persiste en `settings_db.json` (`currentProfile`) y recarga a `state` al arrancar.

## Editar perfiles desde WhatsApp (self-chat)

- `/perfil exportar <key>` envía el `.md` como documento; editar y reenviar citándolo con `/update` (o caption `/update`) lo importa y actualiza el archivo. Solo se aceptan archivos `*.md`/`*.txt` nombrados `<key>.md`.
- `/perfil <key>` (global) | `/perfil <key> <num>` o citando (por contacto) | `/perfil ver <key>` (prompt compilado).
- `/perfil` valida contra `GET /profiles` (brain encendido); con brain apagado lista vacía y rechaza cambios.

## Gotchas

- El brain debe estar corriendo o el gateway envía alerta al self-chat (nunca al cliente).
- Memoria del brain es solo RAM (15 msgs); reiniciar `brain` borra conversaciones. `/limpiar` llama a `/reset-memory`.
- `brain/.env` (gitignored, sin `.example`): `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`. Sin key, la cascada se salta ese proveedor.
- Estado por contacto: `estado` (`neutro`/`permitido`/`ignorado`/`handoff`) + `globalMode` (`allowed_all`/`ignored_all`) en `settings_db.json` (`*` en `/i` `/p` cambia el modo global).
- `settings_db.json` e `ignored_numbers.json` están versionados; `contacts_db.json`/`allowed_numbers.json` no. `allowed_numbers.json`/`ignored_numbers.json` son legado: no se referencian en el código.
- Comandos admin solo en self-chat (mensaje a ti mismo); texto normal ahí = asistente IA. `/` de clientes = bloqueado (seguridad).
- `contacts_db.json` se limpia de basura en cada arranque (`cleanContactsDB()`).
- Verificar cambios: arrancar brain + gateway manualmente (no hay tests).
- Código, logs y comentarios en español.
