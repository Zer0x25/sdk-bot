# BUG-011 — `/humano` y `/ia` conservan la política de acceso

Fecha: 2026-10-22. Cierre local en `main`; sin push ni despliegue.

## Cambio

- En el fallback JSON, `/humano` guarda el estado de acceso anterior antes de
  activar `handoff`. `/ia` lo restaura y elimina el dato temporal. Un handoff
  antiguo sin estado previo válido vuelve a `neutro` por seguridad.
- El vencimiento de handoff conserva su comportamiento existente: vuelve a
  `neutro` y elimina el estado temporal.
- En SQLite, takeover y release mantienen `accessPolicy`. El comando consulta
  la política durable y presenta si la conversación sigue bloqueada por acceso
  ignorado, modo global estricto, pausa global, revisión o cierre.
- `/humano` informa cuando el acceso ignorado impide la atención desde el panel.
  `/ia` indica cómo habilitar respuestas si la política todavía las bloquea.

## Evidencia

- Fallback JSON: `/humano` + `/ia` sobre un contacto permitido bajo
  `ignored_all` restaura `permitido` y la decisión del pipeline responde.
- Fallback JSON: acceso ignorado y contacto neutro bajo `ignored_all` permanecen
  bloqueados; ambos comandos explican el estado y cómo permitir el contacto.
- SQLite: comandos reales sobre control durable conservan `allowed` al tomar y
  devolver el chat bajo `ignored_all`; un contacto neutral mantiene su acceso y
  recibe el aviso de bloqueo.
- Pruebas focales: 17/17 (`legacyTargetResolution.test.js` y
  `controlService.test.js`).
- `cd apps/gateway && npm run check`: lint/typecheck pasan, Panel 42/42, build
  Vite y servido del build 1/1; Gateway 384/384. `git diff --check` limpio.
- Sin WhatsApp ni Telegram real.
