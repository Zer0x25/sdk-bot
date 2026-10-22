# BUG-075 — Conciliación de salidas inciertas

**Estado: cerrado — 2026-10-22.** La bandeja v1 permite revisar salidas humanas
y de IA que permanecen en `delivery_unknown`, sin volver a llamar al proveedor.

## Alcance implementado

- `GET /v1/conversations/{conversationId}/outbound-reconciliations` pagina solo
  intents inciertos `human`/`ai` de esa conversación. Requiere
  `conversations:read`; el cursor firmado queda ligado a actor, conversación,
  fuentes y límite. La proyección no entrega claves idempotentes, payloads
  internos ni resultado crudo del proveedor.
- `POST /v1/conversations/{conversationId}/outbound-intents/{intentId}/reconcile`
  requiere `messages:send`, el owner actual o `control:override`, y control SQLite
  listo. Exige una nota de revisión de hasta 500 caracteres y no accede al adapter
  ni reenvía el mensaje.
- Una decisión `accepted` exige un ID remoto. Si el historial ya contiene ese ID,
  el contenido debe coincidir exactamente con la salida incierta antes de atribuir
  autoría de operador/IA y el mensaje queda materializado en el archivo. Si el eco
  todavía no está cargado, el operador puede aportar el ID remoto observado y la
  operación crea el registro de salida correspondiente. Solo después de
  materializar se avanza `handledThroughInboundSeq`.
- Una decisión `rejected` omite el ID remoto, deja la entrada entrante sin marcar
  como atendida y libera el bloqueo de `process_pending`. Un nuevo envío usa un
  `clientMessageId` nuevo; la misma clave de salida no se reabre.
- La bandeja consulta la lista al seleccionar una conversación, muestra el aviso
  de salidas pendientes y abre un panel independiente del flujo de devolución a
  IA. El panel permite elegir ecos archivados por texto/tiempo o introducir el ID
  manualmente; ambas decisiones exigen nota. El compositor ya no ofrece un botón
  para reenviar directamente una salida `delivery_unknown`.
- `future_only` conserva su comportamiento. Una entrega incierta sigue bloqueando
  la selección de entradas para `process_pending` hasta ser conciliada.

## Evidencia

- `apps/gateway/tests/controlService.test.js`: GET autenticado y proyección segura;
  rechazo por ID archivado con texto distinto; conflicto de owner; aceptación
  auditada que materializa el eco y solo entonces avanza el watermark; rechazo que
  conserva la entrada como pendiente.
- `apps/panel/web/src/app/App.test.tsx`: encuentra una salida pendiente al abrir
  una conversación y, tras un nuevo envío incierto, muestra la conciliación;
  registrar rechazo requiere nota y comprueba una sola llamada de envío.
- Contratos validados por `npm run check` desde la raíz: 19/19.
- `apps/gateway`: `npm run check` completo; Gateway 388/388, Panel 44/44, lint,
  typecheck, build Vite y prueba de servido.
- `git diff --check` limpio. No se usó WhatsApp, Telegram ni proveedor de IA real.
