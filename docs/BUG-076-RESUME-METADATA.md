# BUG-076 — Metadatos mínimos al reprocesar pendientes

**Estado: cerrado — 2026-10-22.** `process_pending` vuelve a incorporar los
nombres de contacto disponibles en la ruta original, sin conservar el resto de
los metadatos de transporte en la nueva columna.

## Alcance implementado

- SQLite v16 añade `legacy_dispatch.resume_metadata`, que admite únicamente
  `pushName` y `savedName`. El sobre original de ruta se sigue vaciando al
  completar el primer despacho.
- Para mensajes nuevos, los nombres se conservan desde la captura hasta 24 horas
  después de `ingested_at`, que es la ventana de elegibilidad de `process_pending`.
  El worker purga al iniciar, cada minuto y antes de listar o liberar pendientes.
  Si la entrada se omite o falla su transcripción, los nombres se borran de
  inmediato. El borrado sigue ligado a la fila del mensaje y cae con la purga del
  mensaje.
- `process_pending` incorpora esos dos nombres a la ruta reconstruida. Canal,
  destino y teléfono/LID operativo se derivan de la identidad canónica SQLite;
  no se copian desde `resume_metadata`. Perfil y contexto usan los mismos
  snapshots y mensajes archivados de antes.
- El checkpoint de F8.4 incluye cantidad y digest de esta columna. El restore-check
  detecta cambios sin incluir nombres ni digest en su salida resumida.
- La migración v15→v16 recupera nombres solo de payloads aún `pending`/`waiting`
  y con menos de 24 horas. Despachos anteriores ya confirmados vaciaron el
  payload, así que sus nombres no se pueden recuperar; siguen siendo elegibles
  para reproceso con identidad archivada.

## Evidencia

- `apps/gateway/tests/legacyDispatch.test.js` comprueba que después del ACK el
  payload de ruta queda `{}`, la columna privada contiene solo los dos nombres,
  el vencimiento elimina esos nombres al reiniciar, la migración v15 recupera
  solo filas recientes pendientes y los audios fallidos los borran de inmediato.
- `apps/gateway/tests/f63ConversationFlow.test.js` ejecuta takeover, entrada bajo
  control humano y `process_pending`; verifica que el replay restaura ambos
  nombres, deriva el teléfono desde la identidad archivada, no restaura el LID
  arbitrario de la ruta y conserva el contexto histórico y el perfil `default`
  enviado a Brain.
- `apps/gateway/tests/conversationRecovery.test.js` comprueba que el restore-check
  bloquea un cambio en estos metadatos sin exponer su contenido ni su digest.
- `cd apps/gateway && npm run check`: lint y typecheck pasan; Panel 44/44, build
  Vite, prueba de servido 1/1 y Gateway 391/391.
- `git diff --check` pasa. Sin proveedor, canal real ni despliegue.
