# SDK-Bot: instrucciones y reglas de arquitectura para agentes de IA

## Evolución hacia la plataforma de conversaciones

- Antes de trabajar en historial, bandeja, UI o control humano, lee
  `docs/SESSION-STATE.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` y
  `docs/adr/005-plataforma-conversaciones.md`. El prompt reutilizable está en
  `docs/PROMPT-CONTINUIDAD.md`.
- Para contratos/identidad/control/migración usa `docs/SPEC-OPERATIVA-V1.md` y
  `docs/VALIDACION-V1.md`. Los escenarios JSON son expectativas, no tests runtime
  aprobados; la deduplicación usa identidad canónica y expectedVersion es controlVersion.
- `packages/contracts` y workspace raíz existen desde F1A. F1B implementa sesión
  v1 y frontera firmada; F2A añade repositorios SQLite/worker y snapshot durable
  (docs/ARCHIVO-CONVERSACIONES-F2A.md). F2B.2 conecta captura base WA live/history
  (docs/CAPTURA-WHATSAPP-F2B2.md); STT persistente y captions multimedia pendientes
  F2B.3. ADR-006 permite esperar admisión durable antes del handler legacy; no
  añadir reglas de acceso/control al adapter. `apps/`, React y el resto de API v1
  siguen como **arquitectura de destino**. Las rutas y
  comandos de las secciones siguientes describen la estructura actual.
- Una unidad revisable por sesión. Actualiza estado y evidencia al cerrar;
  marca solo tareas demostradas. Conserva los límites de ADR-001/002/003.
- Haz un commit local al cerrar cada fase o unidad entregable probada. Registra
  bugs en `docs/BACKLOG.md`: repara ahora los que bloqueen la especificación de la
  unidad; los demás quedan priorizados con fase límite y aceptación. Cierra bugs
  con evidencia/commit, sin borrar el registro. No publiques por hacer un commit.
- Historial operativo y contexto IA tienen autoridades y retenciones distintas.
  El control humano requiere cancelación y barrera de envío, no solo cambiar un
  estado visual. ADR-005 propone ampliar ADR-004 para una salida durable; esto
  no indica que ya exista ni modifica el runtime por sí solo.

## Limites y arquitectura

- El workspace raíz contiene `packages/*`; `packages/contracts` tiene schemas OpenAPI/JSON Schema, validadores y tipos generados. Gateway sigue independiente, con su propio manifest/lock en `gateway/`; consume contracts como `file:../packages/contracts`, empaquetado por `.npmrc` install-links=true. Tras editar contratos, repetir `cd gateway && npm ci`: no depender de la copia instalada anterior. Docker copia el paquete antes de instalar. Python en `brain/` y `stt/` mantiene requirements. Entradas: `gateway/index.js`, `brain/main.py`, `stt/server.py`. Ver `packages/contracts/README.md`.
- `gateway/index.js` es dueño de WhatsApp/Baileys, Telegram, el bus interno y el status server. `gateway/panel/index.js` es el proceso de UI/control: sirve `panel/public/` sin build y proxifica `/api/*` al bus. `stt/server.py` expone un endpoint OpenAI-compatible (`POST /v1/audio/transcriptions`) con `faster-whisper` en CPU int8 para normalizar audios a texto sin tocar el cerebro; si STT cae o falla, el gateway descarta el audio con aviso y no tumba el canal.
- En Docker el panel debe ejecutar `node panel/index.js`, nunca `node index.js`: lo segundo iniciaria un gateway adicional y puede provocar una segunda sesion de WhatsApp.
- Mapeo de puertos y procesos (dev vs produccion Docker):
  - Brain: `:5100` (dev) / `:3400` (prod interno)
  - Bus interno: `:5400` (dev) / `:3240` (prod interno)
  - Status server: `:5300` (dev) / `:3640` (prod interno)
  - Panel web: `:5201` (dev) / `:3005` (prod, expuesto tras reverse proxy o tunel seguro)
  - STT: `:9000` (dev y prod interno)
- El launcher local canonico es `bash deploy/linux/dev.sh up all` (o por componente `up brain`, `up gateway panel`, etc.); es idempotente y arranca brain antes de gateway/panel. `down` mata todo y libera locks; `status` hace health de los puertos.
- Cada canal normaliza a `StandardMessage` y las IDs remotas llevan prefijo (`whatsapp:<id>` o `telegram:<chat_id>`); la logica comun no debe depender de JIDs nativos.
- Las decisiones puras estan en `gateway/services/pipeline.js`; buffers y efectos secundarios estan en `gateway/handlers/messageHandler.js`. Los comandos se agregan como modulos en `gateway/handlers/commands/` y se registran en `commandHandler.js`.
- Las decisiones de arquitectura viven en `docs/adr/`: 001 hub multi-canal, 002 procesos y planos (datos/control), 003 dueno unico del transporte por canal, 004 resiliencia de la interaccion. Leelas antes de refactors grandes; cualquier cambio que rompa esos contratos exige una ADR nueva.
- Todo `fetch` saliente lleva `AbortSignal.timeout(ms)` explicito y clasificacion 4xx (no reintentar) vs transitorio (1 reintento); ver ADR-004.
- Usa `syntaxError()`/`COMMAND_USAGE` para errores de comandos y `sanitizeMarkdown()` para texto de usuario interpolado en respuestas Markdown.
- El orden del router del brain lo define `BRAIN_PRIMARY_MODEL` (`brain/providers.py`); `.env.tuning` selecciona Gemini -> Groq -> OpenRouter. Los perfiles son Markdown en `brain/profiles/`, se recargan en caliente y `default` es el fallback.

## Setup y verificacion

```bash
# Contratos (raíz):
npm ci && npm run check
# Brain:
cd brain
uv venv venv && uv pip install -r requirements-dev.txt --python venv/bin/python || (python3 -m venv venv && venv/bin/pip install -r requirements-dev.txt)
# Gateway:
cd ../gateway
npm ci
```

- En distros Linux con PEP 668 se recomienda `uv` para crear el venv del brain (`uv venv venv && uv pip install ...`).
- Para cambiar DTOs: editar schema.json/OpenAPI, `npm run contracts:generate` y
  `npm run check` desde raíz. No editar generated.d.ts manualmente. No confundir
  validación de forma con autorización o servicio implementado.
- `cd gateway && npm run check` es el check completo y su orden es `lint -> typecheck -> npm test`.
- `cd gateway && npm run spike:sqlite` verifica F0.2 con fixtures temporales y worker,
  sin iniciar canales. Requiere Node >=22.13.0 sin flags; Linux probado, Windows y
  Termux pendientes. No es la DB operativa. Ver `docs/SQLITE-SPIKE.md`.
- `cd brain && venv/bin/ruff check . && venv/bin/python -m pytest tests/ -q` es el check completo del brain. CI usa Node 22 y Python 3.12.
- CI tambien ejecuta `cd gateway && bash ../deploy/linux/tests/dev-smoke.sh` despues de las pruebas.
- Tests enfocados: `cd gateway && node --test tests/pipeline.test.js`; `cd gateway && node --test tests/telegram.test.js`; `cd gateway && node --test tests/adminPairing.test.js`; `cd gateway && node --test tests/stt.test.js`; brain: `cd brain && venv/bin/python -m pytest tests/test_memory.py -q`.
- `npm test` define `SDK_BOT_TEST=1` y escribe los logs tecnicos en `/tmp/sdk-bot-test-<pid>.log`, no en `gateway/logs/` ni en stdout operativo.
- Los tests que cargan rutas desde env deben definirlas antes de hacer `require`: usa temporales para `SDK_CONTACTS_DB_PATH`, `SDK_SETTINGS_DB_PATH`, `SDK_BROADCAST_DB_PATH`, `SDK_MESSAGE_QUEUE_PATH`, `SDK_AUTH_DIR`, `BRAIN_MEMORY_DB`, logs y locks. Nunca apuntes a estado de produccion.
- Cierra recursos persistentes en tests: `stopTelegramPoller()` para el poller y `reader.cancel()`/cierre del servidor para SSE `/qr` y `/logs`; de lo contrario queda vivo el event loop.

## Estado y operaciones

- `brain/.env`, `gateway/panel/.env`, `gateway/auth_info_baileys/`, las DB JSON, `brain/memory.db`, `gateway/queue/`, logs y locks son secretos/estado local: no versionarlos ni usarlos como fixtures. Las API keys van en `brain/.env`; `.env.tuning` es el tuning versionado que leen ambos componentes y cuyos valores puede sobreescribir el entorno.
- Lee y escribe contactos/settings mediante `gateway/services/db.js`; conserva el guardado diferido y la escritura atomica de contactos. Si agregas estado runtime, actualiza el inventario unico de `gateway/services/factoryReset.js`.
- Un despliegue nuevo queda en `globalMode=ignored_all`: un admin debe permitir contactos antes de que respondan.
- **Regla estricta de réplica única:** WhatsApp (Baileys) no soporta concurrencia ni multi-instancia sobre las mismas credenciales. Nunca ejecutes el mismo componente simultáneamente en local y en Docker/VPS; los locks protegen la sesión.
- Produccion documentada en cualquier VPS: `docker compose -f deploy/docker/compose.yml build && docker compose -f deploy/docker/compose.yml up -d`; verifica con `docker compose -f deploy/docker/compose.yml ps` y `docker compose -f deploy/docker/compose.yml logs -f gateway`. El panel (`:3005`) está diseñado para publicarse tras un reverse proxy (Caddy, NGINX) o un túnel seguro (ej. Cloudflare Tunnel). El camino de dev/local es `deploy/linux/dev.sh up|down|status`.
- `cd gateway && npm run reset` borra solo la sesion de WhatsApp y pide QR nuevo (modo no interactivo: `npm run reset -- --yes`). `npm run clean` es un factory reset destructivo (modo no interactivo: `npm run clean -- --yes`, conserva `brain/profiles/`); `docker compose -f deploy/docker/compose.yml down -v` borra tambien los volumenes.
- El pairing QR dura 140 s en total; el codigo por numero es manual, de 8 caracteres y no se renueva. El bus bloquea solicitudes QR/codigo cruzadas.

## Auth y plataformas

- Antes de tocar OAuth del panel lee `docs/OAUTH-LESSONS.md`: el estado OAuth es server-side y la cookie de sesion es `SameSite=Lax` (`Secure` tras HTTPS). OAuth requiere produccion o `PANEL_REQUIRE_AUTH=true`/`***`, ademas de ambas credenciales; en dev el panel queda abierto. Si se utiliza un reverse proxy o tunel con proteccion perimetral (ej. Zero Trust), el panel opera de forma transparente respetando HTTPS.
- Mantener `google-genai` detras del `ImportError`: `requirements-termux.txt` lo omite deliberadamente porque no instala de forma fiable en Termux.
- La API v1 exige actor verificado y `SDK_PANEL_GATEWAY_SECRET` >=32 bytes en ambos procesos. `PANEL_DEV_ACTOR=true` solo actúa con NODE_ENV=development y OAuth desactivado; no usarlo en un panel público. Grants v1 por sub Google en servidor, no en cookie/body/header. Las cookies antiguas siguen válidas para legacy pero requieren nuevo login para v1. Ver `docs/FRONTERA-AUTENTICADA-V1.md`. `gateway/lib/` comparte únicamente infraestructura sin estado/canales; panel no importa servicios del gateway.
- Con secreto configurado el bus exige firma también para legacy. Sin él solo conserva compatibilidad local legacy, nunca v1. Compose exige secreto común. No exponer bus/status ni asumir que red interna autentica. Snapshot de sesión viene del archivo SQLite desde F2A; si falta/falla devuelve 503, sin fallback. No hay páginas ni SSE públicos todavía. F5 hará durable policyVersion. SQL solo en services/conversations/worker.js. SDK_CONVERSATIONS_DB_PATH resuelve DB/WAL/SHM en inventario; default gateway/data/conversations.db, Compose en volumen de estado. Cerrar worker antes de reset mediante prepareFactoryReset. F2B.1 cierra BUG-029/031: reset CLI comprueba ambos propietarios antes de señales, rechaza supervisión/inspección no verificable, espera parada efectiva y aborta ante reemplazos. Brain respeta SDK_BRAIN_LOCK_PATH y falla si no publica lock. Ver docs/RESET-SEGURO-F2B1.md; detener supervisores antes del CLI, sin arranques concurrentes. F2B.2 conecta WA: mensajes admitidos se archivan antes de legacy, aliases solo por remoteJidAlt comprobado, FIFO 1000/32MiB y purga inicial/diaria. Estado degradado en channels.whatsapp.capture; timeout incierto exige reinicio/redelivery sin retry ciego. No afirmar control humano, atribución durable ni multimedia completa: BUG-033/034 antes de cerrar F2B. Ver docs/CAPTURA-WHATSAPP-F2B2.md. Telegram/ack siguen F2C.
- Producción o PANEL_REQUIRE_AUTH sin ambas credenciales OAuth falla cerrada; no volver a abrir legacy ni conceder actor dev como fallback. Grants de v1 aún no limitan al administrador del panel legacy: BUG-024 debe resolverse antes de incorporar operadores con permisos limitados.
