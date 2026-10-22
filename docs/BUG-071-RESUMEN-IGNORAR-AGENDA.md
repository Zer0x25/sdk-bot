# BUG-071 — Resumen de `/ignorar contactos de agenda`

Fecha: 2026-10-22. Cierre local en `main`; sin push ni despliegue.

## Cambio

- El resultado SQLite de `setNumberState` expone si la escritura cambió el
  control durable.
- El resumen cuenta conversaciones únicas por `conversationId`. `addedCount`
  incluye solo transiciones efectivas; `totalIgnored` cuenta las conversaciones
  únicas de agenda que quedan ignoradas, incluidas las que ya lo estaban.
- Contactos alias pueden ejecutar la resolución normal, pero no inflan el resumen
  al apuntar a la misma conversación.

## Evidencia

- Prueba con SQLite real y un alias LID vinculado a un JID: dos registros de
  agenda para la misma conversación cuentan una sola vez; una conversación ya
  ignorada no suma a `addedCount`; la segunda ejecución da `addedCount: 0` y
  conserva el total único.
- `cd apps/gateway && npm run check`: lint, typecheck, Panel 42/42, build Vite,
  servido del build 1/1 y Gateway 385/385. Tras retirar un import de test sin uso,
  lint, typecheck y prueba focal 1/1 volvieron a pasar. `git diff --check` limpio.
- Sin WhatsApp ni Telegram real.
