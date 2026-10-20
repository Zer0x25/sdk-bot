# Archivo de salidas aceptadas y reconciliación de ecos — F2E.1

Fecha: 2026-10-20. Esta unidad cubre la persistencia local de mensajes cuya
aceptación confirmó el adaptador del proveedor y la deduplicación con ecos WA.
No añade una intención durable anterior al envío ni autoría de origen.

## Contrato implementado

- WhatsApp archiva el resultado aceptado de `sendMessage` cuando contiene un ID
  de proveedor. Telegram archiva el `Message` devuelto por Bot API tras comprobar
  HTTP 200 y `ok: true`; `getUpdates` no devuelve los mensajes propios del bot.
- La clave de deduplicación usa cuenta, identidad exacta del chat y el ID del
  proveedor. Un eco `fromMe` WA anterior o posterior al retorno de envío converge
  en el mismo mensaje y no inicia automatización.
- Las salidas se guardan como `direction=outbound`, `authorKind=external_self`,
  `source=live`. Esa autoría evita adjudicar un envío a IA u operador sin una
  intención durable correlacionada. Los destinos Telegram admin y grupo, y el
  self-chat de WhatsApp, quedan fuera del archivo de conversaciones de cliente.
- Un `ok: false` HTTP 200 de Telegram se devuelve como error y no se registra
  como envío aceptado.
- La respuesta JSON de Bot API conserva UTF-8 aunque un carácter multibyte quede
  dividido entre fragmentos HTTP; los IDs numéricos superiores a 2^53 mantienen
  su valor decimal exacto.

## Límites conservados

La llamada externa y la escritura SQLite no forman una transacción distribuida.
Una caída o error local tras la aceptación del proveedor puede dejar el envío sin
recibo durable; la ruta lo informa y no repite el efecto. BUG-050 mantiene para
F5 el outbox/idempotency key y la reconciliación del resultado ambiguo. Si
WhatsApp no devuelve un ID de proveedor, esta unidad espera el eco y no inventa
una clave.

El origen IA/operador/sistema todavía no se conserva, `external_self` aún no
activa control humano, y los envíos Telegram de mensajes propios no son
recuperables por polling. BUG-043/050 y el control v1 siguen abiertos. Tampoco se
ejecutó aún el dataset de 1 millón de mensajes de [VALIDACION-V1](VALIDACION-V1.md);
eso sigue siendo puerta para cerrar F2.

## Verificación

- Pruebas enfocadas WA/TG: **34/34** pasan. Cubren ID de proveedor, estado
  external_self, eco WA antes/después del ACK del adaptador, deduplicación,
  aislamiento admin/grupo, entero Telegram >2^53, UTF-8 separado entre chunks y
  `ok:false` sin fila nueva.
- `gateway npm run check`, Node 24.19.0: lint, typecheck y **250 pruebas** pasan.
- Sin proveedores/canales reales, credenciales, base de usuario ni benchmark de
  1 millón. La validación de salida usa SQLite temporal y transportes falsos.
