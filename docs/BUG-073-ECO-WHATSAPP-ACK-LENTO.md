# BUG-073 — Eco WhatsApp antes del ACK local

Fecha: 2026-10-22. Cierre local en `main`; sin push ni despliegue.

## Cambio

- El eco propio espera 500 ms y consulta intents locales aceptados por su ID de
  proveedor. Si el mismo destino/conversación todavía tiene un envío WhatsApp en
  `sending`, la observación se reconsulta cada 100 ms.
- La correlación espera como máximo 5 s desde el eco. Un ID aceptado resuelve el
  eco como salida local; un envío que siga sin resolverse al vencer la ventana
  activa el handoff para proteger la automatización.
- Una salida propia sin envío local pendiente sigue activando handoff tras la
  espera inicial.

## Evidencia

- Prueba con archivo SQLite y transporte simulado: el eco aparece mientras el
  envío local sigue pendiente más de 500 ms; el ACK tardío con el mismo ID evita
  el handoff y conserva una sola salida `external_self`.
- Prueba de salida propia externa: activa handoff. Prueba de envío que permanece
  `sending`: activa handoff al agotarse la ventana de 5 s.
- Pruebas focales de eco/handoff: 3/3.
- `cd apps/gateway && npm run check`: lint/typecheck, Panel 42/42, build Vite,
  servido del build 1/1 y Gateway 386/386. `git diff --check` limpio.
- Sin WhatsApp real.
