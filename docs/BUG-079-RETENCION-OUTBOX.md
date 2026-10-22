# BUG-079 — Retención del outbox

## Regla aplicada

- Un intent `intent` que aún no inició transporte vence después de 24 horas. La
  purga lo marca `rejected/OUTBOUND_INTENT_EXPIRED`; `claimOutboundIntent()` aplica
  el mismo límite para evitar envíos tardíos entre sweeps.
- SQLite v17 guarda un SHA-256 del payload canónico y una marca `redacted_at`.
  A los 90 días borra payload, destino, respuesta cruda del proveedor y metadatos
  de control en salidas terminales e inciertas. Conserva la clave y fingerprints
  para reconocer una redelivery sin guardar texto.
- Un replay terminal durante la ventana de idempotencia devuelve
  `410 IDEMPOTENCY_RESULT_EXPIRED`. Si el payload presentado no coincide con su
  huella, devuelve conflicto 409. Ninguno llama al proveedor.
- Los terminales `accepted`/`rejected` se eliminan después de 180 días. Un
  `delivery_unknown` no se elimina hasta conciliación explícita; al vencer su
  contenido permanece solo el tombstone con estado y huellas. La bandeja indica
  que el texto venció y permite registrar la decisión sin materializar un cuerpo
  nuevo en el archivo.
- El checkpoint de recuperación ya calcula el digest sobre todas las columnas del
  ledger outbox. Así una copia con filas, huellas o marcas de redacción distintas
  no pasa la comparación de promoción.

La garantía de idempotencia termina a los 180 días para resultados terminales,
según la SPEC. Los clientes no deben reenviar automáticamente una solicitud más
antigua. Los envíos inciertos conservan su tombstone mientras sigan sin resolver.

## Verificación

`outboundIntent.test.js` cubre la redacción a 90 días, las fronteras estrictas de
90 y 180 días, replay vencido sin llamada al proveedor, conflicto con payload
distinto, protección de `delivery_unknown`, conciliación, expiración de cola y
migración desde schema v16. El checkpoint cambia su digest al redactar un intent
y conserva el conteo. No se usan cuentas ni canales reales.
