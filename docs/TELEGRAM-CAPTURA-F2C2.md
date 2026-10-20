# Captura Telegram y cursor durable por bot — F2C.2

Fecha: 2026-10-20. Esta unidad completa la captura base de Telegram y el ACK
durable del polling. F2C.2 no habilitó la bandeja/API de historial ni el control
humano; F2D añadió después el replay durable al handler legacy.

## Identidad de cuenta y cursor

Antes de consultar updates, el adapter valida `getMe` (`ok` y `is_bot`) y usa el
ID decimal del bot como `telegram_bot:<id>` en `accounts`. El token no forma parte
de la clave ni se copia a SQLite. Rotar el token del mismo bot conserva el cursor;
otro bot obtiene una cuenta y cursor independientes. La migración `user_version`
1 → 2 crea `telegram_cursors`, ligado por foreign key a una cuenta Telegram.

El helper HTTP conserva como strings los tokens JSON enteros no seguros para
`Number`, por lo que `update_id`, `message_id` y `chat.id` no se redondean. Se
validan como decimales canónicos, incluyendo chats negativos. La primera consulta
usa offset `0`; después de una captura confirmada se usa `last_update_id + 1`,
calculado con `BigInt` y enviado como texto.

## Admisión atómica

Se limitan las respuestas a 100 updates y 32 MiB normalizados antes de pasarlos
al archivo. Los mensajes de chats privados se normalizan con identidad exacta
`(cuenta del bot, telegram_chat_id)` y `message_id` del proveedor. Una única
transacción del worker inserta cada mensaje admitido, su huella/procedencia,
proyección y evento; después actualiza el cursor del lote. Lotes inválidos o un
fallo de persistencia hacen rollback de todos esos cambios. El adapter no calcula
el próximo offset hasta recibir la respuesta del worker; una redelivery menor o
igual al cursor se trata como stale. No hay retry automático de escrituras cuyo
resultado pudo ser incierto.

Administración, grupos, callbacks y updates sin mensaje de cliente no entran al
historial de conversaciones, pero sí pueden avanzar el cursor en la misma
transacción. El handler administrativo heredado se ejecuta después de esa
confirmación. Una redelivery con `update_id` ya confirmado se salta para no repetir
el comando (BUG-047). La ventana del comando admin sigue registrada como BUG-046.
F2D añade una fila outbox en la transacción de captura y replay del mensaje de
cliente; los detalles y límites están en [REPLAY-LEGACY-F2D](REPLAY-LEGACY-F2D.md).

Los duplicados se resuelven dentro del namespace de cuenta/chat/ID del proveedor.
Así, dos chats pueden usar el mismo `message_id` sin filtrarse entre sí ni con el
registro global heredado de mensajes enviados. Un conflicto de contenido para la
misma huella sigue la cuarentena existente.

## Contenido y estado visible

Texto y captions conservan su contenido; audio, imagen, video, documento y otros
updates admitidos conservan un marcador de tipo. El adjunto binario no forma
parte de esta captura. Para audio con STT habilitado, el mensaje se archiva antes
de descargarlo; el resultado `pending/completed/failed` actualiza el mismo ID y
emite `message.updated`. La descarga Telegram acumula bytes por stream hasta
`STT_MAX_UPLOAD_BYTES`; contenido mayor no llega al transcriptor y deja estado
`failed`. Se cubre BUG-044, descubierto durante esta unidad.

Los fallos de identidad, normalización o archivo detienen el polling en un estado
visible y no avanzan el cursor. El panel expone las razones de detención añadidas
para archivo/captura/respuesta inválida.

## Bugs y límites

- Cerrados: BUG-005 (precisión y ACK durable), BUG-009 (filtro global por
  `message_id`), BUG-044 (descarga de audio sin límite) y BUG-047 (redelivery
  stale de comando admin).
- BUG-008 queda cerrado solo para la identidad archivada de Telegram: signo y
  namespace exactos. La resolución legacy por dígitos continúa abierta.
- BUG-045 queda cerrado por F2D para el corte commit→pipeline; los efectos de
  salida con resultado ambiguo siguen BUG-050/F5.
- BUG-046 deja pendiente la recepción durable/idempotente de comandos admin antes
  de confirmar el cursor. No se promete ejecución exactly-once de comandos.
- Bot API no ofrece importar un historial arbitrario anterior al polling retenido.
  Esta unidad no migra conversaciones anteriores ni reconcilia salidas humanas/IA.
- No hubo cuenta real, llamadas a Telegram, STT real, aceptación visual en
  navegador, carga de un millón de mensajes, ni pruebas de Windows/Termux.

## Verificación

Pruebas enfocadas en `telegramCapture.test.js`, `telegramHttp.test.js`,
`telegramOwnership.test.js`, `telegram.test.js` y `conversationArchive.test.js`
cubren migración, reapertura, offset durable, IDs inseguros, rollback de lote,
redelivery, IDs de mensajes repetidos en chats distintos, exclusiones y límite de
audio, además de repetir un comando admin stale y verificar un solo despacho. La
suite `gateway npm run check` pasa lint/tipos y 242 pruebas en Node 24.19.0 y
22.13.0. La imagen de producción cacheada `sdkbot-f2b3:local` también ejecuta las
242 pruebas en Node 22.23.3 con `--network none` y el árbol versionado completo;
no se reconstruyó imagen ni se ejecutó Compose. La primera invocación Docker omitió
los perfiles versionados de `brain/` requeridos por tres pruebas de reset; al repetir
con el snapshot completo pasan. No se usó estado local, credenciales, proveedores,
canales reales, STT real ni aceptación de carga. Las limitaciones y próxima tarea
están en [`SESSION-STATE.md`](SESSION-STATE.md) y en el commit de esta unidad.
