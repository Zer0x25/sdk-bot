# Replay durable al pipeline legacy — F2D

Fecha: 2026-10-20. Esta unidad cierra el hueco de BUG-045 entre guardar una
captura y despertar el pipeline legacy. El outbox de captura no es el outbox de
salida/control previsto para F5.

## Registro transaccional

La migración SQLite v3 agrega `legacy_dispatch`, una fila por mensaje capturado
que puede entrar al pipeline: mensaje de cliente, individual/privado, live, con
texto o caption válido. WhatsApp inserta esa fila dentro del mismo batch de
ingestión; Telegram la confirma junto con mensaje, evento, proyección y cursor.
Historia, duplicados, ecos propios, grupos, admin, contenido oversized y mensajes
sin texto no se despachan. Solo se persisten en el sobre los campos normalizados
necesarios para reconstruir `StandardMessage`; no se conserva el objeto crudo del
proveedor en el outbox.

Los estados son `pending`, `waiting`, `dispatched` y `skipped`. Audio con STT
habilitado se conserva en `waiting` hasta `message.updated`: una transcripción
completada lo promueve a `pending`; una fallida lo omite. El pump consulta filas
pendientes después de que el canal abre y cada evento de adapter solo lo despierta.
Por tanto, una caída tras el commit y antes de emitir el evento no requiere una
redelivery del proveedor. El ACK terminal borra el sobre duplicado; el mensaje
archivado mantiene su propia retención de 90 días y la fila de entrega cae con él.

El pump serializa el consumo, limita cada lectura a 100 filas, espera a que el
canal esté conectado y registra intentos/códigos acotados ante error. Mensajes que
la rama respond agrega al debounce mantienen su fila pendiente hasta que termine
`processAIChat`; las ramas síncronas confirman al completar el handler. Admin de
Telegram sigue fuera del archivo/outbox y conserva BUG-046.

## Garantía y límites

La prueba de caída cubre el punto exacto posterior al commit y anterior a cualquier
llamada al handler: al reabrir, el mensaje se entrega una vez; después del ACK, otra
reapertura no lo vuelve a entregar. Un error del handler deja la fila pendiente y
se reintenta con backoff: la entrega es **at-least-once**, no exactly-once ante un
efecto externo cuyo resultado sea incierto. BUG-050 deja para F5 el ledger de
intenciones y la idempotencia de salidas humanas/IA. El inbox durable de comandos
admin es BUG-046.

La migración v2→v3 no puede saber si mensajes anteriores ya llegaron al handler;
por eso no los reencola a ciegas. Este repositorio aún no ha migrado un archivo de
conversaciones real. Antes de desplegar F2D sobre un archivo preexistente con
usuarios, se necesita una reconciliación explícita de esas filas antiguas
(BUG-051).

## Verificación

`gateway/tests/legacyDispatch.test.js` reproduce reinicio antes del wake del pump,
reapertura, ACK persistente, ausencia de doble entrega después del ACK, gating por
conexión, reintento de handler, ACK diferido de debounce/IA, espera/promoción o
descarte de transcripción y migración v2→v3 sin auto-replay histórico. Las pruebas
Telegram y WhatsApp también cubren que solo el ingreso live elegible cree filas
outbox, y que history, duplicates y oversized no habiliten automatización.

El replay F2D cubre ingresos que forman parte del historial de clientes. El chat
administrativo Telegram usa el inbox separado de F2C.3 y su semántica conservadora
de reclamo/resultado incierto; no se mezcla con `legacy_dispatch`. Véase
[BUG-046](BUG-046-TELEGRAM-ADMIN-INBOX.md).
