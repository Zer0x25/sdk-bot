# Backlog de bugs — SDK-Bot

Actualización: 2026-10-20. Fuente inicial:
[baseline F0.1](BASELINE-CONVERSACIONES.md). Esta lista registra defectos concretos;
las funciones nuevas y sus dependencias siguen en [ROADMAP.md](ROADMAP.md).

## Política de trabajo acordada

- Registrar cada bug al detectarlo: ID, evidencia, impacto, prioridad, estado,
  fase de reparación y prueba de aceptación. Inspección no equivale a reproducción.
- Si impide cumplir la especificación o pasar la aceptación de la unidad actual,
  reproducirlo con una prueba enfocada, repararlo y verificar antes de cerrar.
- Si no bloquea la unidad actual, dejarlo abierto y priorizado aquí. La fase
  indicada no puede cerrarse sin resolverlo o acordar explícitamente otro alcance.
- Cerrar con evidencia de la prueba y commit de reparación. No eliminar el registro.
- Hacer un commit local por fase o unidad entregable probada, después de revisar
  el diff y actualizar roadmap/estado/backlog. No incluir secretos ni cambios ajenos.
  La publicación y el despliegue son acciones separadas.

Prioridad: P1 = pérdida de mensajes/control/aislamiento; P2 = resiliencia o flujo
incorrecto de alcance acotado. Estado inicial: **abierto, inspección de código**,
salvo indicación contraria. La evidencia detallada y líneas están en la baseline.

## Registro

| ID | Prioridad | Bug e impacto | Evidencia | Fase límite y aceptación |
|---|---|---|---|---|
| BUG-001 | P1 | Cerrado F2B.2: WA solo procesaba el primer elemento del lote. | Reproducción de 4bb4ec3 emite 1/3; adaptador actual captura todos los admitidos antes de legacy. | Lote, reinicio y ráfaga 1001 con saturación/redelivery probados; CAPTURA-WHATSAPP-F2B2. |
| BUG-002 | P1 | Cerrado F2B.2: cache RAM no recibía mensajes live. | index conecta archived_message a upsertMessage tras commit; entry real conserva SQLite y reconstruye cache al reentregar tras reinicio. | Dos ciclos reales offline con 3 mensajes, IDs/epoch/seq estables; CAPTURA-WHATSAPP-F2B2. |
| BUG-003 | P1 | Cerrado F2B.2: callbacks de sockets WA reemplazados seguían teniendo efectos. | Reproducción anterior emite mensaje/presencia obsoletos; nuevas guardas cubren mensajes, contactos, historia, presencia, credenciales y STT tardío. | Pruebas con dos sockets y STT suspendido; trabajo previamente admitido puede terminar commit, sin automatizar desde socket reemplazado. |
| BUG-004 | P1 | Cerrado F2C.1: descubrir Chat ID abría getUpdates en paralelo al adapter. | Reproducción de 42b8321 confirma dos lectores. Bus ahora inyecta discoverChatId del mismo adapter; telegramService elimina testAndGetChatId, sin fallback de red. | Pruebas de descubrimiento concurrente/bus activo y entrega normal, cancelación, TTL/límite y token borrador sin nueva lectura. TELEGRAM-DUENO-UNICO-F2C1. |
| BUG-005 | P1 | Cerrado F2C.2: cursor Telegram podía adelantarse sin archivo durable y los IDs JSON grandes perdían precisión. | La captura normaliza antes del worker; mensajes admitidos, evento/proyección y cursor se confirman en una transacción por bot. JSON conserva enteros inseguros como decimal; rollback y redelivery probados. | Migración/reapertura, IDs >2^53, lote inválido atómico y offset posterior al commit; [TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md). El replay cliente se cierra en F2D/BUG-045; el inbox admin sigue BUG-046. |
| BUG-006 | P1 | Cerrado F5.5/F5.8: handoff/pausa podían dejar jobs admitidos activos y enviar globos después del cambio de control. | La barrera valida snapshots en debounce, pool, Brain, typing y cada salida; la integración cubre takeover/cancelación entre globos y envío ya iniciado. | `controlJobs.test.js` y `f58Acceptance.test.js`: job obsoleto no llama Brain, salida incierta queda visible y no se envían globos posteriores. Evidencia: [F5.5](F5.5-JOB-BARRIER.md), [F5.8](F5.8-ACEPTACION-INTEGRADA.md). |
| BUG-007 | P1 | Cerrado F5.7/F5.8: una generación cancelada o una salida parcial podían añadir contexto que no se había enviado. | Brain conserva el borrador por `generation_id`, pero no lo añade al historial legacy antes de la entrega; el contexto conversacional se proyecta desde el archivo y solo incluye salidas aceptadas. | Brain y gateway prueban invalidación, replay idempotente y contexto tras una respuesta aceptada; F5.8 confirma que una cancelación/salida incierta no aparece como diálogo entregado. Evidencia: [F5.7](F5.7-CONTEXTO-IA.md), [F5.8](F5.8-ACEPTACION-INTEGRADA.md). |
| BUG-008 | P1 | Cerrado: la resolución legacy rechazaba sufijos y podía elegir la última fila de una colisión. | El resolver indexa identidades completas, informa colisiones/parciales y los comandos mutables fallan cerrado; Telegram administrativo conserva el adapter de respuesta y dirige objetivos a WhatsApp. | Legacy JSON limitado a identidad WhatsApp completa; el control SQLite sigue usando canal/cuenta exactos. Pruebas de sufijo, colisión, reemplazo de alias y comandos. Evidencia: [BUG-008](BUG-008-RESOLUCION-IDENTIDAD-LEGACY.md). |
| BUG-009 | P1 | Cerrado F2C.2: filtro global Telegram descartaba por `message_id` sin chat. | Se retiró el registro/filtro global del adapter; dedup usa cuenta, chat canónico y `message_id`. Regresión repite ID en dos chats y en el registro global heredado. | Evidencia: [TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md). |
| BUG-010 | P2 | Cerrado: envíos, presencia, menú y helper legacy podían esperar sin deadline. | El adapter aplica 10 s al envío y 3 s a presencia; menú/helper usan 8 s. Los sends durables vencidos quedan `delivery_unknown` y la misma clave no vuelve al proveedor. | Pruebas de timeout, cierre HTTP, ausencia de reintento y estado durable. Poll y `/telegram/test` conservan sus límites previos. Evidencia: [BUG-010](BUG-010-TIMEOUTS-SALIDA-TELEGRAM.md). |
| BUG-011 | P2 | **Cerrado:** `/humano` y `/ia` podían perder la elegibilidad previa o no explicar el bloqueo restante. | El control SQLite conserva acceso; el fallback JSON guarda/restaura el estado previo y usa `neutro` si un handoff antiguo no tiene dato válido. Los comandos explican acceso ignorado y `ignored_all`. | Pruebas de ambos comandos con autoridad JSON y SQLite, permiso permitido, ignorado y neutral. Evidencia: [BUG-011](BUG-011-CONTROL-LEGACY.md). |
| BUG-012 | P2 | Cerrado F5.6: `/notify` usaba el contrato legacy del socket sin clave durable. | El gateway inyecta un `ChannelAdapter`; la ruta conserva jid/mensaje y ahora pasa por `SendMessage`. | Prueba HTTP: rechaza llamadas sin clave, propaga `Idempotency-Key`, política notice y estado outbox aceptado. |
| BUG-013 | P1 | Cerrado F1B: /history del brain eximía API key aunque contenía contexto privado. | main.require_api_key ya exige credencial; test_main verifica denegación y lectura autorizada. | 401 sin/con clave incorrecta, 200 con correcta; health público. Ver registro de cierre. |
| BUG-014 | P2 | **Cerrado 2026-10-22:** tests Brain compartían almacenamiento por suite y podían dejar una conexión/ruta temporal en estado global. | `test_main` y `test_memory` ahora usan DB por caso, cierran SQLite y restauran `DB_PATH`, `BRAIN_MEMORY_DB` y contadores. | Aserciones fijan cada ruta dentro de `tmp_path`; dos procesos simultáneos pasaron 27/27 cada uno con `--basetemp` independiente; suite Brain 41/41 y Ruff limpio. |
| BUG-024 | P1 | **Cerrado en F7.3:** grants v1 no limitaban el administrador legacy. | OAuth ahora exige `admin:write` explícito para toda `/api/*` legacy y la UI legacy; una sesión solo lectura conserva `/inbox/*`. `panelBoundary.test.js` demuestra que status/QR/logs/command/reset no llegan al bus sin grant y que el grant abre status/UI. | Aceptación cumplida en F7.3; suites de panel/gateway y contrato. No hay subroles legacy: ese grant equivale a administración completa. |
| BUG-026 | P1 | Cerrado F2A: reset desde self-chat/panel podía borrar la nueva SQLite sin cerrar su worker. | Hook común prepareFactoryReset; test con DB real comprueba cierre antes de unlink y fallo sin borrado. | Reparado antes de activar archivo; detalle abajo. |
| BUG-027 | P2 | Cerrado F2A: RPC retenía referencias mutables mientras esperaba readiness, permitiendo cambiar payload después de admisión/presupuesto. | Copia JSON al admitir; regresión muta texto antes del dispatch y confirma contenido original. | Reparado en F2A; no usar objetos del caller como cola durable. |
| BUG-028 | P1 | Cerrado F2A: hash sensible al orden de propiedades y calculado sobre marcador oversized confundía contenidos diferentes del mismo tamaño. | Hash de contenido original con claves ordenadas; prueba redelivery con propiedades permutadas y conflicto de dos textos >64 KiB del mismo tamaño. | Reparado F2A antes de persistencia live. |
| BUG-029 | P1 | Cerrado F2B.1: CLI podía borrar tras matar un PID que systemd relanza; detector tampoco reconocía cgroups v2. | Reproducción de stopProcess de 37525a1 con supervisor falso deja vivo un reemplazo. Nueva guarda rechaza supervisión antes de señales/borrado y verifica parada manual. | 14 regresiones de guarda/CLI; cierre y límites en RESET-SEGURO-F2B1. |
| BUG-030 | P1 | Cerrado F2A: index ignoraba SDK_GATEWAY_LOCK_PATH aunque Compose/CLI/inventario lo usan; reset podía no encontrar el proceso vivo. | Smoke aislado reproduce ausencia del lock configurado antes del cambio; entry real ahora crea/borrar ese lock y conserva epoch tras reinicio. | Reparado para coherencia de rutas F2A; no cierra carrera de supervisor BUG-029. |
| BUG-031 | P1 | Cerrado F2B.1: brain ignoraba SDK_BRAIN_LOCK_PATH, ocultando el proceso al CLI con ruta configurada; errores de escritura del lock también se silenciaban. | Hijo Python verifica ruta/PID/remoción; ensure_singleton aborta si no puede publicar lock. | Reparado antes de captura live; dos regresiones, brain 23 tests pasan. Ver RESET-SEGURO-F2B1. |
| BUG-032 | P1 | Cerrado F2B.2: dos connect con loadAuth asíncrono podían instalar primero el socket nuevo y luego uno obsoleto. | Reproducción en 4bb4ec3 confirma sustitución; revisión monotónica de conexión descarta auth atrasado. | Test overlapping connect pasa; mismo commit de cierre F2B.2. |
| BUG-033 | P1 | Cerrado F2B.3: STT legacy no actualizaba el audio archivado. | Reproducción de 7d99f36 deja cinco audios not_requested tras terminar. Ahora se guarda pending/completed/failed y message.updated sobre el ID original antes de legacy. | Mismo ID/huella, redelivery JID/LID, fallo/exceso, purga sin recreación, restart y resultado incierto sin retry probados; MULTIMEDIA-WHATSAPP-F2B3. |
| BUG-034 | P2 | Cerrado F2B.3: caption se guardaba como texto perdiendo tipo de adjunto. | Reproducción de 7d99f36 confirma type=text. Caption opcional en contrato multimedia y normalización con wrappers; copia gateway refrescada. | Tipos/validadores Node22/24, captions literales, límite/oversized y dedup. Texto antiguo sigue legible; forma incompatible nueva se conserva en revisión, sin inventar el tipo perdido. |
| BUG-035 | P2 | Cerrado: el solicitante podía pedir pairing antes de que terminara `connect()`; el refresh QR también descartaba la promesa de conexión. | Callbacks de pairing esperan `connect()`, propagan fallos y preservan el socket durante una ventana QR vigente. | Auth suspendido prueba espera de socket/código y propagación de error; refresh espera conexión y no crea otro socket con QR activo. Sin pairing real. [Evidencia](BUG-035-PAIRING-ASYNC.md). |
| BUG-036 | P1 | Cerrado F2B.3: audios live iniciaban descargas/STT sin límite propio y bufferizaban el adjunto completo antes de validar tamaño. | Reproducción anterior inicia cinco transcripciones bloqueadas simultáneas. Coordinador actual limita cuatro trabajos sin cola, deadline 150 s y acumulación por stream hasta límite de bytes. | Timeout/saturación y proveedor que ignora abort conservando su plaza, exceso de stream sin STT, captura no bloqueada y desconexión probados. BUG-037 añade cancelación física del HTTP en la frontera de descarga; no acredita aceptación live de proveedor/STT. |
| BUG-037 | P2 | **Cerrado 2026-10-22:** Baileys 7.0.0-rc14 omitía `signal` al llamar `fetch`, dejando viva la descarga HTTP tras cancelar STT. | Cada descarga usa un `undici.Agent` privado pasado por la opción `dispatcher` admitida por Baileys; cancelación/deadline destruye el dispatcher y el stream. Final/error/cierre temprano liberan recursos sin tocar `global.fetch` ni `node_modules`. | `whatsappCapture.test.js`: downloader real de Baileys contra HTTP local que no envía headers/body; ocho cancelaciones/deadlines cierran sus ocho sockets y dejan cero activos en cada vuelta. Evidencia: [BUG-037](BUG-037-CANCELACION-BAILEYS.md). No equivale a aceptación live de proveedor/STT. |
| BUG-038 | P1 | Cerrado F2C.1: reconnect/disconnect invalidaban el loop pero dejaban vivo el request getUpdates anterior; audio tardío podía emitir con un ciclo/token sustituido. | Reproducción anterior deja A pendiente tras abrir B. Ciclo actual cancela y espera cierre local antes del siguiente; generación/token capturados y revalidados tras audio. | Connect superados, cierre demorado y STT suspendido probados, sin lectura solapada ni efecto tardío de entrada. No cierra el dispatcher común ni BUG-050/F5. |
| BUG-039 | P1 | Cerrado F2C.1: cambiar token conservaba lastUpdateId del bot anterior, pudiendo confirmar updates de otra cuenta. | Reproducción anterior pasa offset 124 de A a B. Ahora cambia a 1 al cambiar token y conserva RAM al reconectar el mismo. | Prueba A=900, reconnect A=901, B=1. Cursor durable/identidad de cuenta y rotación del mismo bot siguen F2C.2; no se usa token como accountId. |
| BUG-040 | P2 | Cerrado F2C.1: errores JSON de Bot API no-auth relanzaban getUpdates sin backoff, también 4xx. | Reproducción anterior de 500 abre otra consulta inmediatamente. Ahora 4xx paran en standby visible y red/timeout/5xx esperan recuperación cancelable. | 401/404/409 y error 500/red/desconexión probados; sin bucle inmediato ni retry de envío. |
| BUG-041 | P2 | Cerrado F2C.1: setup Telegram parcial borraba token visible al recargar y bloqueaba Chat ID/prueba tras guardar sin ID. | VM del código anterior confirma token parcial vacío, Chat ID readOnly y botón Probar oculto. | VM actual recorre guardar token vacío de ID, recarga, descubrimiento, guardado explícito y desconexión; no es aceptación visual/navegador real. |
| BUG-042 | P2 | Cerrado F2C.1: concatenar cada chunk HTTP como string corrompía caracteres UTF-8 divididos entre chunks. | Reproducción anterior convierte emoji en reemplazos. requestJson acumula bytes y decodifica UTF-8 estricto una vez, con límite 8 MiB. | HTTP local con bytes separados, UTF-8/JSON inválidos y respuesta excesiva; error no entrega lote al adapter. |
| BUG-043 | P1 | Cerrado F5: una respuesta de formato podía reintentar Markdown con el token mutable y enviar al bot reemplazante. | TelegramAdapter captura token, accountId, adminChatId y generación por envío; reintenta solo si esa misma sesión sigue activa. La aceptación tardía se archiva con la cuenta de origen. | Pruebas con transporte controlado rotan A→B antes del 400 y confirman `TG_CONNECTION_CHANGED` sin segundo POST; una aceptación tardía queda archivada en A aunque B cambie también el chat admin. `gateway npm run check`: lint, typecheck, 13 pruebas Vitest, build y 271 pruebas Node. Commit `8a84f8c`; regresiones en `gateway/tests/telegramCapture.test.js`. |
| BUG-044 | P2 | Cerrado F2C.2: descarga Telegram de audio usaba arrayBuffer completo sin límite propio. | Descarga ahora lee por stream, corta al superar STT_MAX_UPLOAD_BYTES y marca failed el mismo mensaje; audio excesivo no invoca STT. | Regresión de stream sobre el límite, estado durable y cero llamadas STT; [TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md). |
| BUG-045 | P1 | Cerrado F2D: el mensaje podía quedar archivado con cursor avanzado y no llegar al pipeline legacy si el proceso caía entre commit y emisión. | SQLite v3 inserta `legacy_dispatch` en la transacción de captura. El pump reanuda pendientes al abrir el canal; la rama respond mantiene pendiente el ACK hasta completar debounce/IA. | Prueba cierra proceso después del commit y antes del wake, reinicia, entrega una vez, persiste ACK y no redespacha tras otra reapertura. Error de handler queda pendiente con backoff. Evidencia: [REPLAY-LEGACY-F2D](REPLAY-LEGACY-F2D.md). At-least-once ante efectos/ACK ambiguos queda BUG-050. |
| BUG-046 | P1 | Cerrado F2C.3: el cursor del chat admin podía avanzar antes de que el comando llegara al pipeline, perdiéndolo ante una caída. | SQLite v15 guarda texto admin normalizado y cursor en la misma transacción; el pump reclama por cuenta/update antes del pipeline, persiste resultado y marca `processing` como `uncertain` al reiniciar, sin repetir efectos. El historial de clientes sigue separado. | Pruebas de reinicio antes del reclamo y tras efecto/antes del ACK, conflicto de identidad y rollback atómico. No es exactly-once: un claim incierto puede requerir revisión manual. [Evidencia](BUG-046-TELEGRAM-ADMIN-INBOX.md). |
| BUG-047 | P1 | Cerrado F2C.2: el adapter podía ejecutar dos veces un comando admin si recibía de nuevo un `update_id` ya confirmado. | La rama admin emitía aunque el archivo devolviera `stale`, mientras los mensajes cliente sí se filtraban por resultado. Regresión vuelve a entregar el mismo update tras el commit. | Solo se ejecutan comandos admin para updates no stale; repetición deja un único despacho. Evidencia en [TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md). El inbox durable/crash gap sigue en BUG-046. |
| BUG-050 | P1 | Cerrado F5.6: el replay podía repetir una salida si el proceso caía antes del ACK durable. | `SendMessage` guarda intent y clave en SQLite antes de red. Aceptados no vuelven a llamar al proveedor; `sending` tras reinicio pasa a `delivery_unknown`, que exige conciliación. Campañas viejas sin recibo se pausan. | Transportes falsos cubren timeout, respuesta aceptada, ACK/reinicio, dos claims concurrentes y clave con payload distinto. No es exactly-once del proveedor: su API no admite clave de idempotencia; ambigüedad queda explícita, sin reenvío ciego. [F5.6](F5.6-OUTBOX.md). |
| BUG-051 | P2 | Cerrado en repo, puerta operativa antes de migrar archivos reales: filas anteriores a SQLite v3 no tienen recibo y la migración no puede deducir si el handler legacy ya las vio. | `conversations:legacy-reconcile` genera un informe offline de candidatos sin texto ni identidades remotas. La reconciliación cubre todos los IDs, registra decisión, revisor, fecha UTC y referencia de evidencia, y coincide con el SHA-256 del archivo. | Fixture v2 probado antes de abrir el migrador; rechaza sidecars, no altera schema/outbox y clasifica como desconocida toda entrega sin recibo. El informe no reencola ni reproduce; cualquier archivo real requiere revisión y operación posterior explícita. Evidencia: [BUG-051](BUG-051-RECONCILIACION-LEGACY.md). |
| BUG-052 | P2 | Cerrado F2E.1: `sendMessage` de Telegram resolvía una respuesta HTTP 200 `{ok:false}` como éxito, aunque el proveedor había rechazado el envío. | La rama anterior comprobaba únicamente status 200 y analizaba JSON sin verificar `ok`. | Transporte falso devuelve `{ok:false}` con HTTP 200: se rechaza con `TG_SEND_REJECTED` y no aparece fila en SQLite; salida `{ok:true}` queda archivada. Evidencia: [SALIDAS-ACEPTADAS-F2E1](SALIDAS-ACEPTADAS-F2E1.md). |
| BUG-053 | P2 | Cerrado F2E.1: la autoría de un eco WA dependía de si el retorno de `sendMessage` o el evento `fromMe` ganaba una carrera. | Una correlación `sentIds` solo existía después del retorno del socket y cambiaba authorKind a `unknown`; antes del retorno quedaba `external_self`. | El resultado aceptado y los ecos conservan `external_self`; prueba fuerza eco antes del retorno, comprueba una sola fila y el mismo contenido. No atribuye origen IA/operador; eso sigue F5. Evidencia: [SALIDAS-ACEPTADAS-F2E1](SALIDAS-ACEPTADAS-F2E1.md). |
| BUG-054 | P2 | Cerrado F2E.1: `sendMessage` Telegram decodificaba cada fragmento HTTP como texto y podía corromper Unicode dividido entre chunks. | La respuesta Bot API se concatenaba con `body += chunk`, distinto del parser acotado del polling. | El mock divide un emoji dentro de sus bytes UTF-8; el resultado archivado conserva texto exacto y el ID grande. Evidencia: [SALIDAS-ACEPTADAS-F2E1](SALIDAS-ACEPTADAS-F2E1.md). |
| BUG-055 | P2 | Cerrado F2E.2: el log superaba los 50.000 eventos recientes después del backfill bajo tráfico nuevo. | El primer run completo terminó con 50.700 eventos al ingresar 2.700 mensajes desde un snapshot de 50.000. La poda se movió al final de cada transacción que agrega eventos. | La repetición de 1M más dos calentamientos/tres mediciones conserva exactamente 50.000 eventos con watermark `1.002.700`; [evidencia](F2E2-CARGA-COMPLETA.md). F3 debe responder `resync.required` a cursores anteriores a la ventana retenida. |
| BUG-056 | P1 | Cerrado F3.1: los filtros opcionales de la lista llegaban como `null` al RPC y la lectura de todas las conversaciones respondía 503. | Prueba HTTP firmada reproduce la falla con `GET /v1/conversations?limit=20`; el archivo rechazaba `accountId:null` como ID inválido. La API pública omitía esos filtros, pero el objeto del RPC los conservaba. | El worker interpreta null opcional como ausencia; se probó lista sin filtros y con filtros de canal/cuenta, además de las suites de archivo/API. |
| BUG-057 | P2 | Cerrado F3.1: la búsqueda de nombres no coincidía si el operador escribía distinta capitalización. | Regresión HTTP `search=ana` no encontraba el nombre visible `Ana`; la expresión se construía sensible a caja. | Búsqueda Unicode insensible a caja devuelve el contacto correcto, sin buscar texto del mensaje ni exponer identidades. Prueba F3.1. |
| BUG-058 | P2 | Cerrado F4.1: el primer typecheck de la nueva bandeja encontró un icono de ficha sin importar en `InboxPage`. | `UsersRound` se usaba en el panel contextual, pero no estaba en la importación de `lucide-react`; el check TS falló antes del build. | Import agregado; `panel:typecheck`, pruebas Vitest y build Vite pasan. Es un defecto de compilación de la fase actual, cerrado antes del commit F4.1. |
| BUG-059 | P2 | Cerrado F4.1: el check global de ESLint fallaba después de compilar la bandeja. | El lint recorría `panel/web/dist` y analizaba el bundle ES module como CommonJS; también detectó escapes innecesarios en la prueba de servido del build. | Se excluyó el artefacto generado y se simplificó la expresión de prueba. `npm run check` completo y build Docker de la fase pasan. |
| BUG-060 | P2 | Cerrado F4.1: el runner Node incluía el setup de Vitest como si fuera otra prueba del gateway. | La carpeta `panel/web/src/test` hizo que `node --test` descubriera `setup.ts`, que solo instala matchers y generaba un warning de formato ESM. | El setup se movió a `src/vitestSetup.ts`; Vitest lo carga explícitamente y `node --test` deja de ejecutarlo como prueba. |
| BUG-061 | P2 | Cerrado F4.1: el build Docker fallaba al instalar paquetes detrás del CA de red de este entorno. | `npm ci` falló dentro de la imagen base con `Exit handler never called` a los 73 s, incluso serial; el host resuelve npm y confía en `NODE_EXTRA_CA_CERTS`, pero la imagen limpia no tiene ese CA. | El builder acepta un BuildKit secret opcional y lo asigna a `NODE_EXTRA_CA_CERTS` solo durante `npm ci`. Build se valida con TLS verificado y el cert no queda en capas ni en la imagen. |
| BUG-062 | P1 | Cerrado en unidad de seguridad después de F4.1: dependencias de medios transitivas de Baileys tenían avisos DoS/proceso-crash; `sharp@0.35.3` (high) y `music-metadata@11.14.0` (moderate). | `npm audit --omit=dev` y `npm ls` los ubicaron bajo `@whiskeysockets/baileys@7.0.0-rc14`; no los introdujo la UI. | `npm audit fix` movió solo el lockfile a `sharp@0.35.5` y `music-metadata@11.16.1` sin cambiar rangos directos. Auditoría completa y de producción limpias; suites y Docker verificadas. Evidencia: [DEPENDENCY-SECURITY-BUG-062](DEPENDENCY-SECURITY-BUG-062.md). |
| BUG-063 | P2 | Cerrado F4.2: reintentar una página con cursor vencido podía repetir el mismo 410 y dejar la lista sin salida. | Al rastrear los estados de paginación, la acción de error volvía a pedir `nextCursor`. | CURSOR_EXPIRED/DATA_EPOCH_MISMATCH ahora vuelven a leer la primera página; una prueba de UI simula 410 y verifica la recarga sin cursor. |
| BUG-064 | P2 | Cerrado durante la validación de PR #4: Gateway CI ejecutaba Vitest con Node 22.13 aunque `jsdom@30.1.3` requiere Node 22.22.2 y su `undici@8` no inicia en 22.13. | En la reejecución de Actions, Vitest no pudo iniciar el worker y `undici/lib/interceptor/decompress.js` lanzó `Cannot read properties of undefined (reading 'bind')`; los archivos de prueba no llegaron a ejecutarse. | Gateway CI usa Node 22.22.2/24; contratos conservan Node 22.13/24 y el mínimo del runtime no cambia. Lint, tipos, panel, SQLite, 269 pruebas y smoke pasan en Gateway con Node 22.22.2. |
| BUG-065 | P2 | Cerrado durante la validación de PR #4: una prueba de publicación durable dependía de que `setImmediate` cediera tiempo suficiente al worker. | Actions Node 24.22.0 falló 1/269 con `published=[]` tras el RPC; la notificación committedEvent llega en un mensaje distinto del worker. | La prueba espera la notificación real con timeout y usa un RPC posterior como barrera antes de comprobar el silencio de duplicados. Las 269 pruebas pasan en Node 24.22.0. |
| BUG-066 | P2 | Abierto: la primera ejecución de CI en una PR generada por Release Please puede quedar `action_required` con 0 jobs y exigir reejecución manual. | Run 39418373438: intento 1 terminó `action_required` sin jobs; intento 2 manual pasó los cinco jobs y dejó la PR #2 limpia. El actor fue `github-actions[bot]`, el flujo usa `GITHUB_TOKEN` y no hay aprobaciones pendientes. La conexión actual no permite inspeccionar secretos. | Si no existe, configurar `RELEASE_PLEASE_TOKEN` como PAT/GitHub App token limitado al repo; verificar que una futura PR de Release Please ejecute sus cinco jobs al primer intento. Cambio preventivo en PR #5. |
| BUG-067 | P2 | Cerrado en el seguimiento del release de F4.2: Release Please recibía `draft`, parámetro que la acción no acepta, y emitía una advertencia en cada ejecución. | Run 39417735553 advierte `Unexpected input(s) 'draft'`; la acción v4 acepta `token`, `config-file` y `manifest-file`, entre otros. `draft: true` era válido en la configuración del paquete. | Se eliminó el input inválido de la acción. BUG-069 registra la decisión posterior de publicar el release al fusionar su PR. |
| BUG-068 | P2 | Cerrado: cada merge ejecutaba CI en la PR y otra vez en `main`; además, el deploy automático seguía esperando un runner Homelab retirado. | PR #5 tuvo CI en PR (39419195197) y en `main` (39419533797); PR #2 repitió CI en PR (39419585612) y en `main` (39419950921). Deploy 39420078908 quedó en cola sobre `self-hosted`. | CI corre en PRs hacia `main` y permite ejecución manual; se quitó el trigger `push` de `main` y el workflow de deploy. Release Please conserva su trigger `push` para actualizar releases. |
| BUG-069 | P2 | Abierto: al fusionar release PR #6, Release Please dejó v0.4.0 como borrador sin tag y abrió PR #8 v0.5.0 repitiendo el changelog completo. | Run 39476647006 reporta `Expected 1 releases, only found 0` y busca `v0.4.0`; Releases API muestra v0.4.0 como draft y PR #6/#8 añaden los mismos 153 renglones de CHANGELOG.md. | Publicar automáticamente el release/tag tras aprobar y fusionar su PR (`draft: false`); validar en la siguiente ejecución que Release Please reconoce el tag y no vuelve a incluir el historial previo. Publicar/limpiar el borrador v0.4.0 y PR #8 existentes requiere reconciliación aparte. |
| BUG-070 | P2 | Cerrado F4.3: el replay de más de 50 mensajes tras una desconexión podía dejar un hueco visible entre mensajes recientes e historial en caché. | La UI solo consultaba la página más reciente de 50 mensajes; el snapshot anterior quedaba más atrás. | F4.3 pagina el replay hasta solapar el snapshot cargado. Pruebas verifican 51 mensajes, ancla estable y un segundo evento durante un fetch activo. CI 39485451344, head del PR a390c71 (código f7c3acc). |
| BUG-071 | P2 | **Cerrado:** `/ignorar contactos de agenda` podía inflar el total con registros alias o controles ya ignorados. | El camino SQLite cuenta conversationId distintos y solo suma transiciones efectivas a `addedCount`; el total incluye conversaciones únicas que quedan ignoradas. | Archivo SQLite real: alias JID/LID, contacto previamente ignorado y segunda ejecución idempotente. Evidencia: [BUG-071](BUG-071-RESUMEN-IGNORAR-AGENDA.md). |
| BUG-072 | P2 | Abierto: `/telegram/test` envía una sonda de configuración directamente por Bot API, fuera del outbox. | El endpoint debe poder probar un token borrador antes de que el adaptador dueño de esa cuenta se conecte; un timeout y un segundo click pueden duplicar el mensaje de prueba. | F6 o antes de exponer el test a reintentos automáticos: probar token/cuenta con el adaptador común cuando esté activo, y mantener sonda de token borrador con clave durable o confirmar su entrega incierta. No bloquea salidas de conversaciones ni avisos del gateway. |
| BUG-073 | P2 | **Cerrado F5.8:** el eco propio de WhatsApp podía marcarse como salida humana si el ACK tardaba más de 500 ms. | La observación queda pendiente mientras exista un envío local `sending` al mismo destino; consulta el ID aceptado o agota la ventana acotada de 5 s. | Pruebas cubren ACK a más de 500 ms, salida externa y timeout de la ventana. Evidencia: [BUG-073](BUG-073-ECO-WHATSAPP-ACK-LENTO.md). |
| BUG-074 | P2 | **Cerrado 2026-10-22:** respuestas durables de `generations` en Brain ya tienen retención y límite de payload activo. | Brain conserva el borrador 7 días, convierte la expiración en tombstone y lo mantiene 30 días más; el replay expirado devuelve 409 sin llamar al proveedor. | Máximo de 64 KiB por respuesta y 5000 respuestas activas; al llegar al cupo no se llama al proveedor. Barrido al inicio, cada hora y antes de acceder al ledger; `secure_delete`, checkpoint WAL y VACUUM periódico limpian páginas. Ruff y 39 pruebas Brain pasan, incluyendo replay dentro/fuera de ventana y poda. Evidencia: [BUG-074](BUG-074-GENERATION-RETENTION.md). |
| BUG-075 | P2 | **Cerrado 2026-10-22:** salidas `delivery_unknown` de IA/operador tienen consulta autenticada, decisión auditada y panel de conciliación sin reenvío. | La API expone solo la conversación del actor y no incluye idempotency key ni resultado crudo. `accepted` exige ID remoto, valida texto contra eco archivado cuando existe y materializa autoría antes de mover watermark; `rejected` deja entradas sin atender para nueva selección. Conflicto de owner devuelve 409. | Gateway cubre éxito, rechazo, mismatch, permisos/owner y no envío; UI cubre rechazo con nota y comprueba una sola llamada de envío. `future_only` no cambia; `process_pending` permanece bloqueado hasta resolver. Evidencia: [BUG-075](BUG-075-OUTBOUND-RECONCILIATION.md). Sin canal/proveedor real. |
| BUG-076 | P2 | **Cerrado 2026-10-22:** `process_pending` conserva los nombres de origen disponibles. | SQLite v16 mantiene `pushName`/`savedName` aparte del sobre de ruta hasta 24 h desde `ingested_at`; no guarda en esa columna teléfono, JID, LID ni otros metadatos. La identidad de replay sigue derivándose del archivo. | Migración v15 backfillea solo filas recientes aún pending/waiting; purga al iniciar, cada minuto, al consultar/liberar y al omitir. F6.3 integrado confirma nombres, contexto y perfil sin aceptar identificadores de ruta. Evidencia: [BUG-076](BUG-076-RESUME-METADATA.md). |
| BUG-077 | P1 | Cerrado F6.3: importación/cutover del control rechazaba archivos SQLite v10. | El flujo integrado creó reporte y snapshot con schemaVersion 10, pero `buildControlImportReport` y `beginControlImport` solo permitían hasta v9; la aceptación se detenía antes del cutover. | Ambos validadores aceptan v10. El flujo integrado F6.3 completa el cutover y el resto del recorrido; pruebas enfocadas de importación pasan. Evidencia: [F6.3](F6.3-FLUJO-CONVERSACION.md). |
| BUG-078 | P2 | Cerrado F6.3: intents de salida que quedaban en `sending` tras un crash no se recuperaban al iniciar una base ya migrada a v10. | La transición a `delivery_unknown` se ejecutaba solo durante la migración v9→v10; el siguiente reinicio de una base v10 dejaba el intent bloqueado en `sending`. | La recuperación se ejecuta al iniciar después de aplicar migraciones, para cualquier esquema actual. La prueba de reinicio verifica que pasa a `delivery_unknown` y exige conciliación explícita, sin reintentar el envío. Evidencia: [F6.3](F6.3-FLUJO-CONVERSACION.md). |
| BUG-079 | P1 | **Cerrado 2026-10-22:** el outbox retenía payload, destino y respuesta del proveedor indefinidamente. | SQLite v17 agrega huella de payload/redacción. Los intents sin iniciar vencen a 24 h; contenido/destino/resultado/control se redactan después de 90 días; terminales se purgan después de 180 y los inciertos conservan un tombstone no reejecutable hasta conciliación. El checkpoint incluye las filas completas. | `outboundIntent.test.js`: frontera 90/180 días, 410 sin reenvío, conflicto con payload distinto, protección/reconciliación de `delivery_unknown`, expiración antes del claim y migración v16→v17. Evidencia: [BUG-079](BUG-079-RETENCION-OUTBOX.md). |
| BUG-080 | P2 | **Cerrado 2026-10-22:** recibos de takeover, cortes/importaciones, cursores y cuarentenas ya tienen una política explícita. | La purga elimina recibos `completed`/`failed` a los 180 días desde su cierre (fallback a `created_at`); `taking_control` nunca vence automáticamente. Importaciones/snapshots de rollback, cursores monotónicos y cuarentenas sin resolver se conservan porque no existe un flujo seguro de poda/revisión. F8.4 compara los cuatro ledgers y bloquea divergencias sin exponer huellas. | `conversationRecovery.test.js`: límite exacto +1 ms, takeover pendiente conservado, metadatos antiguos preservados y cuatro bloqueos independientes de restore sin hashes. `cd apps/gateway && npm run check`; evidencia: [BUG-080](BUG-080-RETENCION-METADATOS.md). |

## Revisión previa a F7 — 2026-10-21

- F6.4 tiene evidencia parcial: captura WA inbound una vez; el takeover local
  devolvió `CONTROL_AUTHORITY_NOT_ACTIVE` porque el runtime conserva autoridad
  `legacy`. El contacto de prueba volvió a `neutro` y `ignored_all` no cambió. No
  iniciar F7 hasta completar el corte verificado y el smoke restante. El dry-run
  live inicial bloqueó el corte: 43/1007 registros importables, 962 sin destino
  exacto y 2 identidades ambiguas. Se añadió `--exclude-no-conversation` y una
  segunda ejecución clasificó explícitamente los 962 contactos sin destino como
  excluidos; siguen 2 ambigüedades teléfono/LID. No se aplicó staging ni corte;
  resolver ambas parejas explícitamente antes de reintentar. Evidencia:
  [F6.4](F6.4-SMOKE-CANAL.md) y [F5.3](F5.3-STAGING-CUTOVER.md).
- Antes de implementar contactos con operadores limitados, cerrar BUG-024 o dejar
  explícito que el primer alcance de F7 sigue siendo solo administrador.
- Antes de declarar paridad de comandos Telegram, resolver BUG-008 (resolución
  exacta en el camino legacy); BUG-046 ya se cerró en F2C.3. BUG-010/011 ya
  cierran sus fallos locales de salida/control legacy. Telegram sigue como canal
  administrativo y no se afirma aceptación de atención a clientes por ese canal.
- BUG-035 ya cierra la carrera async de pairing; la aceptación real de proveedor
  sigue sin probarse. No agregar reintentos automáticos al test de token mientras
  BUG-072 siga abierto. BUG-075 entra en F7
  solo si se expone conciliación de `delivery_unknown`; BUG-076 antes de exigir
  paridad de contexto para replays antiguos.
- BUG-006/007 ya están cerrados con evidencia F5.5/F5.7/F5.8; se corrigió su estado
  en esta revisión. BUG-074 se cerró con retención, límites y replay sin proveedor;
  los pendientes de CI/release quedan registrados para sus alcances. BUG-051 sigue
  siendo puerta antes de migrar un archivo runtime preexistente.
- Actualización 2026-10-22: F6.4 quedó completada con el recorrido live de
  WhatsApp, la revisión de contexto por traza de código y la regresión integrada
  F6.3 (1/1). No se conservó el cuerpo JSON literal de la petición live. Telegram
  de atención a clientes se excluye del alcance acordado; las identidades ambiguas
  siguen en cuarentena. Ver [F6.4](F6.4-SMOKE-CANAL.md).

## Clasificación para la unidad activa

F2C.1 cierra BUG-004/038/039/040/041/042. Evidencia en
[TELEGRAM-DUENO-UNICO-F2C1](TELEGRAM-DUENO-UNICO-F2C1.md). F2C.2 cierra
BUG-005/009/044/047 y la porción de archivo Telegram de BUG-008. La resolución
legacy de BUG-008 se cerró después con identidad completa y rechazo de parciales;
ver [evidencia](BUG-008-RESOLUCION-IDENTIDAD-LEGACY.md). F2D cierra BUG-045 para captura→handler. F2E.1 cierra
BUG-052/053/054 para respuestas aceptadas/eco; F2E.2 cierra BUG-055 y acota el log
reciente; F3 debe detectar cursores expirados; BUG-046 ya está cerrado en F2C.3.
BUG-043 está cerrado; BUG-050 sigue P1/F5; BUG-051 es puerta antes de migrar
un archivo preexistente. BUG-010 quedó cerrado después con deadlines para las
salidas legacy Telegram; ver [evidencia](BUG-010-TIMEOUTS-SALIDA-TELEGRAM.md).
F2B.3 conserva BUG-033/034/036/037 cerrados; BUG-037 valida cancelación HTTP local,
sin convertirla en aceptación live de proveedor/STT.
BUG-035 async pairing queda cerrado; aceptación real sigue pendiente. F3.1 cierra
BUG-056/057. BUG-024 sigue antes de
operadores limitados; BUG-014 antes de Python paralelo. F3.2 implementa replay SSE
y `resync.required` para cursores expirados sin retener el archivo sin límite. F4.1
cierra BUG-058/059/060 de UI y BUG-061 de instalación Docker detrás de CA. La
unidad de seguridad cerró BUG-062; F4.2 cierra BUG-063 al recuperar cursores de
lista vencidos. BUG-064 corrige el mínimo Node de las pruebas del panel en Gateway
CI y BUG-065 elimina una carrera en la prueba del evento durable. El perfil de carga completo
requiere repetición con 2 CPU/4 GiB;
el host medido tenía 3 CPU/10,45 GiB. No extrapolar archivo/polling a control, roles, salida durable
ni carga/aceptación completa F2.

F5.7/F5.8 implementan el contexto explícito y pasan aceptación integrada sintética.
BUG-073 y BUG-074 están cerrados con pruebas locales; los cierres no se basan en
canales ni archivos runtime.

## Cerrados

- **BUG-004/038–042 — F2C.1:** descubrimiento por observación del owner, ciclo HTTP
  sin solapamiento local, cursor RAM separado al cambiar token, backoff/4xx,
  setup parcial y UTF-8 fragmentado. Reproducciones de 42b8321; 233 tests gateway
  Node22/24 y 97 sobre dependencias Docker offline. Commit:
  `git log --grep="close F2C.1"`. [Evidencia](TELEGRAM-DUENO-UNICO-F2C1.md).

- **BUG-005/009/044 — F2C.2:** cursor e ingreso Telegram son atómicos por bot,
  IDs JSON conservan precisión, el filtro global por ID se elimina y la descarga
  STT se limita por bytes. Migración/reapertura, rollback/redelivery, namespace de
  mensajes y audio excesivo se prueban con fixtures. [Evidencia](TELEGRAM-CAPTURA-F2C2.md).

- **BUG-047 — F2C.2:** una redelivery stale del chat admin ya no reejecuta el
  comando heredado; la regresión vuelve a entregar el mismo update tras el commit y
  confirma un único despacho. BUG-046 cierra después el crash gap con el inbox
  separado de [F2C.3](BUG-046-TELEGRAM-ADMIN-INBOX.md).

- **BUG-033/034/036 — F2B.3:** actualizaciones durables de STT, captions por tipo
  y trabajos acotados. Reproducción anterior, 218 tests gateway/15 contratos en
  Node22/24 y 72 tests en imagen nueva de producción sin red. Commit:
  `git log --grep="close F2B.3"`. [Evidencia y límites](MULTIMEDIA-WHATSAPP-F2B3.md).

- **BUG-001/002/003/032 — F2B.2:** lotes y cache live tras commit, guardas de
  socket/reconexión solapada. Reproducción del adapter previo con transporte falso
  y regresiones contra SQLite/entry real. Gateway 204 tests Node22/24 y 52 en
  dependencias Docker sin red. Commit: `git log --grep="close F2B.2"`.
  [Evidencia y límites](CAPTURA-WHATSAPP-F2B2.md).

- **BUG-029 — cerrado (P1, F2B.1):** preflight de gateway y brain rechaza servicio
  supervisado o inspección no verificable antes de señales/borrado. Procesos
  manuales se comprueban por entrada/inicio de PID y parada efectiva; cambios de
  lock/PID abortan. Reproducción del código anterior y 14 tests de guarda/CLI,
  incluido worker SQLite real temporal. No se paró ningún supervisor real.
- **BUG-031 — cerrado (P1, F2B.1):** brain publica el lock configurado, crea padre,
  falla si no puede escribirlo y solo elimina el propio. Dos tests nuevos, suite
  secuencial de 23 pasa. No cambia memoria/proveedores. Commit de ambos cierres:
  `git log --grep="close F2B.1"`. Evidencia y límites de supervisión/plataformas:
  [RESET-SEGURO-F2B1](RESET-SEGURO-F2B1.md).

- **BUG-026 — cerrado (P1, F2A):** prepareFactoryReset registrado por el gateway
  espera cierre del archivo en panel y self-chat, antes del borrado. Fallo aborta
  sin tocar DB; la nueva regresión de reset usa SQLite real en temporal. No se
  hizo un reset de usuario. Commit de unidad: `git log --grep=BUG-026`.
- **BUG-027 — cerrado (P2, F2A):** copia inmutable de argumentos al admitir RPC;
  test cambia referencia original antes del dispatch y comprueba texto persistido.
  Commit de unidad: `git log --grep=BUG-027`.
- **BUG-028 — cerrado (P1, F2A):** fingerprint canónico previo a normalización
  oversized; redelivery con diferente orden deduplica, textos originales distintos
  del mismo tamaño se reportan en cuarentena. `git log --grep=BUG-028`.
- **BUG-030 — cerrado (P1, F2A):** index ahora usa SDK_GATEWAY_LOCK_PATH y crea
  directorio padre; prueba de entry real dos arranques, PID correcto, apagado 0 y
  lock eliminado. Reproducción anterior en evidencia de F2A. `git log --grep=BUG-030`.

Evidencia de estos cierres: [ARCHIVO-CONVERSACIONES-F2A](ARCHIVO-CONVERSACIONES-F2A.md).
BUG-016, cerrado en diseño F0.3, ahora tiene ejecución JID/LID contra repositorio
SQLite real en F2A; falta captura de aliases live antes de cerrar F2 completa.

- **BUG-025 — cerrado (P1, F1B):** Docker copiaba gateway completo y .dockerignore
  no excluía panel/.env, pudiendo incluir credenciales OAuth/cookie/servicio en la
  imagen. Inspección de COPY y exclusiones; se añadió gateway/panel/.env.
  Verificación con canary ficticio de build, sin archivos de usuario. Evidencia
  de exclusión en imagen en FRONTERA-AUTENTICADA-V1. Commit F1B:
  `git log --grep=BUG-025`.

- **BUG-013 — cerrado (P1, F1B):** /history estaba exento de API key. Se retiró la
  exención y se sustituyó la prueba que la exigía por lectura de contenido real
  con credencial y 401 sin/con clave incorrecta; / y /health continúan públicos.
  Ruff y 21 tests brain pasan en copia temporal, sin llamadas IA. Commit F1B:
  `git log --grep=BUG-013`. Evidencia: [FRONTERA-AUTENTICADA-V1](FRONTERA-AUTENTICADA-V1.md).

- **BUG-019 — cerrado (P2, F1B):** decodeURIComponent de cookie y parseo de Referer
  estaban fuera de try; datos dañados lanzaban excepción. Reproducido contra panel
  de f0d2b13. Ahora cookie inválida devuelve 401 y Referer inválido deniega origen.
  La cookie se busca por nombre exacto y se comprueba expiración finita. Regresiones
  panelBoundary pasan. Commit F1B: `git log --grep=BUG-019`.

- **BUG-020 — cerrado (P1, F1B):** OAuth aceptaba userinfo sin verificar ID estable,
  HTTP OK ni correo verificado; requests sin timeout y error crudo en respuesta.
  Versión anterior acepta fixture verified_email=false con 302/cookie. Ahora exige
  ID/correo confirmado, rechaza con 401, timeout explícito de 10s por fetch y error
  saneado. Test OAuth simulado valida rechazo/éxito/state de un uso, sin Google real.
  Commit F1B: `git log --grep=BUG-020`.

- **BUG-021 — cerrado (P1, F1B):** faltaban ';' entre cookieFlags y Expires/Max-Age;
  `Secure Expires=...` y `Secure Max-Age=0` no son atributos Secure válidos.
  Reproducido contra salida anterior; ahora se delimitan correctamente los atributos
  de login/logout. Regresión comprueba cookie HttpOnly/Lax/Path/Secure/Expires y
  logout Max-Age=0. Prueba HTTP Node, sin afirmar comportamiento de navegador real.
  Commit F1B: `git log --grep=BUG-021`.

- **BUG-022 — cerrado (P1, F1B):** request-target absoluto no perdía su host al
  reemplazar el prefijo /api; new URL lo usaba como upstream fuera del gateway.
  Reproducido: HTTP absolute-form al panel alcanza segundo servidor local.
  Reparación: usar pathname/query normalizados y permitir solo origen HTTP del
  gateway configurado en el proxy. Regresión alcanza interno y cero veces externo.
  Commit F1B: `git log --grep=BUG-022`.

- **BUG-023 — cerrado (P1, F1B):** producción/auth forzada sin OAuth caía al panel
  abierto; bus trataba red/loopback como autorización, incluso en bind expuesto.
  Ahora panel requerido sin credenciales devuelve 503; v1 no concede dev como
  fallback. Bus requiere firma en producción/bind no loopback y siempre para v1.
  Sin secreto solo persiste compatibilidad legacy de desarrollo en loopback.
  Test prueba ambas puertas y acceso local anterior. Compose exige secreto común.
  Commit F1B: `git log --grep=BUG-023`.

- **BUG-015 — cerrado (P2, F0.2):** el primer prototipo del experimento podía ocultar
  la excepción original con otra durante cleanup. Detectado por lint y corregido:
  errores agregados tras cerrar workers/temporales. Lint limpio; fallo simulado
  tras escribir conserva el error, termina con código 1 y no deja estado temporal,
  probado en Node 22.13.0 y 24.19.0. Evidencia: [SQLITE-SPIKE.md](SQLITE-SPIKE.md).
  Commit: `f69ac1d` (F0.2).

- **BUG-016 — cerrado en diseño (P1, F0.3):** la clave de deduplicación propuesta
  usaba rawChatId mientras el mismo hilo puede observarse por JID/LID. Un mismo
  providerMessageId con esos dos valores produciría dos claves. Reparación: usar
  canonicalIdentityId por cuenta, con aliases verificados y conflicto bloqueante;
  rawChatId queda como procedencia. ARCHITECTURE/ADR/SPEC alineados y escenario
  DEDUP-01 revisado (clave vieja distinta, clave canónica idéntica). No es una
  reparación de DB runtime: F2 debe ejecutar el caso contra captura/repositorio.
  Commit: cierre F0.3, identificado por `git log --grep=BUG-016`.

- **BUG-017 — cerrado (P2, F1A):** openapi-typescript convertía propiedades
  opcionales con default (overrideOwner/resumePolicy/limit) en obligatorias, mientras
  AJV aceptaba omitirlas. Reproducido con compilación de `{expectedVersion:'2'}`
  como ReleaseRequest. Reparación: defaultNonNullable=false; schema es autoridad,
  sin aplicar defaults ni mutar input. Regresión TS positiva de omisión y pruebas
  runtime con objetos congelados. Se ensayó reactivar la opción: typecheck falla;
  también se comprobó que --check rechaza un artefacto alterado. Evidencia:
  [CONTRATOS-V1.md](CONTRATOS-V1.md). Commit F1A: `git log --grep=BUG-017`.

- **BUG-018 — cerrado (P2, F1A):** el validador compartido de bytes dependía del
  global Buffer de Node y fallaba al faltar ese global, lo que impediría consumirlo
  en el frontend previsto. Reproducido: OutgoingText lanza TypeError en vez de
  validar. Reparación: TextEncoder estándar. Regresión sin Buffer acepta el límite
  Unicode y rechaza exceso UTF8. Es simulación del global ausente en Node, no prueba
  de bundle/navegador; esa integración sigue en F4. Evidencia:
  [CONTRATOS-V1.md](CONTRATOS-V1.md). Commit F1A: `git log --grep=BUG-018`.

BUG-005/009/012/043/044/045/047/050/052/053/054/055 están cerrados. Los pendientes
activos se limitan a BUG-051 (revisión de un archivo preexistente real), BUG-066 y
BUG-069 (reconciliación CI/release con GitHub) y BUG-072 (sonda administrativa
Telegram, no bloqueante para atención al cliente). La carga F2E.2 pasó con el perfil
limitado Linux x64 de 2 CPU/4 GiB; no prueba hardware físico equivalente ni
Windows/Termux. Checks verdes no demuestran escenarios fuera de su alcance.

## Cierre F2E.2 — Repetición bajo 2 CPU/4 GiB — 2026-10-22

- El ensayo completo bajo cgroup v2 terminó en el commit ejecutado
  `949c22f6f2396069a34f28b3e86306d548840bce`, con 2 CPU, 4 GiB y swap desactivado.
  Importó 1M mensajes a 1.249 msg/s y completó dos calentamientos, tres mediciones
  de 150 s, validación SQLite y saturación.
- Los tres runs medidos tuvieron cero fallos y cumplieron latencias, event loop p99
  y RSS (máximo 430 MiB). Saturación rechazó 100 de 1.100 consultas y 131 de 800
  solicitudes por bytes, sin adelantar cursor TG ni crear mensajes.
- El scope tocó el máximo de 4 GiB (`memory.events max=2230`, `oom=0`, `oom_kill=0`);
  el límite de memoria y la presión quedan explícitos en la evidencia. No se probó
  hardware físico equivalente, Windows/Termux, canales reales ni datos de usuario.
- Informe: [F2E2-CARGA-COMPLETA](F2E2-CARGA-COMPLETA.md) y
  [resultados por run](../apps/gateway/docs/evidence/F2E2-load-report-2cpu4g-20261022.json).
- Verificación: `cd apps/gateway && npm run check` (lint/typecheck limpios,
  Panel 44/44, build servido 1/1, Gateway 400/400) y `git diff --check` limpio.
  Fase 2 cerrada para el perfil medido; el trabajo queda en un commit local, sin push.
