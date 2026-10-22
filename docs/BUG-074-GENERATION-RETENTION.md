# BUG-074 — Retención de respuestas de generación

Actualización: 2026-10-22. Cerrado con pruebas locales de Brain; no se usaron
proveedores ni canales reales.

## Política

- Una respuesta de `GenerateReply` conserva su texto y proveedor por 7 días desde
  la primera escritura. Los replays no extienden la retención.
- Al vencer, Brain limpia texto/proveedor y cambia el registro a `invalidated`.
  La marca conserva la misma generación para que un replay viejo devuelva 409 y
  no regenere una respuesta con el proveedor.
- El tombstone dura 30 días desde la expiración o invalidación. Después se poda.
  Esto excede la ventana de 24 horas de la cola durable de Gateway.
- Cada respuesta admite hasta 65 536 bytes UTF-8 y hay hasta 5000 respuestas
  activas: como máximo 327 680 000 bytes (312,5 MiB) de texto de respuesta,
  además del índice y metadatos SQLite. Al llenarse el cupo, Brain responde 503
  sin devolver una respuesta que no haya podido persistir. Una salida superior
  a 64 KiB devuelve 502 y no se guarda.

## Limpieza

El barrido se ejecuta al iniciar Brain, cada hora y antes de leer/escribir el
ledger o reportar `/health`. Una respuesta expirada se invalida en SQLite antes
de contestar al replay. El proceso usa `secure_delete`, trunca WAL después de
limpiar contenido y ejecuta `VACUUM` cuando hay páginas libres y corresponde la
compactación periódica. Si Brain está detenido, la poda se ejecuta al próximo
inicio.

## Verificación

- Brain Ruff: sin hallazgos.
- Brain completo: 39 pruebas pasan.
- Las pruebas verifican replay tras 48 horas, expiración después de 7 días,
  409 sin una segunda llamada al proveedor, poda del tombstone a los 30 días,
  reducción de páginas SQLite, límites de bytes/cupo activo y sweep al iniciar.
- No se probó una cuenta real ni un proveedor externo.
