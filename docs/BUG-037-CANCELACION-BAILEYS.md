# BUG-037 — Cancelación física de la descarga de medios Baileys

## Causa y cambio

Baileys `7.0.0-rc14` acepta `dispatcher` en la ruta `downloadMediaMessage` →
`downloadContentFromMessage` → `getHttpStream`, pero su llamada a `fetch` no pasa
`AbortSignal`. Por eso vencer/cancelar el job anterior podía detener el resultado
de la app y dejar pendiente la conexión HTTP.

El adapter ahora envuelve el downloader por defecto con un `undici.Agent` privado
para cada descarga y lo pasa mediante `options.options.dispatcher`. La señal del
job destruye el stream ya abierto y el agente; la ruta también libera el agente
cuando el stream termina, falla o se cierra antes de completar. Las descargas no
comparten dispatcher ni cambian `global.fetch`; no se modifica `node_modules`.

Se fija `undici@7.29.1` como dependencia directa; su engine declara Node
`>=20.18.1`. `npm ci` reproduce el lock y reporta cero vulnerabilidades.

## Prueba de cancelación

`whatsappCapture.test.js` llama al downloader real de Baileys contra un servidor
HTTP local que acepta la petición y nunca envía headers ni body. Ocho iteraciones
alternan cancelación inmediata y vencimiento temporizado. Cada iteración espera el
cierre del socket antes de continuar; al final hay ocho sockets creados, ocho
cerrados y cero activos. No se conecta a WhatsApp ni al servidor STT.

## Verificación

- `npm ci` en `apps/gateway` — 0 vulnerabilidades.
- Prueba focal `BUG-037` — 1/1 en Node 24.21.0 y 1/1 en Node 22.22.1.
- `cd apps/gateway && npm run check` — lint/typecheck limpios, Panel 44/44,
  build Vite/servido 1/1 y Gateway 398/398 en Node 24.21.0.
- `git diff --check` — limpio.
- La prueba local acredita cancelación HTTP/sockets con la versión instalada; no
  acredita aceptación de una descarga live de WhatsApp o de STT.
