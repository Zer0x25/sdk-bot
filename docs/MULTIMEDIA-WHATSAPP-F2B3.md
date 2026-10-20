# Enriquecimiento multimedia WhatsApp — F2B.3

Fecha: 2026-10-19. Unidad implementada y probada con SQLite real y transporte/STT
sustituidos. Completa la captura multimedia de F2B: BUG-033/034 reparados y
BUG-036 de concurrencia detectado y reparado. No habilita UI/API de historial,
control humano v1 ni atribución durable de salidas. Telegram sigue F2C.

## Recorrido y autoridad

Se conserva la captura base de [F2B.2](CAPTURA-WHATSAPP-F2B2.md) y la excepción
transitoria de [ADR-006](adr/006-admision-durable-en-adapter.md). Solo el worker
existente abre SQLite; contactos/settings JSON siguen siendo autoridad de control.
No cambia OAuth ni se inicia un segundo consumidor Baileys.

1. Capturar y confirmar el audio original, con su ID, huella y marcador
   `not_requested`, antes de descargar/transcribir. Captura no depende de pausa,
   permisos ni handoff. Históricos, duplicados, fromMe y cuarentena no inician STT.
2. Si STT está habilitado para una entrada live admitida, actualizar a `pending`
   mediante RPC y esperar commit antes de descargar. STT desactivado conserva
   `not_requested`; rechazo por duración/capacidad queda `failed`, sin transcript.
3. Ejecutar descarga/STT fuera del FIFO de captura. Textos y otros mensajes
   continúan capturándose mientras la transcripción está pendiente.
4. Persistir `completed` y texto válido antes de emitir StandardMessage al
   consumidor legacy. Resultado nulo/vacío, Unicode inválido, >64 KiB, descarga
   vacía/grande/error, deadline o socket reemplazado quedan `failed`, sin texto.
5. Comprobar socket, deadline y requires_review al terminar. Una transcripción
   factual puede quedar completed aunque después cambie el socket o la identidad
   requiera revisión; eso no autoriza automatizarla. F5 conserva la responsabilidad
   de la barrera atómica de control/dispatch.

El self-chat administrativo conserva audio legacy con el mismo límite/cancelación,
pero no crea cuentas, conversaciones ni transcripciones en el archivo de clientes.
El aviso existente de audio demasiado largo se conserva tras guardar el fallo.

## Actualización durable interna

`archive.updateTranscription({messageId, expectedStatus, status, transcript?})`
no es un endpoint HTTP. Reutiliza RPC acotado 1000/32 MiB y timeout 5 s.

- Transiciones: not_requested → pending/failed; pending → completed/failed.
  Comparación del estado esperado evita que una finalización tardía sobrescriba
  un resultado terminal. Transiciones inválidas rechazan; estado distinto devuelve
  unchanged sin evento; cuerpo inexistente devuelve missing, sin recrearlo.
- Una transacción actualiza payload, aggregateVersion decimal, message.updated
  mínimo y watermark global. No modifica fingerprint, ID, inboundSeq, occurredAt,
  ingestedAt, última actividad, cobertura ni autoría. No extiende retención.
- El evento solo contiene referencias/versión, sin copiar la transcripción.
  Reimportar base por JID/LID verificado mantiene la huella original y no duplica
  ni vuelve a disparar STT. La purga puede borrar un audio pendiente; terminar
  después no lo recrea ni admite IA.
- Antes de readiness, pendientes huérfanos de una ejecución anterior pasan a
  failed con su evento, por lotes de 500 IDs. No se reanudan trabajos ni respuestas.
  La recuperación es idempotente. No requiere DDL nuevo: schemaVersion sigue 1.
- Un fallo RPC detiene nuevos enriquecimientos en esa instancia y publica estado
  degradado. Nunca se reintenta una escritura incierta ni se emite texto por ella;
  completed pudo haberse confirmado antes del timeout. Reiniciar consulta estado
  durable; no reproduce trabajos anteriores para intentar recuperar una respuesta.

## Contrato y captions

MessageContent multimedia admite `caption?: StoredText`, opcional para conservar
compatibilidad con marcadores previos. Imagen/video/documento conservan tipo y
texto literal, también dentro de wrappers ephemeral/viewOnce/documentWithCaption.
Caption >64 KiB queda oversized con tamaño y huella del original, sin IA; no se
trunca ni se convierte silenciosamente en texto completo. No se almacenan blobs,
URLs ni claves del adjunto. Disponibilidad sigue `not_stored` aunque STT complete.

Los registros antiguos que F2B.2 guardó como texto siguen legibles. No se puede
reconstruir su tipo borrado con certeza: una reentrega del mismo ID con la nueva
forma multimedia se conserva como conflicto/requires_review, sin sobrescribir ni
fusionar por coincidencia del caption. Requiere revisión; no hay migración que
invente evidencia. Marcadores sin caption mantienen dedup compatible.

Se regeneraron tipos y se ejecutó npm ci offline en gateway para refrescar la
copia empaquetada de contracts. El paquete privado mantiene 0.1.0; no se publica.

## Límites y cancelación

- Cuatro trabajos de audio activos, sin cola adicional. Saturación visible como
  WA_STT_SATURATED y audio failed; no reintento automático. No pretende garantizar
  transcripción de cada audio recibido durante una ráfaga.
- Deadline total 150 s, además de timeout/reintento STT existente. Señal compartida
  de cancelación al reemplazar/cerrar socket y durante backoff/fetch de STT.
  Un proveedor/mock que ignore abort conserva su plaza hasta terminar realmente;
  vencer el deadline no crea capacidad ilimitada para trabajos huérfanos.
- Descarga en stream, acumulación hasta STT_MAX_UPLOAD_BYTES (5 MiB por defecto),
  rechazo sin STT al superar el límite. Es límite del buffer acumulado, no una
  medición de heap ni garantía de bytes de red. El límite de duración se conserva.
- Shutdown/reset cancelan trabajos, drenan sus resultados durables y luego cierran
  archivo. Las operaciones que ignoran cancelación no pueden publicar resultados
  tardíos ni efectuar escrituras después del cierre desde este coordinador.
- **BUG-037 abierto, P2/F8:** Baileys 7.0.0-rc14 getHttpStream omite signal al llamar
  fetch. La cancelación del resultado es efectiva; la descarga subyacente puede
  seguir esperando/recibiendo. No afirmar cancelación física del HTTP ni ausencia
  universal de handles residuales. Resolver en la frontera de descarga/pin del
  proveedor antes de aceptar STT real. No bloquea actualización durable ni los
  tests offline de esta unidad. No se parcheó global.fetch ni node_modules.

## Verificación

Copias separadas de archivos actuales, sin .env, cuentas ni DB originales; solo
las dependencias instaladas están enlazadas. npm ci --offline gateway completado,
scripts habilitados; sin cambios de manifiestos/locks ni nuevas dependencias.

| Entorno | Resultado |
|---|---|
| Gateway npm run check, Node 24.19.0 Linux | Lint/tipos y 218 tests pasan. |
| Gateway npm run check, mínimo Node 22.13.0 Linux | Lint/tipos y 218 tests pasan. |
| Contratos raíz npm run check, ambas versiones | Generación/tipos y 15 tests pasan. |
| Imagen nueva producción, Node 22.23.3, --network none | 72 tests de archivo/captura/multimedia/entry/reset/STT pasan. |

218 = 204 previos +5 repositorio +8 captura/enriquecimiento +1 cancelación STT.
Pruebas de commit antes de STT/legacy, FIFO que sigue avanzando, aliases/dedup,
estados terminales, exceso/error, timeout/saturación, cambio de socket/revisión,
self-chat, purga y reapertura. Los 75 escenarios del fixture y los presupuestos de
carga completa siguen siendo puertas futuras, no 75 casos nuevos ejecutados.

Reproducción aislada de adapter/normalizador 7d99f36: cinco STT simultáneos sin
límite específico; los cinco audios siguen not_requested tras terminar; caption
queda type=text. Reproducción separada del getHttpStream instalado con fetch
sustituido: signal ya abortado no se transmite, sin red. No es prueba de proveedor.

Docker construye sdkbot-f2b3:local con npm ci --omit=dev y contracts actual
empaquetado, sin node_modules raíz. Adaptación cloud del Dockerfile temporal:
mount CA solo en RUN npm ci, TLS verificado; no copiar certificados/secretos a
capas. Tests en imagen, profiles montados como Compose. No compose up/despliegue.

Evidencia efímera: /tmp/sdkbot-f2b3-9a8_8bcc (checks, reproducción e imagen).
Brain/launcher no cambiaron ni se repitieron; se conservan logs previos. Sin cuentas,
modelos, OAuth ni STT reales; sin push ni GitHub Actions. Windows/Termux pendientes.
Cierre: commit local `git log --grep="close F2B.3"`.
