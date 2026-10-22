# BUG-008 — Resolución exacta de identidad legacy

Fecha: 2026-10-22. Cierre local en `main`; sin push ni despliegue.

## Cambio

- Los comandos legacy resuelven contactos por coincidencia exacta de todos los
  dígitos del teléfono o LID. Un sufijo parcial o una identidad compartida por
  varias filas se rechaza antes de cambiar estado, perfil, nombre o contexto.
- El índice de dígitos conserva todas las filas coincidentes y retira aliases
  reemplazados al actualizar una fila. La búsqueda de sufijos solo informa que
  la entrada fue parcial; nunca selecciona un contacto.
- Cuando el comando administrativo llega por Telegram, la respuesta vuelve por
  ese adapter y el objetivo sigue siendo un contacto WhatsApp. Si SQLite está
  activo, el control usa el resolver exacto de canal/cuenta existente. El
  fallback JSON legacy solo administra identidades WhatsApp y falla cerrado si
  se le pide una identidad explícitamente Telegram.

## Evidencia

- Pruebas cubren sufijos compartidos, colisiones exactas, actualización de una
  identidad completa, reemplazo de teléfono con la misma clave estable, rechazo
  del canal Telegram en la autoridad legacy y comandos `/nombre`, `/limpiar` y
  administrativos enviados desde Telegram.
- `cd apps/gateway && npm run check`: lint y typecheck pasan; Panel 42/42, build
  Vite y prueba de servido 1/1; Gateway 378/378.
- Pruebas focales de repositorio, comandos y resolución: 29/29.
- `git diff --check` limpio. Sin proveedores ni canales reales.

## Límite

El almacén JSON legacy no tiene dimensión de cuenta/canal. Su soporte queda
limitado a la libreta WhatsApp histórica y exige identidad completa. La resolución
de control SQLite conserva la selección por canal/cuenta; esta evidencia no
declara paridad de atención a clientes Telegram. Telegram se mantiene como canal
administrativo.
