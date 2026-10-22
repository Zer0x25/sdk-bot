# BUG-072 — Sonda de configuración Telegram

Fecha de cierre: 2026-10-22.

## Cambio

- Si el token pertenece al adaptador Telegram activo, `/telegram/test` entrega la
  prueba mediante `TelegramAdapter.sendMessage`, el puerto de salida común y su
  outbox. La respuesta informa aceptación y conserva la clave de idempotencia.
- Se mantiene la sonda directa para un token borrador que todavía no tiene un
  adaptador dueño. Un error de transporte después de iniciar el envío se devuelve
  como `delivery: unknown`, con destino y clave, sin reintento automático.
- El panel conserva la clave pendiente en `localStorage` sin guardar el token,
  avisa que el mensaje pudo llegar y pide confirmación antes de crear otro envío.
  La clave se localiza aunque el Chat ID descubierto aún no se haya guardado y se
  borra cuando el resultado queda resuelto.
- Esta sonda configura el bot administrativo; no prueba atención a clientes por
  Telegram ni genera tráfico real durante las pruebas.

## Verificación

- Pruebas focales: `node --test tests/telegram.test.js tests/telegramOwnership.test.js
  tests/telegramSetup.test.js` — 27/27. La selección del sender activo y la
  respuesta ambigua pasan por la ruta HTTP simulada; `outboundIntent.test.js`
  cubre persistencia, replay aceptado y tombstone del puerto común.
- Gateway: `npm run check` — ESLint y TypeScript limpios; Panel 44/44, build y
  servido 1/1; Gateway 403/403.
- `git diff --check` limpio. Las llamadas de Bot API usan transportes simulados;
  no se envió ningún mensaje ni se usaron credenciales reales.
