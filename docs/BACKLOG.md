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
| BUG-006 | P1 | Handoff/pausa no cancelan jobs admitidos ni protegen cada globo; cola puede responder después del cambio. | Debounce, processAIChat y flush sin validación final de control. | F5: takeover durante debounce/pool/generación/typing/globos bloquea nuevos despachos y sobrevive reinicio. |
| BUG-007 | P1 | Respuesta generada se guarda en memoria antes de entregarse; cancelación/fallo/retry puede producir contexto fantasma. | brain /chat llama append_exchange antes de devolver; gateway puede reintentar POST. | F5: generación cancelada o entrega parcial solo confirma contexto de lo realmente enviado. |
| BUG-008 | P1 | Parcial: F2C.2 cierra el namespace archivado TG, pero la resolución legacy aún usa dígitos/substrings e índices sin cuenta/canal. | `telegram_chat_id` conserva signo y se captura bajo cuenta verificada; stateService/findKeyByDigits siguen siendo la ruta legacy de comandos. | F2/F5 antes de mutaciones legacy: resolver identidades exactas por cuenta/canal; mismos sufijos en chats distintos no deben mutar otro contacto. |
| BUG-009 | P1 | Cerrado F2C.2: filtro global Telegram descartaba por `message_id` sin chat. | Se retiró el registro/filtro global del adapter; dedup usa cuenta, chat canónico y `message_id`. Regresión repite ID en dos chats y en el registro global heredado. | Evidencia: [TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md). |
| BUG-010 | P2 | Parcial: envíos/presencia/menú/helpers legacy TG aún sin timeout propio. Proxy F1B y poll/prueba de notificaciones F2C.1 acotados. | panel/proxy.js acotado; F2C.1 añade deadline/cancelación/cierre HTTP a poll y sendMessage de prueba, POST detenido con un intento. No generaliza al dispatcher/envíos legacy. | F5 envío: TG sin respuesta termina acotado; sin retry ciego de envío ambiguo. Evidencia F1B en FRONTERA-AUTENTICADA-V1. |
| BUG-011 | P2 | /humano rechaza un permitido en ignored_all; /ia establece neutro y puede dejarlo sin respuesta. | handlers/commands/chatControl.js, runHumano/runIa. | F5: control independiente de permisos; comandos legacy preservan elegibilidad o explican bloqueo. |
| BUG-012 | P2 | /notify conserva payload/socket legacy aunque activeSock recibe adapter; compatibilidad no comprobada. | internalBus /notify frente a index.setSock(whatsapp) y adapter.sendMessage. | F5: prueba del payload real; reconducir al puerto de envío común sin pérdida ni duplicados. |
| BUG-013 | P1 | Cerrado F1B: /history del brain eximía API key aunque contenía contexto privado. | main.require_api_key ya exige credencial; test_main verifica denegación y lectura autorizada. | 401 sin/con clave incorrecta, 200 con correcta; health público. Ver registro de cierre. |
| BUG-014 | P2 | Tests brain usan un nombre /tmp fijo y no cierran todas las conexiones al sustituirlas; ejecuciones simultáneas pueden interferir. | test_main.setup_module/teardown_module y test_memory._nueva_db. | Antes de paralelizar suites: tmp_path único y cierre explícito; dos ejecuciones no comparten DB. |
| BUG-024 | P1 | Grants v1 no limitan al administrador legacy: una sesión con solo lectura v1 conserva rutas de administración anteriores. | panel/index.js aplica grants solo al prefijo /api/v1; proxy legacy usa identidad técnica sin capacidades de chat y conserva autorización previa. Inspección; alcance explícito, sin operador limitado habilitado. | F3, antes de incorporar operadores limitados/exponer archivo con roles: denegar rutas legacy a sujetos sin autorización administrativa expresa; probar lectura v1 sin poder enviar comandos/reset ni consultar QR/logs privados. No bloquea la sesión v1 F1B sin archivo/mutaciones. |
| BUG-026 | P1 | Cerrado F2A: reset desde self-chat/panel podía borrar la nueva SQLite sin cerrar su worker. | Hook común prepareFactoryReset; test con DB real comprueba cierre antes de unlink y fallo sin borrado. | Reparado antes de activar archivo; detalle abajo. |
| BUG-027 | P2 | Cerrado F2A: RPC retenía referencias mutables mientras esperaba readiness, permitiendo cambiar payload después de admisión/presupuesto. | Copia JSON al admitir; regresión muta texto antes del dispatch y confirma contenido original. | Reparado en F2A; no usar objetos del caller como cola durable. |
| BUG-028 | P1 | Cerrado F2A: hash sensible al orden de propiedades y calculado sobre marcador oversized confundía contenidos diferentes del mismo tamaño. | Hash de contenido original con claves ordenadas; prueba redelivery con propiedades permutadas y conflicto de dos textos >64 KiB del mismo tamaño. | Reparado F2A antes de persistencia live. |
| BUG-029 | P1 | Cerrado F2B.1: CLI podía borrar tras matar un PID que systemd relanza; detector tampoco reconocía cgroups v2. | Reproducción de stopProcess de 37525a1 con supervisor falso deja vivo un reemplazo. Nueva guarda rechaza supervisión antes de señales/borrado y verifica parada manual. | 14 regresiones de guarda/CLI; cierre y límites en RESET-SEGURO-F2B1. |
| BUG-030 | P1 | Cerrado F2A: index ignoraba SDK_GATEWAY_LOCK_PATH aunque Compose/CLI/inventario lo usan; reset podía no encontrar el proceso vivo. | Smoke aislado reproduce ausencia del lock configurado antes del cambio; entry real ahora crea/borrar ese lock y conserva epoch tras reinicio. | Reparado para coherencia de rutas F2A; no cierra carrera de supervisor BUG-029. |
| BUG-031 | P1 | Cerrado F2B.1: brain ignoraba SDK_BRAIN_LOCK_PATH, ocultando el proceso al CLI con ruta configurada; errores de escritura del lock también se silenciaban. | Hijo Python verifica ruta/PID/remoción; ensure_singleton aborta si no puede publicar lock. | Reparado antes de captura live; dos regresiones, brain 23 tests pasan. Ver RESET-SEGURO-F2B1. |
| BUG-032 | P1 | Cerrado F2B.2: dos connect con loadAuth asíncrono podían instalar primero el socket nuevo y luego uno obsoleto. | Reproducción en 4bb4ec3 confirma sustitución; revisión monotónica de conexión descarta auth atrasado. | Test overlapping connect pasa; mismo commit de cierre F2B.2. |
| BUG-033 | P1 | Cerrado F2B.3: STT legacy no actualizaba el audio archivado. | Reproducción de 7d99f36 deja cinco audios not_requested tras terminar. Ahora se guarda pending/completed/failed y message.updated sobre el ID original antes de legacy. | Mismo ID/huella, redelivery JID/LID, fallo/exceso, purga sin recreación, restart y resultado incierto sin retry probados; MULTIMEDIA-WHATSAPP-F2B3. |
| BUG-034 | P2 | Cerrado F2B.3: caption se guardaba como texto perdiendo tipo de adjunto. | Reproducción de 7d99f36 confirma type=text. Caption opcional en contrato multimedia y normalización con wrappers; copia gateway refrescada. | Tipos/validadores Node22/24, captions literales, límite/oversized y dedup. Texto antiguo sigue legible; forma incompatible nueva se conserva en revisión, sin inventar el tipo perdido. |
| BUG-035 | P2 | Abierto: el solicitante de pairing invoca connect sin await y puede pedir código antes de terminar loadAuth/crear socket; refresh también pierde el Promise. | Inspección en index.js, setPairingCodeRequester y setQrRefresh. No se probó pairing real. | F8 antes de aceptación de pairing: prueba con auth suspendido espera socket y propaga fallo; mantener pairing activo sin segundo socket. No bloquea captura de cuenta ya autenticada. |
| BUG-036 | P1 | Cerrado F2B.3: audios live iniciaban descargas/STT sin límite propio y bufferizaban el adjunto completo antes de validar tamaño. | Reproducción anterior inicia cinco transcripciones bloqueadas simultáneas. Coordinador actual limita cuatro trabajos sin cola, deadline 150 s y acumulación por stream hasta límite de bytes. | Timeout/saturación y proveedor que ignora abort conservando su plaza, exceso de stream sin STT, captura no bloqueada y desconexión probados. No garantiza cancelación física de Baileys: BUG-037 separado. |
| BUG-037 | P2 | Abierto: Baileys 7.0.0-rc14 getHttpStream omite signal al llamar fetch; abort lógico no garantiza detener descarga física/handles del proveedor. | Reproducción con fetch sustituido y signal ya abortado confirma ausencia de signal, sin red. Inspección del pipe interno tampoco acredita destrucción del origen. | F8, antes de aceptar STT real: frontera/pin de descarga que preserve abort y timeout; HTTP local que no envía headers/body debe cerrar request/stream al cancelar/vencer, sin handles crecientes. No parchear fetch global/node_modules. No bloquea actualización durable offline F2B.3; resultados tardíos bloqueados y plazas conservadas hasta terminar el trabajo. |
| BUG-038 | P1 | Cerrado F2C.1: reconnect/disconnect invalidaban el loop pero dejaban vivo el request getUpdates anterior; audio tardío podía emitir con un ciclo/token sustituido. | Reproducción anterior deja A pendiente tras abrir B. Ciclo actual cancela y espera cierre local antes del siguiente; generación/token capturados y revalidados tras audio. | Connect superados, cierre demorado y STT suspendido probados, sin lectura solapada ni efecto tardío de entrada. No cierra dispatcher de salida BUG-043/F5. |
| BUG-039 | P1 | Cerrado F2C.1: cambiar token conservaba lastUpdateId del bot anterior, pudiendo confirmar updates de otra cuenta. | Reproducción anterior pasa offset 124 de A a B. Ahora cambia a 1 al cambiar token y conserva RAM al reconectar el mismo. | Prueba A=900, reconnect A=901, B=1. Cursor durable/identidad de cuenta y rotación del mismo bot siguen F2C.2; no se usa token como accountId. |
| BUG-040 | P2 | Cerrado F2C.1: errores JSON de Bot API no-auth relanzaban getUpdates sin backoff, también 4xx. | Reproducción anterior de 500 abre otra consulta inmediatamente. Ahora 4xx paran en standby visible y red/timeout/5xx esperan recuperación cancelable. | 401/404/409 y error 500/red/desconexión probados; sin bucle inmediato ni retry de envío. |
| BUG-041 | P2 | Cerrado F2C.1: setup Telegram parcial borraba token visible al recargar y bloqueaba Chat ID/prueba tras guardar sin ID. | VM del código anterior confirma token parcial vacío, Chat ID readOnly y botón Probar oculto. | VM actual recorre guardar token vacío de ID, recarga, descubrimiento, guardado explícito y desconexión; no es aceptación visual/navegador real. |
| BUG-042 | P2 | Cerrado F2C.1: concatenar cada chunk HTTP como string corrompía caracteres UTF-8 divididos entre chunks. | Reproducción anterior convierte emoji en reemplazos. requestJson acumula bytes y decodifica UTF-8 estricto una vez, con límite 8 MiB. | HTTP local con bytes separados, UTF-8/JSON inválidos y respuesta excesiva; error no entrega lote al adapter. |
| BUG-043 | P1 | Abierto: sendMessage legacy puede reintentar Markdown con this.token mutable y despachar el retry al bot reemplazante. | Inspección: callback de 400 llama recursivamente this.sendMessage, que vuelve a leer token. No reproducido con proveedor; no confundir guardas de entrada F2C.1 con salida. | F5 antes de cerrar dispatcher: capturar cuenta/token por intención y validar barrera antes de retry; respuesta 400 de A tras cambiar a B nunca llama sendMessage de B. Timeout/ambiguo sin retry ciego. |
| BUG-044 | P2 | Cerrado F2C.2: descarga Telegram de audio usaba arrayBuffer completo sin límite propio. | Descarga ahora lee por stream, corta al superar STT_MAX_UPLOAD_BYTES y marca failed el mismo mensaje; audio excesivo no invoca STT. | Regresión de stream sobre el límite, estado durable y cero llamadas STT; [TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md). |
| BUG-045 | P1 | Cerrado F2D: el mensaje podía quedar archivado con cursor avanzado y no llegar al pipeline legacy si el proceso caía entre commit y emisión. | SQLite v3 inserta `legacy_dispatch` en la transacción de captura. El pump reanuda pendientes al abrir el canal; la rama respond mantiene pendiente el ACK hasta completar debounce/IA. | Prueba cierra proceso después del commit y antes del wake, reinicia, entrega una vez, persiste ACK y no redespacha tras otra reapertura. Error de handler queda pendiente con backoff. Evidencia: [REPLAY-LEGACY-F2D](REPLAY-LEGACY-F2D.md). At-least-once ante efectos/ACK ambiguos queda BUG-050. |
| BUG-046 | P1 | Abierto: un update del chat admin no se archiva y confirma el cursor antes de ejecutar su comando heredado; una caída en esa ventana puede perder el comando. | `captureTelegramBatch` adelanta el cursor para update administrativo y el adapter emite el comando después del commit. A diferencia del mensaje cliente, no queda una fila de conversación para replay. | F5 antes de garantizar control por chat: inbox durable de comandos con identidad de update e idempotencia/resultado; probar reinicio antes y después del efecto, sin repetir mutaciones. |
| BUG-047 | P1 | Cerrado F2C.2: el adapter podía ejecutar dos veces un comando admin si recibía de nuevo un `update_id` ya confirmado. | La rama admin emitía aunque el archivo devolviera `stale`, mientras los mensajes cliente sí se filtraban por resultado. Regresión vuelve a entregar el mismo update tras el commit. | Solo se ejecutan comandos admin para updates no stale; repetición deja un único despacho. Evidencia en [TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md). El inbox durable/crash gap sigue en BUG-046. |
| BUG-050 | P1 | Abierto: si una rama del pipeline produce un efecto externo y el proceso cae/falla antes del ACK durable, el replay at-least-once puede repetir la salida. | El pump retiene el mensaje durante el procesamiento IA, pero no existe ledger/idempotency key compartido transaccionalmente con los envíos legacy; un timeout de proveedor puede dejar resultado ambiguo. | F5 antes de afirmar exactly-once de salida: intención/outbox con clave estable y reconciliación de resultado; fallar después del efecto y antes del ACK no vuelve a enviar, incluso tras reinicio. |
| BUG-051 | P2 | Abierto: filas de mensajes creadas antes de SQLite v3 no tienen recibo de entrega y no se pueden reencolar con seguridad. | La migración v2→v3 crea outbox vacío; el archivo no registra si el handler legacy ya vio cada mensaje antiguo. Reproducir todo puede duplicar conversaciones/respuestas. | Antes de desplegar sobre un archivo real: reporte de candidatos y reconciliación revisable que determine pendientes sin repetir efectos; fixture pre-v3 probado sin auto-replay ciego. No bloquea este repo mientras no migre archivos reales. |

## Clasificación para la unidad activa

F2C.1 cierra BUG-004/038/039/040/041/042. Evidencia en
[TELEGRAM-DUENO-UNICO-F2C1](TELEGRAM-DUENO-UNICO-F2C1.md). F2C.2 cierra
BUG-005/009/044/047 y la porción de archivo Telegram de BUG-008; BUG-008 conserva
la resolución legacy. F2D cierra BUG-045 para captura→handler; BUG-046/F5 mantiene
el inbox admin. BUG-043 y BUG-050 quedan P1/F5; BUG-051 es puerta antes de migrar
un archivo preexistente. BUG-010 sigue parcial.
F2B.3 conserva BUG-033/034/036 cerrados y BUG-037 P2/F8 antes de STT real.
BUG-035 pairing queda F8; BUG-024 antes de operadores limitados F3 y BUG-014 antes
de Python paralelo. No extrapolar archivo/polling a control, roles, salida durable
ni carga/aceptación completa F2.

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
  confirma un único despacho. No cierra el inbox durable de BUG-046.

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

BUG-005/009/044/045/047 están cerrados. BUG-006/007/008/010/011/012, BUG-014/024/
035/037/043/046/050/051 siguen abiertos o parciales según sus puertas. BUG-050 y
la carga/reconciliación restante siguen pendientes antes de completar F2; BUG-051
se vuelve puerta antes de usar un archivo preexistente real. Checks verdes no
demuestran los escenarios pendientes fuera de su alcance.
