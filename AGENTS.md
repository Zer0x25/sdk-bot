# SDK-Bot: instrucciones para OpenCode

## Limites y arquitectura

- No hay workspace ni manifest de paquete en la raiz: el paquete Node vive en `gateway/` y la aplicacion Python en `brain/`. Sus entradas son `gateway/index.js` y `brain/main.py`.
- `gateway/index.js` es dueño de WhatsApp/Baileys, Telegram, el bus interno y el status server. `gateway/panel/index.js` es un tercer proceso: sirve `panel/public/` sin build y proxifica `/api/*` al bus.
- En Docker el panel debe ejecutar `node panel/index.js`, nunca `node index.js`: lo segundo iniciaria un gateway adicional y puede provocar una segunda sesion de WhatsApp.
- El launcher local canonico es `bash deploy/linux/dev.sh manual todos` (o el objetivo individual `brain`, `gateway` o `panel`); arranca brain antes de gateway/panel. En dev usa brain `:5100`, bus `:5400`, status `:5300` y panel `:5201`.
- Cada canal normaliza a `StandardMessage` y las IDs remotas llevan prefijo (`whatsapp:<id>` o `telegram:<chat_id>`); la logica comun no debe depender de JIDs nativos.
- Las decisiones puras estan en `gateway/services/pipeline.js`; buffers y efectos secundarios estan en `gateway/handlers/messageHandler.js`. Los comandos se agregan como modulos en `gateway/handlers/commands/` y se registran en `commandHandler.js`.
- Las decisiones de arquitectura viven en `docs/adr/`: 001 hub multi-canal, 002 procesos y planos (datos/control), 003 dueno unico del transporte por canal, 004 resiliencia de la interaccion. Leelas antes de refactors grandes; cualquier cambio que rompa esos contratos exige una ADR nueva.
- Todo `fetch` saliente lleva `AbortSignal.timeout(ms)` explicito y clasificacion 4xx (no reintentar) vs transitorio (1 reintento); ver ADR-004.
- Usa `syntaxError()`/`COMMAND_USAGE` para errores de comandos y `sanitizeMarkdown()` para texto de usuario interpolado en respuestas Markdown.
- El router ejecutable del brain es Groq -> OpenRouter -> Gemini (`brain/providers.py`); los perfiles son Markdown en `brain/profiles/`, se recargan en caliente y `default` es el fallback.

## Setup y verificacion

```bash
cd brain
python3 -m venv venv && venv/bin/pip install -r requirements-dev.txt
cd ../gateway
npm ci
```

- `cd gateway && npm run check` es el check completo y su orden es `lint -> typecheck -> npm test`.
- `cd brain && venv/bin/ruff check . && venv/bin/python -m pytest tests/ -q` es el check completo del brain. CI usa Node 22 y Python 3.12.
- CI tambien ejecuta `cd gateway && bash ../deploy/linux/tests/install-smoke.sh` despues de las pruebas.
- Tests enfocados: `cd gateway && node --test tests/pipeline.test.js`; `cd gateway && node --test tests/telegram.test.js`; `cd gateway && node --test tests/adminPairing.test.js`; brain: `cd brain && venv/bin/python -m pytest tests/test_memory.py -q`.
- `npm test` define `SDK_BOT_TEST=1` y escribe los logs tecnicos en `/tmp/sdk-bot-test-<pid>.log`, no en `gateway/logs/` ni en stdout operativo.
- Los tests que cargan rutas desde env deben definirlas antes de hacer `require`: usa temporales para `SDK_CONTACTS_DB_PATH`, `SDK_SETTINGS_DB_PATH`, `SDK_BROADCAST_DB_PATH`, `SDK_MESSAGE_QUEUE_PATH`, `SDK_AUTH_DIR`, `BRAIN_MEMORY_DB`, logs y locks. Nunca apuntes a estado de produccion.
- Cierra recursos persistentes en tests: `stopTelegramPoller()` para el poller y `reader.cancel()`/cierre del servidor para SSE `/qr` y `/logs`; de lo contrario queda vivo el event loop.

## Estado y operaciones

- `brain/.env`, `gateway/panel/.env`, `gateway/auth_info_baileys/`, las DB JSON, `brain/memory.db`, `gateway/queue/`, logs y locks son secretos/estado local: no versionarlos ni usarlos como fixtures. Las API keys van en `brain/.env`; `.env.tuning` es el tuning versionado que leen ambos componentes y cuyos valores puede sobreescribir el entorno.
- Lee y escribe contactos/settings mediante `gateway/services/db.js`; conserva el guardado diferido y la escritura atomica de contactos. Si agregas estado runtime, actualiza el inventario unico de `gateway/services/factoryReset.js`.
- Un despliegue nuevo queda en `globalMode=ignored_all`: un admin debe permitir contactos antes de que respondan. No ejecutes el mismo componente manualmente y con Docker/systemd; los locks protegen la sesion de WhatsApp.
- Produccion documentada: `docker compose -f deploy/docker/compose.yml build && docker compose -f deploy/docker/compose.yml up -d`; verifica con `docker compose -f deploy/docker/compose.yml ps` y `docker compose -f deploy/docker/compose.yml logs -f gateway`. La alternativa systemd legacy (`deploy/linux/*.service` + `install.sh`) fue eliminada; el camino de dev/local es `deploy/linux/dev.sh up|down|status`.
- `cd gateway && npm run reset` borra solo la sesion de WhatsApp y pide QR nuevo (modo no interactivo: `npm run reset -- --yes`). `npm run clean` es un factory reset destructivo (modo no interactivo: `npm run clean -- --yes`, conserva `brain/profiles/`); `docker compose -f deploy/docker/compose.yml down -v` borra tambien los volumenes.
- El pairing QR dura 140 s en total; el codigo por numero es manual, de 8 caracteres y no se renueva. El bus bloquea solicitudes QR/codigo cruzadas.

## Auth y plataformas

- Antes de tocar OAuth del panel lee `docs/OAUTH-LESSONS.md`: el estado OAuth es server-side y la cookie de sesion es `SameSite=Lax` (`Secure` tras HTTPS). OAuth requiere produccion o `PANEL_REQUIRE_AUTH=true`/`***`, ademas de ambas credenciales; en dev el panel queda abierto.
- Mantener `google-genai` detras del `ImportError`: `requirements-termux.txt` lo omite deliberadamente porque no instala de forma fiable en Termux.
