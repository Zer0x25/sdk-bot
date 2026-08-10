# AGENTS.md

Plataforma WhatsApp multi-bot: `gateway/` (Node.js + Baileys) + `brain/` (Python FastAPI). No hay CI, lint ni tests (`npm test` es placeholder).

## Arranque (orden importa)

1. Brain primero: `cd brain; python main.py` (venv: `venv/bin/python` Linux / `venv\Scripts\python.exe` Windows) → FastAPI en `0.0.0.0:8000`. El puerto es fijo: `gateway/config.js` tiene `BRAIN_API_URL` hardcodeado a `http://127.0.0.1:8000/chat`.
2. Gateway: `cd gateway; npm start` (o `node index.js`).
3. QR nuevo / re-sincronizar libreta: `cd gateway; npm run reset` (borra `auth_info_baileys/` tras confirmar y lanza index.js).
4. **Producción (F1):** despliegue unificado por plataforma en `deploy/` (`linux/` systemd, `termux/` runit, `windows/` scripts). Linux: `sudo bash deploy/linux/install.sh`; Termux: `bash deploy/termux/setup-termux.sh`; Windows: `deploy/windows/startBrain.bat` + `startGateway.bat`. Verificar con `systemctl status sdk-bot-{brain,gateway}` y `journalctl -u sdk-bot-gateway -f`.

**Desarrollo vs producción:** nunca corras manual y systemd del mismo componente a la vez (el lock de instancia única bloquea al segundo). Usa `bash deploy/linux/dev.sh`:
- `dev.sh manual brain|gateway|ambos` — detiene el service systemd y lanza la instancia manual (foreground, Ctrl+C al terminar; `ambos` imprime los comandos para 2 terminales).
- `dev.sh reset brain|gateway|ambos` — mata las instancias manuales y relanza los services de systemd.
- `dev.sh status` — estado de services y locks.

Logs: `gateway/logs/gateway.log` y `brain/logs/brain.log` (rotación 5MB, 3 backups). Ver en vivo: `tail -f gateway/logs/gateway.log | pino-pretty` (instalar pino-pretty aparte) o `cat` directo (JSON por línea).

Setup primera vez (Linux Debian/Ubuntu): `sudo apt install python3-venv` → `cd brain; python3 -m venv venv && venv/bin/pip install -r requirements.txt`. Windows: `python -m venv venv && venv\Scripts\pip install -r requirements.txt`.

## Arquitectura

- `gateway/index.js` — entrada Baileys (`syncFullHistory: true`, `presenceSubscribe`, `markOnlineOnConnect`). El admin se detecta solo (`state.ADMIN_PHONE/LID`). Reconexión con **backoff exponencial 2s→5s→15s→60s** (reset en `open`); socket anterior se cierra con `sock.end()` antes de recrear.
- `gateway/config.js` — `state` global (`CURRENT_PROFILE`, `GLOBAL_MODE`, `IS_BOT_PAUSED`) + registro anti-bucle `botSentMessageIds` (expira a los 60s).
- `gateway/services/storageService.js` — persistencia `contacts_db.json` (write atómico tmp+rename) + `settings_db.json` con debounce 2s y flush en SIGINT/SIGTERM. **Índices RAM** `phoneIndex`/`lidIndex`/`digitsIndex` (R1): reconstruidos en `saveContactsDB()`, `findExistingKey()` O(1) en hot paths.
- `gateway/services/metadataService.js` — país/idioma por prefijo (América + Europa), TTL 24h foto/bio, resuelve Phone y LID dual.
- `gateway/services/brainService.js` — cliente REST del brain (timeout global 90s) + simulación humana (typing 7-10 char/s, multi-bubble ~220 chars). **Retry 1x** en errores transitorios (red/timeout/5xx); los 4xx no se reintentan.
- `gateway/services/aiQueue.js` — pool de concurrencia global (máx 3 `processAIChat` en paralelo, cola FIFO). Evita saturar a los proveedores con varios clientes a la vez.
- `gateway/services/logger.js` — pino + pino-roll (rotación 5MB × 3): `logs/gateway.log` + stdout. Categorías vía `cat('AI'|'DEBOUNCE'|'PRESENCIA'|'COMANDO'|'ERROR'|'CORE'|'INSTANCIA'|'STORAGE')`.
- `brain/logging_setup.py` — logging rotado del brain (RotatingFileHandler a `brain/logs/brain.log` + consola); `safe_log` en providers y logs de main.py/profiles.py lo usan.
- `gateway/handlers/messageHandler.js` — pipeline, de-bounce estocástico (5-7s corto, 7.5-12s largo/múltiple; 12% → 1-2m; 5% → 3-4m), TTL de tecleo 5s, handoff por palabras clave.
- `gateway/handlers/commandHandler.js` — comandos admin del self-chat; citar un mensaje extrae teléfono/LID automáticamente.
- `brain/main.py` — endpoints `POST /chat`, `POST /reset-memory`, `GET /profiles`, `GET /profiles/{key}` (prompt compilado), `GET /profiles/{key}/file`, `POST /profiles/import`, `POST /profiles/reload`.
- `brain/providers.py` — cascada real: **Groq → OpenRouter → Gemini** (25s/25s/40s, 90s total). README/PLAN dicen OpenRouter primero; están desactualizados. `google-genai` se importa de forma DEFENSIVA (`try/except ImportError`): en Termux no hay wheel y no se instala; Gemini queda desactivado sin romper el brain.
- `brain/config.py` — `GROQ_MODEL = llama-3.3-70b-versatile`, `OPENROUTER_MODEL = openrouter/free`; Gemini `gemini-flash-lite-latest` hardcodeado en providers.py.
- `brain/profiles.py` — perfiles SOUL en `brain/profiles/*.md` (`default`, `lucia`, `mateo`, `ventas`, `cobranzas`, `recepcion`), parseo Markdown (`# nombre`, descripción, `## Personalidad`, `## Reglas` con viñetas, `## Formato`, `## Ejemplos` en pares `**Cliente:**`/`**Asistente:**`), cache por mtime (recarga en caliente al editar). `build_system_prompt()` cae a `default` si el key no existe.
- Perfil por contacto: campo `perfil` en `contacts_db.json` (opcional). El brain recibe `metadata.perfil || state.CURRENT_PROFILE`; el global se persiste en `settings_db.json` (`currentProfile`) y recarga a `state` al arrancar.

## Editar perfiles desde WhatsApp (self-chat)

- `/perfil exportar <key>` envía el `.md` como documento; editar y reenviar citándolo con `/update` (o caption `/update`) lo importa y actualiza el archivo. Solo se aceptan archivos `*.md`/`*.txt` nombrados `<key>.md` (el nombre del archivo DEFINE la clave del perfil; cualquier `<key>.md` nuevo crea un perfil nuevo).
- `/perfil eliminar <key>` (alias: borrar/delete/del/rm) borra el `.md` vía `DELETE /profiles/{key}`. `default` está protegido. Al borrar un perfil asignado a contactos, el brain cae a `default`.
- `/perfil <key>` (global) | `/perfil <key> <num>` o citando (por contacto) | `/perfil ver <key>` (prompt compilado).
- `/perfil` valida contra `GET /profiles` (brain encendido); con brain apagado lista vacía y rechaza cambios.

## Gotchas

- **Instancia única:** brain y gateway escriben un lock con PID (`.brain.lock`, `.gateway.lock`, gitignored). Abrir una segunda instancia se bloquea con mensaje claro (protege `auth_info_baileys` de corrupción por doble gateway). Para reiniciar: `python main.py --restart` / `npm start -- --restart`. Los locks huérfanos se auto-limpian.
- El brain debe estar corriendo o el gateway envía alerta al self-chat (nunca al cliente).
- Memoria del brain es solo RAM (15 msgs); reiniciar `brain` borra conversaciones. `/limpiar` llama a `/reset-memory`.
- `brain/.env` (gitignored, sin `.example`): `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`. Sin key, la cascada se salta ese proveedor.
- Estado por contacto: `estado` (`neutro`/`permitido`/`ignorado`/`handoff`) + `globalMode` (`allowed_all`/`ignored_all`) en `settings_db.json` (`*` en `/i` `/p` cambia el modo global).
- `settings_db.json` NO está versionado (gitignored por privacidad; contiene números de teléfono). Hay plantilla `settings_db.json.example`; los archivos legacy `allowed_numbers.json`/`ignored_numbers.json` fueron eliminados (R3, no se referenciaban).
- Comandos admin solo en self-chat (mensaje a ti mismo); texto normal ahí = asistente IA. `/` de clientes = bloqueado (seguridad).
- `contacts_db.json` se limpia de basura en cada arranque (`cleanContactsDB()`).
- **Bio legada con 422:** registros viejos de `contacts_db.json` pueden tener `bio` como OBJETO `{status,setAt}` (de `sock.fetchStatus` antiguo), lo que rompe el brain con `422 Input should be a valid string`. Sanitizada en `cleanContactsDB()` (D), en `extractUserMetadata` (solo strings) y en los upserts (solo strings). `fetchStatus` devuelve un ARRAY `[{status,setAt,id}]` — tomar `[0].status`.
- **Seguridad (F2):** el brain escucha SOLO en `127.0.0.1` (`BRAIN_HOST` para override) y, si `BRAIN_API_KEY` está en `brain/.env`, TODA ruta (menos `/` health) exige header `X-API-Key` → 401. El gateway la lee sola de `brain/.env` (`getBrainApiKey()`), no hace falta configurarla en otro lado. Sin key en `.env` = modo legacy sin auth.
- **Rate limits (F2):** brain 10 llamadas/min por `user_id` en `/chat` → 429 (env `BRAIN_RATE_LIMIT_PER_MIN` / `BRAIN_RATE_LIMIT_ENABLED=0`); gateway 20 comandos admin/min (ignora el resto con aviso).
- **Markdown injection (F2):** nombres de contacto (savedName/pushName/query) se interpolaron crudos en mensajes markdown; usar SIEMPRE `sanitizeMarkdown()` (quita `* _ ` ~` y saltos de línea) antes de incrustar texto de usuario en `commandHandler.js`.
- **Baileys 7 rc14 — `downloadMediaMessage(msg, type, options, ctx)`:** el `ctx` (4º arg) lleva `reuploadRequest` (FUNCIÓN, no booleano) y `logger` (logger real). El reupload real requiere store de mensajes (no lo tenemos): `reuploadRequest: async (m) => m` reintenta con el mismo mensaje y deja llegar el error real al admin.
- Serialización por chat (B1): `chatInFlight` (Set en `messageHandler.js`) impide 2 llamadas de IA simultáneas por cliente; los mensajes que llegan durante una llamada se acumulan en el buffer y se reprograman al terminar. Los buffers huérfanos se descartan a los 15 min (B2).
- **Reconexión (F1):** al cerrarse una conexión, el gateway espera con backoff (2s→60s) antes de reconectar; NUNCA reconecta en loop inmediato. Si el socket se cae mientras responde una IA, el cliente queda en espera hasta la reconexión.
- **Logs rotados:** `logs/` de gateway y brain están en `.gitignore`; borrarlos es seguro. El brain usa `logging` de Python — `print()` directo NO llega a `brain.log` (usar `safe_log` o `make_logger`).
- Verificar cambios: arrancar brain + gateway manualmente (no hay tests).
- Código, logs y comentarios en español.
