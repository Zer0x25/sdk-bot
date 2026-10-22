# BUG-010 — Deadlines de salida Telegram

Fecha: 2026-10-22. Cierre local en `main`; sin push ni despliegue.

## Cambio

- El adapter acota `sendMessage` a 10 s por solicitud y presencia `sendChatAction`
  a 3 s. El helper legacy de mensajes y el registro del menú (`setMyCommands`)
  tienen un deadline de 8 s.
- Los tiempos pueden ajustarse con `TELEGRAM_SEND_TIMEOUT_MS`,
  `TELEGRAM_PRESENCE_TIMEOUT_MS` y `TELEGRAM_ADMIN_REQUEST_TIMEOUT_MS`.
- Un timeout de envío se devuelve como resultado incierto. El outbox lo guarda en
  `delivery_unknown`; reutilizar la misma clave no vuelve a llamar al proveedor.
  No se reintenta a ciegas. El único segundo POST existente sigue siendo la
  respuesta explícita HTTP 400 de Telegram por entidades Markdown; primero
  confirma que token/cuenta aún pertenecen a la misma sesión.
- Las respuestas HTTP se leen con límite de 8 MiB y UTF-8 estricto. Poll y test
  administrativo conservan sus deadlines existentes.

## Evidencia

- Transporte local bloqueado sin headers y con cuerpo incompleto: vence el
  deadline, se cierra el socket y se observa una sola solicitud.
- Adapter Telegram: el timeout marca el intent como `delivery_unknown`; un segundo
  intento con la misma clave no genera otra llamada. Presencia también vence.
- Helper de notificación y menú legacy: ambos terminan dentro del plazo y no
  repiten la solicitud.
- Pruebas focales Telegram HTTP/captura/servicio: 31/31; incluyen la regresión
  de estado durable del outbox ante timeout.
- `cd apps/gateway && npm run check`: lint y typecheck pasan; Panel 42/42, build
  Vite y servido del build 1/1; Gateway 381/381. `git diff --check` limpio.
- Sin proveedor ni canal real.
