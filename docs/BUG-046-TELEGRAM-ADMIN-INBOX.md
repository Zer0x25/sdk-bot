# BUG-046 — Inbox durable de administración Telegram

Fecha: 2026-10-22. Unidad F2C.3. Telegram se mantiene como canal administrativo;
los updates de administración no se incorporan al historial de clientes.

## Cambio

- SQLite v15 agrega `telegram_admin_inbox`, con clave primaria `(account_id,
  update_id)`, huella del mensaje normalizado, estado, intentos, resultado y
  timestamps. No se persiste el objeto crudo de Bot API ni el token.
- La captura de texto del chat admin y el cursor Telegram se confirman en la
  misma transacción. La normalización conserva únicamente el mensaje estándar y
  metadatos mínimos; el historial y los eventos de conversaciones de clientes
  permanecen sin cambios.
- Tras el commit, el adapter solo despierta el pump. Al conectar, el pump también
  busca pendientes. El pump reclama cada clave antes de llamar al pipeline
  existente (`handleIncomingMessage`); la clasificación entre comando y
  self-chat sigue en `messageHandler`.
- Un reclamo pendiente se ejecuta una vez y queda `completed` con un código de
  resultado. Al terminar, el texto se elimina y solo queda la huella. Si Gateway
  reinicia con una fila `processing`, se transforma en `uncertain`, se elimina
  el texto y no se vuelve a ejecutar automáticamente. Errores o ACK inciertos
  siguen la misma regla. El log informa la cantidad para revisión.
- Las huellas/recibos terminales se purgan después de 180 días; las filas
  pendientes se conservan hasta que el canal vuelva a estar disponible. El
  checkpoint de restauración incluye cantidad y digest del inbox, y bloquea una
  copia que no coincida con la fuente sin imprimir el digest.

## Garantía y límite

La fila del inbox y el cursor no se separan. Una caída después de la captura y
antes del reclamo permite reanudar el update. Una caída después del reclamo no
repite una mutación: el recibo pasa a `uncertain`. SQLite no puede hacer atómica
la transacción con los efectos de los comandos legacy; por eso, una caída entre
reclamo y efecto también puede dejar un comando sin ejecutar. Se debe revisar el
chat y el estado antes de volver a emitir manualmente un comando incierto. No se
afirma exactly-once para efectos externos.

## Verificación

- `tests/telegramAdminInbox.test.js`: captura atómica, reinicio antes del reclamo,
  reinicio tras el efecto y antes del ACK, ausencia de repetición e identidad de
  update inmutable.
- `tests/telegramCapture.test.js`: wake posterior al commit, sin entrega directa
  del admin por EventEmitter, redelivery stale y migración desde v1.
- `tests/conversationRecovery.test.js`: el restore-check rechaza deltas del inbox
  que no avanzan el cursor de eventos y mantiene oculto el digest.
- `npm run check` raíz: contratos 19/19. `cd apps/gateway && npm run check`:
  lint, typecheck, panel 42/42, build Vite, integración y Gateway 366/366;
  `git diff --check` limpio.
- No se conectó una cuenta real ni se cambió configuración/token Telegram.
