# Archivo persistente de conversaciones — F2A

Fecha: 2026-10-19. Unidad de repositorios cerrada. F2B.2 añade
[captura base WA](CAPTURA-WHATSAPP-F2B2.md) y purga diaria;
[F2B.3](MULTIMEDIA-WHATSAPP-F2B3.md) añade enriquecimiento multimedia. Telegram
sigue pendiente. La evidencia de abajo es de F2A.
Norma: [SPEC-OPERATIVA-V1](SPEC-OPERATIVA-V1.md), límites de
[ADR-005](adr/005-plataforma-conversaciones.md). No hay bandeja, API de páginas/SSE,
control humano v1 ni corte de contactos/settings en esta entrega.

## Propiedad y arranque

`gateway/services/conversations/index.js` expone RPC asíncrono con declaración de
puerto en `index.d.ts`; `worker.js` es el único que importa DatabaseSync.
`schema.js` contiene migración 0 → 1, ejecutada en transacción; rechaza una versión
más nueva. Readiness verifica integridad y FK. No abre SQLite al importar el bus,
el panel o los contratos. El gateway crea su instancia tras adquirir el lock de
proceso e inyecta el archivo en el bus. No espera SQL en el event loop principal.

SQLite usa WAL, synchronous=FULL y foreign_keys=ON. locking_mode=EXCLUSIVE conserva
el lock nativo durante toda la conexión, incluso entre transacciones; otra conexión
no puede convertirse en escritor. El sistema operativo libera ese lock al morir
el proceso. No hay archivos de propietario que deban borrarse para recuperar un
crash. La DB no se comparte con panel/brain ni lectores SQL externos; consultas y
backups pasan por el worker. Disco local y una réplica siguen siendo requisitos.

Inicio/RPC tienen techo de 5 s. Error de arranque/salida rechaza readiness y todos
los pendientes. Un timeout cierra admisión y termina el worker: un write pudo haber
commiteado, por eso no se reintenta automáticamente. Tras recuperación se deduplica
por clave del proveedor. La operación close drena peticiones admitidas y espera
terminación; llamadas nuevas rechazan. La cola admite como máximo 1000 elementos
(sumando registros de los lotes) o 32 MiB serializados. Los argumentos se copian al
admitirlos, antes de la espera asíncrona. Saturación produce ARCHIVE_SATURATED;
los adapters deberán traducirla a backpressure, nunca a ack anticipado.

## Estado y ciclo de vida

- `SDK_CONVERSATIONS_DB_PATH`: por defecto `gateway/data/conversations.db`.
- DB, sufijos `-wal` y `-shm` están en factoryReset; directorio por defecto ignorado
  por Git y Docker. DB con permisos 0600, directorio nuevo 0700; rechaza symlinks en
  DB/WAL/SHM existentes. Una ruta personalizada debe apuntar a estado privado.
- Compose configura `/var/lib/sdk-bot/conversations.db` sobre el volumen existente
  sdk_bot_state; panel no lo monta. No se mueven credenciales ni se añade volumen.
- SIGTERM/SIGINT cierran worker antes de salir. Reset desde panel y self-chat
  prepara el cierre antes de borrar; si falla, aborta. El aviso incluye el archivo.
  F2A dejó la carrera de auto-reinicio systemd CLI en BUG-029; **F2B.1 ya la
  reparó** mediante rechazo previo y verificación de parada, junto a la ruta de
  lock del brain (BUG-031). Ver [RESET-SEGURO-F2B1](RESET-SEGURO-F2B1.md).
- SDK_GATEWAY_LOCK_PATH ahora se respeta también en index.js, coincidiendo con
  inventario/CLI/Compose; se crea su directorio padre. BUG-030 reparado.
- F2A no incluye backups programados, CLI de restauración ni purga diaria. Las
  operaciones de repositorio existen; programación/operación se conectará antes
  de captura y exposición. No usar reset ni restaurar datos reales para probar.

## Datos e invariantes

Tablas: archive_meta, accounts, contacts, conversations, identities, aliases,
messages, fingerprints, provenance, events y quarantine. Índices para fecha/id,
retención y orden decimal de eventos; FK, unicidad y checks protegen relaciones.
Contactos son anclas internas del archivo; no copian permisos ni agenda JSON.
Conversación tampoco tiene accessPolicy/automationMode/controlVersion: JSON sigue
siendo autoridad de control hasta F5.

- registerAccount conserva ID por `(channel, providerKey)`; puede generarlo al
  primer registro. Un ID existente no puede adoptar otra cuenta/canal. providerKey
  será identidad comprobada del proveedor, **nunca token**, validada por el adapter
  en F2B/F2C. Fixtures no prueban autenticación de cuentas reales.
- Identidad exacta `(accountId,kind,exactValue)`, sin Number para Telegram, sin
  coincidencias parciales. Contacto/conversación/identidad usan UUID estables.
- bindAlias requiere evidencia adapter/admin y cuenta/canal iguales. Alias nuevo
  apunta a la misma clave canónica; las huellas existentes siguen deduplicando.
  Si ya existe en otro hilo, conserva ambos y los marca requires_review; no fusiona
  historias ni permite que un conflicto elija identidad. La futura barrera de
  envío deberá consultar esa marca; F2A no cambia el dispatcher legacy.
- ingestBatch valida DTOs y hace una transacción por lote: resolver identidad,
  mensaje, huella, procedencia, proyección, evento mínimo y watermark. Un error
  revierte todo el lote, incluso nuevas identidades. Solo después de COMMIT llega
  el resultado al consumidor. Ninguna operación programa IA ni llama a canales.
- Dedup `(accountId,canonicalIdentityId,providerMessageId)`; raw chat se conserva
  mediante identidad/procedencia, fuera de la clave. Reimportar por JID/LID probado
  conserva ID y no crea evento/entrada pendiente. Sin ID remoto se conserva cada
  observación con deduplicationQuality=unknown; no se promete dedup garantizada.
- Hash SHA-256 de dirección/contenido canónico, sin sensibilidad al orden de
  propiedades. Se calcula sobre contenido original, antes de marcador oversized.
  Un ID reutilizado con otro contenido queda en cuarentena, sin sobreescritura.
- Texto >64 KiB queda como oversized con bytes originales, sin texto truncado.
  Multimedia admite marcador con transcripción fallida. STT/update llegará con
  adapters; no está implementado un servicio de actualización en F2A.
- inboundSeq avanza solo para entrada live nueva; history/import no inflan ese
  watermark. Última actividad usa máximo de fecha original. Cobertura conserva
  captura live inicial y observación de historia; no certifica historia completa.
  Un outbound histórico conserva autoría unknown. No existen aún no-leídos por actor.
- Versiones/secuencias son TEXT decimal y operaciones BigInt. Eventos se ordenan
  por longitud y valor, no por conversión a Number ni orden lexicográfico simple.
  Epoch persistente y seq se leen juntos; session ya no devuelve un bootstrap.

Páginas del repositorio son auxiliares internos por `(occurredAt,id)`, con fechas
UTC normalizadas y máximo 100. No son cursores públicos: filtros/ámbito/epoch,
autorización y paginación HTTP corresponden a F3. Events devuelve invalidaciones
mínimas validadas, sin texto/media; no publica SSE ni implementa replay HTTP.

## Retención, backup y copia restaurada

purge elimina en lotes de hasta 1000 por categoría: cuerpos con ingestedAt <90d,
eventos <7d y huellas <180d, con comparación estricta. Conserva identidad/hilo y
huella después del cuerpo; redelivery dentro de esa ventana no recrea contenido.
No hay contexto derivado de este archivo todavía: F5 deberá invalidarlo al purgar.
No se declara implementada idempotencia de salidas por disponer de fingerprints.

backup usa VACUUM INTO desde el worker, con escrituras serializadas. Rechaza un
destino existente y no copia WAL/SHM en caliente. El llamador gestiona ruta privada,
inventario/retención de sus snapshots; no se crean backups por defecto.

Una **copia offline** abierta con `{restore:true}` aplica purga antes de readiness,
rota epoch y descarta la línea previa de eventos, conservando watermark/mensajes
vigentes. No reemplaza una DB viva. No es recuperación de producción completa:
revocaciones, control/outbox, manifiesto, mantenimiento y RPO siguen F5/F8. Abrir
normalmente conserva epoch; toda futura herramienta de restore debe usar la vía
explícita y completar esas puertas antes de exponer datos.

## Evidencia y límites

- Gateway npm run check: lint, tipos y **174 tests** en Linux Node 24.19.0 y
  mínimo 22.13.0. Copias separadas de archivos versionados y nuevas fuentes,
  dependencias instaladas enlazadas; no se repitió npm ci (manifests sin cambios).
  Son 158 existentes +14 de archivo +1 de reset +1 de ciclo de vida real offline.
- Raíz npm run check: 14 tests de contratos/generación/tipos. Schema/OpenAPI y
  fixture de 75 expectativas sin cambios. No se declaran 75 escenarios aprobados.
- Pruebas del archivo cubren rollback, cierre/reapertura, JID/LID real (BUG-016),
  cuentas/IDs TG con signo >2^53, secuencias >2^53, cuarentena, procedencia,
  mensajes sin ID, páginas empatadas, cobertura, oversized/audio, cola/FIFO/timers,
  límites de purga/huella, snapshot firmado y fallo saneado sin fallback.
- Crash: proceso separado abre una transacción, escribe watermark sin commit y
  se mata con SIGKILL. Reapertura conserva commit anterior y revierte lo pendiente;
  no equivale a probar pérdida de energía o corrupción física.
- Test de entry real usa transporte WA sustituido, TG sin token, brain local
  inaccesible y puertos efímeros: lock configurable, snapshot tras dos arranques y
  salida 0 en SIGTERM con lock eliminado. Todas sus rutas de estado son temporales.
- Smoke adicional de gateway + panel reales con transporte sustituido confirma
  health/sesión y epoch estable al reiniciar gateway. Panel termina por SIGTERM
  (comportamiento previo). No se ejecutó launcher: logs globales /tmp preexistentes
  se conservaron; no es evidencia nueva de deploy/linux/dev.sh.
- Imagen de producción construida con npm ci --omit=dev, Dockerfile temporal
  idéntico salvo mount de CA proxy en RUN npm ci, TLS verificado. Tests offline
  con --network none y profiles versionados montados como en Compose. Primer run
  sin ese volumen falló un assert de fixture de profiles; se corrigió el montaje,
  no el producto. Resultado final: **37 tests pasan**, Node 22.23.3, sin red.
- Muestra sintética de 1000 mensajes durante checks concurrentes: Node 22.13,
  812 ms /624 ticks /199458816 bytes RSS; Node 24, 1078 ms /623 ticks /215670784
  bytes RSS. Son observaciones únicas y RSS del proceso de test, no del gateway
  completo desplegado. Duración/ticks/RSS también quedan en logs.
  No cumple el protocolo completo de VALIDACION: millón de mensajes, generador
  reproducible y percentiles concurrentes siguen pendientes antes de cerrar F2.
- Compose config validado con env_files vacíos y secreto ficticio en copia:
  DB en volumen de gateway, panel sin montaje de estado. Reglas Git ignoran
  DB/WAL/SHM por defecto; enlaces/fences y fuentes probadas revisados.
- No cambios Python: brain no repetido. Windows/Termux y GitHub Actions no
  ejecutados. No captura live, OAuth real, llamadas IA, push ni despliegue.

Logs efímeros: `/tmp/sdkbot-f2a-kg__9opd` (checks por runtime, Docker, smoke y
reproducción de lock configurable). Fixtures de pruebas borrados por sus cierres;
la copia de smoke/evidencia contiene solo datos sintéticos. Ningún estado del
workspace ni cuenta/sesión real se leyó para poblar el archivo.
