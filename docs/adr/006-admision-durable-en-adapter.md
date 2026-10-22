# ADR 006: admisión durable antes del consumidor legacy

Fecha: 2026-10-20. Estado: aceptada para la transición F2.
Complementa ADR-003/005; implementada para WA en F2B.2, Telegram en F2C.2 y
replay transaccional en F2D.

## Contexto

ADR-003 indicaba que el adapter solo normaliza/emite y el handler concentra
efectos. EventEmitter no espera handlers async: emitir y continuar permite
automatización antes del commit, además de formar colas sin límite. El handler
legacy filtra texto, permisos y pausa antes de disponer de captura independiente.
El archivo F2A necesita conservar también historia, ecos y marcadores multimedia.

## Decisión

Se amplían los puntos 2 y 4 de ADR-003: durante la transición, el adapter puede
esperar un coordinador de admisión durable inyectado por el gateway antes de
emitir `message` al consumidor legacy. La persistencia está en los servicios
de captura del canal, no en el handler ni en SQL dentro del adapter. El gateway
compone el único archivo, su purga y su ciclo de vida.

- El adapter conserva normalización de transporte, clasificación de origen y
  protección de su socket; ningún segundo consumidor lee Baileys.
- La coordinación captura independiente de elegibilidad de IA, con cola acotada
  y confirmación de commit. Resultados duplicados/históricos/cuarentena no admiten
  automatización nueva. Un error no simula éxito ni activa retry de escritura.
- El coordinador recibe observaciones e identidad comprobada; no importa
  Baileys, perfiles, permisos, STT, HTTP ni proveedores. El único SQL continúa en
  el worker. El archivo inyectado es un puerto async dentro del gateway.
- Como protección transitoria, el adapter consulta `requires_review` antes de un
  envío individual. Esto no sustituye coordinación/versionado/outbox de F5 ni
  traslada autoridad de acceso/control desde JSON.
- `archived_message` alimenta consumidores de cache solo tras commit. Emitirlo
  no constituye una API pública ni un ACK adicional al proveedor.
- Telegram normaliza lotes de `getUpdates` y entrega mensajes/cursor a una sola
  RPC del worker; el siguiente `offset` se calcula después de recibir su commit.
  Updates administrativos, grupos y tipos no admitidos pueden avanzar cursor si
  su `update_id` es válido, dentro de la misma transacción.
- F2C.3 añade una fila al inbox administrativo para texto normalizado del chat
  admin, en la misma transacción que su cursor. Tras el commit, un evento solo
  despierta un pump del gateway; el pump reclama `(account_id, update_id)` antes
  del pipeline y persiste resultado/estado. El adapter no clasifica comandos ni
  aplica permisos. Un claim que sigue `processing` al reiniciar pasa a
  `uncertain` y no se repite, porque los efectos legacy no comparten transacción
  con SQLite.

Las decisiones de negocio de respuesta/comandos permanecen en pipeline y los
efectos legacy en su handler. F5 deberá concentrar despacho/control en los casos
de uso comunes; no extender esta excepción a decisiones de acceso dentro de los
adapters. Telegram conserva su dueño único de polling de ADR-003 y solo agrega
admisión durable; no copia reglas WA ni crea otro lector.

## Consecuencias y validación

El acoplamiento transitorio del adapter a un puerto de archivo es explícito y
reemplazable. Evita emitir al handler antes de guardar, a costa de no ser todavía
la separación completa de observaciones/casos de uso de la arquitectura destino.
No incorpora control humano ni salida durable por sí solo.

El inbox admin queda separado del historial de clientes. La ventana entre el
claim y el efecto no puede hacerse atómica con cada comando legacy: un reinicio
en esa ventana produce resultado incierto y requiere revisión antes de una
repetición manual. Véase [BUG-046](../BUG-046-TELEGRAM-ADMIN-INBOX.md).

Pruebas de commit previo, fallo después de commit, saturación, sockets antiguos,
reapertura y composición del entry real en
[CAPTURA-WHATSAPP-F2B2](../CAPTURA-WHATSAPP-F2B2.md). Los límites de transporte y
proceso de ADR-001/002 y el dueño único de ADR-003 se conservan.

Telegram añade `getMe` para obtener un `providerKey` estable del bot sin persistir
el token. La migración v2 crea cursores por cuenta; la v3 agrega el outbox de
entrada. Captura Telegram, evento, proyección, cursor y fila outbox se confirman
en la misma transacción. WhatsApp añade el outbox en su transacción de ingestión.
Los eventos de adapter solo despiertan el pump; este reconstruye el mensaje desde
SQLite, espera a que el canal esté conectado y guarda el ACK al terminar. Las
respuestas IA mantienen el ACK pendiente hasta que termina el procesamiento de
debounce/IA. El audio con STT espera transcripción; el fallo lo marca omitido.

BUG-045 cubre el corte entre commit y entrada al pipeline. El despacho es
at-least-once ante fallos/ACK incierto dentro de ramas con efectos externos; la
idempotencia de salidas permanece en F5 (BUG-050). Updates de grupos/tipos
excluidos pueden confirmar cursor sin crear mensaje. El inbox durable admin se
añadió después en F2C.3 (BUG-046). Redelivery stale admin se filtra desde F2C.2
(BUG-047). Evidencia y límites: [REPLAY-LEGACY-F2D](../REPLAY-LEGACY-F2D.md) y
[TELEGRAM-CAPTURA-F2C2](../TELEGRAM-CAPTURA-F2C2.md).
