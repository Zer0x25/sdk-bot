# Hoja de ruta: plataforma de conversaciones SDK-Bot

Actualización: 2026-10-20. Arquitectura: [ARCHITECTURE.md](ARCHITECTURE.md).
Decisión: [ADR-005](adr/005-plataforma-conversaciones.md).
Estado por sesión: [SESSION-STATE.md](SESSION-STATE.md).
Prompt reutilizable: [PROMPT-CONTINUIDAD.md](PROMPT-CONTINUIDAD.md).

## Objetivo verificable

Un cliente escribe, el mensaje queda guardado y aparece en la bandeja. El operador
abre el chat, toma control, responde desde allí y devuelve la atención a IA. La IA
conoce lo hablado con el humano. Reiniciar servicios o reconectar navegador no
pierde historial ni reactiva respuestas canceladas.

**Nada de las fases siguientes se declara implementado por escribir este plan.**
La sesión inicial creó la base documental. Después se completaron F0.1 y los
checks actuales en copia temporal: gateway Node 22/24, brain y smoke del launcher
con WA simulado/TG sin token. Evidencia: [BASELINE-CONVERSACIONES.md](BASELINE-CONVERSACIONES.md).
F0.2 también completada: [experimento SQLite](SQLITE-SPIKE.md) probado en Linux
con Node 22.13/22.23/24, driver elegido y plataformas pendientes registradas.
F0.3 completada: [especificación operativa](SPEC-OPERATIVA-V1.md), 75 escenarios de
aceptación futura revisados y [protocolo de validación](VALIDACION-V1.md). Fase 0
cerrada. F1A y F1B completadas: workspace mínimo, contratos/tipos y frontera
autenticada probados. F2A completada (repositorios del archivo); F2B.1 cierra la puerta de reset CLI.
F2B.2 conecta captura base WA y F2B.3 completa enriquecimiento multimedia durable.
F2C.1 completa dueño único del polling/descubrimiento Telegram.
F2C.2 completa la captura base TG con cursor durable y namespace exacto.
F2D completa replay durable hasta el handler tras el commit (BUG-045). F2E.1 ya
registra salidas aceptadas y deduplica ecos WA; conserva autoría external_self.
F2E.2 cierra la carga sintética completa y F3.1 implementa la API autenticada de
lectura, filtros, páginas y cursor local de lectura. F3.2 completa SSE, replay y
resynchronización ante cursores fuera de retención. F4.1 entrega el shell visual,
la unidad de seguridad cerró BUG-062 en dependencias de medios y F4.2 conecta la
lista e historial reales. F4.3 añade conexión SSE, actualización paginada sin
huecos, ancla de scroll, contador de novedades, reconexión y resync. Evidencia:
[F4.3](F4.3-STREAM-INBOX.md); BUG-070 cerrado.
BUG-043 quedó cerrado con una guarda de reintento ligada a la cuenta Telegram de
origen. BUG-050 conserva salidas ambiguas; BUG-051 es puerta antes de usar archivos
preexistentes reales. La atribución IA/operador queda en F5 junto a su outbox.
Sin canales reales ni migración.

## Alcance y entregas

| Entrega | Fases | Resultado demostrable |
|---|---|---|
| Base técnica | 0–2 | Contratos y captura durable con pruebas; panel actual operativo. |
| Bandeja de lectura | 3–4 | Chats e historial paginado reales, búsqueda de contactos, eventos y reconexión. |
| Atención completa v1 | 5–6 | Control humano seguro, envío manual, retorno a IA con contexto y E2E. |
| Consolidación | 7–8 | Nuevo panel cubre funciones previas; estructura de destino y despliegues coherentes. |
| Capacidades posteriores | 9–10 | Multimedia y herramientas IA con alcance y pruebas propios. |

La entrega de mayor valor es atención completa v1. No bloquearla por campañas,
roles de equipo, un rediseño de proveedores o mover todas las carpetas.

## Reglas de trabajo

- Al cerrar cada fase o unidad entregable probada, revisar diff/docs y hacer un
  commit local. Registrar bugs en [BACKLOG.md](BACKLOG.md); reparar los que bloqueen
  la especificación de la unidad y diferir los demás con prioridad/fase límite.
- Una unidad vertical y revisable por sesión; una fase puede necesitar varias.
- Leer AGENTS, arquitectura, ADR y estado antes de editar. Verificar primero código
  real y cambios locales; no completar checkboxes por suposiciones.
- Criterio de cierre: comportamiento, pruebas y actualización de estado/docs.
  UI con mocks no demuestra transporte; tests no sustituyen validación real.
- Fixtures y DB temporales, adapters falsos y proveedores simulados por defecto.
  No duplicar sesiones, resetear ni re-vincular producción para probar.
- Reutilizar pruebas existentes; añadir las de carreras, contratos y recuperación
  necesarias. No probar únicamente que una función llama otra función.
- Registrar limitaciones por plataforma. No decir que Windows/Termux funcionan
  si únicamente se comprobó Linux. No publicar ni desplegar por cerrar una fase.
- No ejecutar fases posteriores porque quede tiempo sin cerrar la unidad actual.
  Un bloqueo externo se registra y se avanza solo en trabajo independiente.

## Fase 0 — Línea base y compatibilidad

**Depende de:** ninguna. **Estado: completada; F1A también cerrada.**

- [x] F0.1 Inventariar entradas/salidas, generaciones de sockets, comandos, rutas,
  cursores y puntos de persistencia; producir `docs/BASELINE-CONVERSACIONES.md`
  con archivo/línea, hallazgo y prueba existente o faltante.
- [x] Ejecutar checks actuales de gateway/brain y smoke cuando el entorno lo permita;
  registrar versiones, comandos y resultados. Un fallo previo no se atribuye al cambio.
  Completado con smoke aislado sin transporte real; pairing/sync/entrega no validados.
- [x] F0.2 Probar en fixture temporal `node:sqlite`: versión mínima real, worker,
  WAL, transacciones, constraints, backup y cierre. Comprobar disponibilidad de
  runtime en Linux/Windows/Termux o registrar pendiente por plataforma. Decidir
  driver con evidencia y actualizar ADR-005 antes de añadir dependencia.
  Node >=22.13.0 sin flags en Linux; Windows/Termux pendientes. Sin dependencia
  externa ni DB runtime añadida. Script incluido en el job de CI para futuras ejecuciones.
- [x] F0.3 Fijar alcance v1, orden de IDs/aliases, retención inicial (90d
  historial), compatibilidad de handoff y estrategia de backup/corte/rollback.
  Definir presupuesto de carga y mediciones con fixtures reproducibles.
  Decisiones/75 ejemplos revisados, sin declarar implementación de servicios ni
  rendimiento aprobado. BUG-016 corregido en diseño; bugs runtime conservan sus puertas.

**Aceptación:** baseline con resultados reproducibles, riesgos concretos y siguiente
cambio acotado. Sin mover carpetas ni tocar credenciales/sesiones.

## Fase 1 — Contratos y frontera autenticada

**Depende de:** Fase 0.

Unidades: **F1A**, workspace/contratos/validación de formas y tipos; **F1B**,
frontera autenticada/identidad firmada y BUG-013 antes de exponer historial.
Cada unidad termina con pruebas y commit, sin marcar toda Fase 1 por cerrar F1A.

- [x] Crear `packages/contracts` y workspace Node mínimo sin mover apps actuales;
  registrar impacto en locks, CI y release-please. Mantener Python independiente.
  Raíz packages/*; gateway conserva paquete/lock y despliegue independientes.
- [x] OpenAPI/JSON Schema para cuenta, identidad, conversación, mensaje, control,
  operaciones, errores y eventos. IDs texto; límites y cursores documentados.
- [x] Validación runtime y generación/verificación de tipos. Tests impiden deriva
  entre schema, DTO servidor y cliente; contratos Python solo donde corresponda.
  F1A: 14 tests de formas/tipos, TXT-01 a 06 ejecutados; no políticas de dominio.
  Evidencia: [CONTRATOS-V1.md](CONTRATOS-V1.md).
- [x] Endpoint de sesión y contexto actor firmado panel -> gateway; validar firma,
  expiración, método/ruta/hash, permisos y principal local dev. No confiar actor
  del navegador. Conservar OAuth, origen y compatibilidad de rutas previas.
  F1B: sesión/errores validados, firma con replay acotado y grants servidor;
  proxy con timeout/SSE y /history brain protegido. El snapshot bootstrap de F1B
  ya fue sustituido por DB en F2A; páginas/SSE de conversaciones siguen F3. Evidencia:
  [FRONTERA-AUTENTICADA-V1.md](FRONTERA-AUTENTICADA-V1.md).

**Aceptación:** contratos válidos y pruebas de 401/403, actor falsificado, contexto
alterado/vencido y desarrollo explícito, sin conectarse a canales reales.

## Fase 2 — Historial durable y captura completa

**Depende de:** Fase 1. **Estado: F2A/F2B/F2C/F2D/F2E completas; carga de referencia pendiente.**
Evidencia: [ARCHIVO-CONVERSACIONES-F2A](ARCHIVO-CONVERSACIONES-F2A.md).
F2B.1 completa la puerta BUG-029/031 del reset CLI; evidencia en
[RESET-SEGURO-F2B1](RESET-SEGURO-F2B1.md). F2B integra WA; F2C Telegram/cursor;
F2D replay durable y F2E.1 salidas aceptadas/ecos; carga completa antes de cerrar F2.
Captura base WA probada en
[CAPTURA-WHATSAPP-F2B2](CAPTURA-WHATSAPP-F2B2.md); F2B.3 completa multimedia en
[MULTIMEDIA-WHATSAPP-F2B3](MULTIMEDIA-WHATSAPP-F2B3.md). BUG-037 descarga sin
abort físico queda como puerta de aceptación STT real F8, sin prometerlo aquí.

- [x] Repositorios y migraciones SQLite para cuentas, identidades, mensajes,
  conversaciones y eventos. Worker único; constraints e índices para consultas.
- [x] Antes de escribir estado, agregar `SDK_CONVERSATIONS_DB_PATH`, DB/WAL/SHM,
  .gitignore, inventario factoryReset y volumen. Cursor TG será parte de F2C.
  Backup/restauración y cierre sin pérdida probados con temporales. No cambiar rutas de credenciales existentes.
- [x] F2B.1 Antes de captura: reset CLI rechaza supervisión/inspección incierta y
  verifica parada antes de borrar. Brain respeta su lock configurado. BUG-029/031
  cerrados con procesos/estado temporales; no es prueba de captura ni control.
- [x] F2B.2 Captura base de todos los elementos WA admitidos (live/append/history),
  timestamps originales, cuenta estable y dedup/aliases exactos. SQLite antes de
  legacy/cache, guardas de socket y reconexión solapada; BUG-001/002/003/032
  cerrados. FIFO 1000/32MiB, desbordamiento visible sin ack ficticio. Purga
  inicial/diaria acotada; Node22/24 y entry real con transporte simulado probados.
- [x] F2C.1 Dueño único en descubrimiento/polling Telegram. BUG-004/038–042
  cerrados: observación del adapter configurado sin lector/offset extra, cierre HTTP
  antes de reemplazo, offset RAM separado al cambiar token y setup parcial usable.
  [Evidencia](TELEGRAM-DUENO-UNICO-F2C1.md); esto no prueba ACK/captura durable.
- [x] F2C.2 Captura Telegram antes de calcular el offset siguiente. `getMe`
  establece `telegram_bot:<id>` como cuenta estable, sin token en SQLite. Mensajes,
  huellas, eventos/proyección y cursor se confirman juntos; updates válidos de
  administración, grupos y tipos excluidos avanzan en la misma transacción.
  IDs JSON grandes conservan precisión, el mismo `message_id` en chats/cuentas
  distintos no colisiona y el STT de audio actualiza el mismo mensaje. Cierra
  BUG-005/009/044/047 y la parte de archivo TG de BUG-008; BUG-008 conserva su alcance
  legacy de resolución por dígitos. [Evidencia](TELEGRAM-CAPTURA-F2C2.md).
- [x] F2D Replay durable de mensajes archivados tras reinicio (BUG-045): outbox
  SQLite v3 en la misma transacción que captura/cursor, reanudación cuando el canal
  está conectado, ACK persistente y espera STT. Prueba cae entre commit y wake,
  reinicia y confirma una entrega y ningún redespacho después del ACK. El retry es
  at-least-once ante efectos/ACK ambiguos (BUG-050); la migración no reencola filas
  pre-v3 (BUG-051). [Evidencia](REPLAY-LEGACY-F2D.md).
- [x] Persistir entrada live aunque IA esté pausada, ignorando o en handoff/human;
  WA F2B.2 y TG F2C.2 archivan antes del pipeline. Chats administrativos/grupos
  quedan fuera del archivo de clientes. Cobertura en CAPTURA-WHATSAPP-F2B2 y
  TELEGRAM-CAPTURA-F2C2.
- [x] F2E.1 Registrar salidas WA/TG aceptadas y deduplicar eco WA por ID de
  proveedor; conservar `external_self` mientras no haya origen correlacionado.
  HTTP 200 `{ok:false}` no se considera envío. [Evidencia](SALIDAS-ACEPTADAS-F2E1.md).
- [x] F2E.2 Ejecutar el dataset reproducible de [VALIDACION-V1](VALIDACION-V1.md):
  1M mensajes/2.000 chats/5 cuentas, redelivery, cinco runs concurrentes, métricas,
  saturación, snapshot y reapertura. BUG-055 quedó cerrado al comprobar 50.000 eventos
  exactos tras los 2.700 mensajes nuevos. [Informe](F2E2-CARGA-COMPLETA.md).
- [x] F2B.3 Multimedia durable: BUG-033/034/036 reparados. Mismo ID/huella;
  pending/completed/failed y message.updated antes de legacy, captions por tipo,
  purga sin recreación, recuperación de pendientes y trabajos acotados. Apagado
  conserva not_requested; history/duplicados sin STT/IA. Node22/24 e imagen probados.
- [x] Mientras se migra, contactos/settings JSON siguen siendo autoridad detrás de
  repositorios; SQLite es autoridad del nuevo archivo de mensajes/eventos. No
  introducir un segundo estado de control activo en competencia con JSON.

**Aceptación:** reinicio conserva mensajes; lote, reimportación y ecos no duplican;
canales/cuentas/IDs con signo no colisionan; audio fallido sigue visible. Carga con
miles de mensajes sin bloquear pings del transporte falso; progreso observable.
F2C.2 prueba reapertura/cursor y redelivery; F2D prueba replay post-commit; F2E.1
prueba salida aceptada y eco WA; F2E.2 conserva volumen, deduplicación y rendimiento
de archivo. El entorno medido (3 CPU/10,45 GiB) difiere de la referencia
(2 CPU/4 GiB), por lo que repetir allí antes de certificar ese perfil. Control/toma
de control y atribución de autoría outbound quedan para F5.

## Fase 3 — API de lectura y eventos en vivo

**Depende de:** Fase 2.

- [x] F3.1: listar conversaciones y mensajes con paginación por cursor, orden estable,
  filtros y límites. Búsqueda de contacto; no prometer búsqueda de texto aún.
- [x] F3.1: detalle con cobertura de historial, autoría y capacidades del canal;
  etiqueta de contacto nullable sin exponer identidades del proveedor.
- [x] F3.1: cursor de lectura monotónico por actor separado de recibos remotos;
  conteo de no leídos respaldado por SQLite y durable tras reinicio.
- [x] F3.2: SSE con eventos tras commit, watermark, replay, deduplicación y
  resync.required. Cerrar carrera replay/vivo y soportar cursor fuera de retención.
- [x] F3.1: autorizar lectura por sesión firmada/capacidad y validar respuestas
  JSON del proxy con contratos v1; no exponer raw/secretos/rutas locales.
- [x] F3.2: probar autorización SSE, proxy, desconexión, cierre de recursos y falta
  temporal del gateway. Los grants activos duran como máximo 30 s y se revalidan
  al reconectar.
  Resolver BUG-024 antes de operadores limitados: grants v1 deben acompañarse de
  autorización administrativa legacy.

**Aceptación F3.1:** respuestas de lectura conformes al contrato; páginas sin
duplicados con timestamps iguales; cursores de lista se invalidan ante cambios de
snapshot, agenda, política o lectura. **Aceptación F3.2:** mismo resultado al leer
y reanudar stream; no perder eventos entre snapshot y suscripción; resync explícito
al vencer la retención. Revisar actualización de lista ante mensajes nuevos.
Evidencia F3.1: [lectura autenticada](F3.1-LECTURA-AUTENTICADA.md). F3.2:
[SSE, replay y resync](F3.2-STREAM-SSE-REPLAY.md).

## Fase 4 — Bandeja de lectura y sistema visual

**Depende de:** Fase 3.

- [x] **F4.1 — shell visual:** app React/TS/Vite, tokens, navegación lateral,
  controles accesibles, router, TanStack Query y feature flag/ruta de transición.
  Layout de tres columnas en escritorio, una en móvil; conserva el chat activo en
  URL. No inventa conversaciones. Evidencia: [F4.1](F4.1-SHELL-VISUAL.md).
- [x] **F4.2 — lectura HTTP real:** lista y filtros de conversaciones, selección
  enlazada a URL, detalle, historial paginado, estados de carga/error/vacío y ficha
  contextual desde la API autenticada del panel. Mocks exclusivamente en pruebas.
  Cursor de lectura local por secuencia inbound; no envía recibos remotos.
  Evidencia: [F4.2](F4.2-LECTURA-HTTP-REAL.md). BUG-063 corregido.
- [x] **F4.3 — actualización en vivo:** SSE integrado con caché, ancla de scroll,
  contador de novedades, reconexión y resync. El replay pagina hasta solapar con
  el snapshot cargado, sin reconstruir todo el hilo por cada evento. Evidencia:
  [F4.3](F4.3-STREAM-INBOX.md).
- [x] Build Vite servido por el proceso existente bajo `/inbox`; pruebas de
  componentes y del artefacto servido. Mantener el panel antiguo en `/` hasta
  completar sustitución. La validación visual de viewport real se registra por
  separado; el shell tiene CSS responsive y una prueba de acceso por teclado.

**Aceptación F4:** leer hilos largos y reconectar sin saltos ni mensajes duplicados;
navegación por teclado probada. La validación visual en viewport móvil sigue pendiente.
Compositor todavía no ofrece enviar.

## Fase 5 — Control exclusivo, salida y contexto IA

**Depende de:** Fases 2–4.

- [ ] Introducir coordinación por conversación, controlVersion y jobs cancelables
  en debounce, pool global, petición, typing, pausas, reintentos y cola persistente.
  Migrar o invalidar explícitamente trabajos JSONL previos y operaciones pendientes;
  no reproducir trabajos con permisos/versiones obsoletos tras reinicio.
- [ ] Migrar autoridad de acceso/control a SQLite mediante importación verificable
  de contactos/handoff. JSON queda como fuente previa de rollback/exportación,
  sin doble autoridad. Mapeo conservador: handoff -> human sin autorizar IA;
  accessPolicy previa desconocida -> neutral. Confirmar la nueva semántica de TTL.
- [ ] Comandos legacy y endpoints de estado llaman al mismo servicio de control;
  reemplazar búsqueda ambigua de dígitos con identidad exacta por canal/cuenta.
  Conservar aliases y explicar el cambio a control explícito sin caducidad.
- [ ] Implementar takeover/release/operaciones con versión, propietario y auditoría;
  estado tomando control mientras se drenan envíos ya iniciados con timeout.
- [ ] Outbox y SendMessage comunes a humano/IA/avisos; reconducir `/notify` y
  envíos directos. Campañas usan el puerto común conservando su política/intent.
- [ ] Idempotencia de mensajes, intento antes de red, estados reales y
  delivery_unknown. Recuperación tras crash sin reenvío automático de ambiguos.
- [ ] Brain GenerateReply con generationId y contexto explícito/versionado o
  protocolo equivalente de confirmación. Incluir mensajes humanos; invalidar
  memoria de respuestas canceladas; confirmar solo globos realmente enviados.
- [ ] Release future_only por defecto; no resucitar buffers viejos. Pausa global
  corta IA pero conserva archivo y respuesta manual autorizada.

**Aceptación obligatoria con transportes/proveedores falsos:**

| Escenario | Resultado requerido |
|---|---|
| Takeover durante debounce, pool, generación, typing o entre globos | Ningún envío IA nuevo atraviesa la barrera tras el cambio de control. |
| Takeover con envío de red ya iniciado | Estado pendiente; informar lo enviado/incierto y habilitar humano tras confirmación. |
| Reinicio en human | Continúa human, sin TTL accidental ni jobs viejos reactivados. |
| Doble click, timeout HTTP del panel, dos pestañas | Misma intención se ejecuta una vez localmente; versiones viejas reciben 409. |
| Caída tras aceptación del proveedor | delivery_unknown/reconciliación; ningún retry ciego que duplique. |
| Operador escribe desde teléfono | Eco registrado se reconcilia; salida propia desconocida suspende IA y aparece con procedencia. |
| Human -> IA tras varios mensajes humanos | IA recibe ese contexto; ninguna respuesta cancelada figura como enviada. |
| /limpiar memoria | Invalida contexto sin borrar historial ni reimportar el tramo limpiado. |

## Fase 6 — Responder desde el chat y cerrar v1

**Depende de:** Fase 5.

- [ ] Cabecera Tomar control/Devolver a IA; compositor condicionado a estado confirmado,
  permisos y propietario; estados taking_control, conflicto y envío incierto claros.
- [ ] Envío optimista por clientMessageId, reconciliación por evento/HTTP y borrador
  conservado si falla. Reintento ambiguo exige acción expresa informada.
- [ ] Resolver/reabrir y lectura; devolver a IA conserva permisos y permite elegir
  procesar pendientes, sin activarlo de forma silenciosa.
- [ ] E2E completo: entrada -> hilo -> takeover -> mensaje humano -> recepción de
  cliente durante human -> release -> siguiente respuesta IA con contexto correcto.
- [ ] Smoke manual documentado en cuenta de prueba WA/TG cuando esté disponible;
  una única instancia y resultados separados de simulación. No ejecutar reset para
  fabricar datos. Registrar si la validación externa queda pendiente.

**Aceptación:** flujo operativo completo, reinicios/reconexión, móvil y teclado.
Esta es la v1 útil; publicar/desplegar es una acción separada, no automática.

## Fase 7 — Sustituir el resto del panel

**Depende de:** v1 estable.

- [ ] Resumen orientado a decisiones con métricas reales y periodos explícitos.
- [ ] Contactos con permisos/perfiles y ficha compartida con bandeja.
- [ ] Canales con pairing existente, ventana QR de 140s, código manual y estados
  restaurables. No alterar exclusión QR/código ni crear otro gateway.
- [ ] Asistente: perfiles, editor, cambios sin guardar e importación/exportación.
- [ ] Sistema: logs, terminal, diagnóstico y mantenimiento; preservar confirmación
  de factory reset. Campañas tienen su espacio cuando haya flujo completo.
- [ ] Inventario de paridad: cada función antigua sustituida, descontinuada de forma
  expresa o aún disponible. Retirar panel viejo después de esa comprobación.

**Aceptación:** paridad funcional documentada, sin perder OAuth, pairing, comandos,
perfiles o reset por un cambio visual.

## Fase 8 — Estructura final y operación

**Depende de:** límites estables y v1; movimientos pequeños pueden adelantarse si
son necesarios para una fase previa y pasan sus mismas comprobaciones.

- [ ] Mover gateway, panel, brain y STT a apps/ uno a uno; imports/entrypoints y
  perfiles siguen funcionando. Compartir solo contratos/testkit, no estados runtime.
- [ ] Migrar settings/campañas restantes por repositorios con corte verificable;
  retirar accesos JSON directos. Revisar locks y release-please al mover paquetes.
- [ ] Actualizar Dockerfiles multi-stage, Compose, CI, launchers de Linux/Windows/
  Termux y artefactos frontend. Mantener volúmenes/rutas de credenciales existentes.
- [ ] Runbook backup/restauración, retención/exportación/purga, rollback de código y
  datos, métricas y logs con datos de cliente minimizados.
- [ ] Ensayar migración/restauración con fixture representativo y delta posterior
  al corte; no perder envíos nuevos restaurando snapshots antiguos.

**Aceptación:** instalación limpia y upgrade simulados; build/checks/smoke en Linux;
Windows/Termux con evidencia real o pendientes explícitos. Ningún doble transporte.

## Fase 9 — Multimedia y búsqueda de mensajes

**Depende de:** v1 y política de almacenamiento definida.

- [ ] Persistir metadatos/archivos con acceso autenticado, límites y retención.
- [ ] Audio, imágenes, documentos, citas, ediciones y borrados según capacidades;
  no simular recibos de entrega/lectura que Telegram no entrega al bot.
- [ ] SQLite FTS para búsqueda del contenido con índices y páginas verificables.
- [ ] Registrar adjuntos/índices en backup/factory reset y probar acceso/purga.

**Aceptación:** adjuntos accesibles solo al operador autorizado; mensaje permanece
comprensible si el archivo expiró o no está disponible.

## Fase 10 — Asistencia al operador y herramientas IA

**Depende de:** contexto/autoría robustos y política explícita de capacidades.

- [ ] Resúmenes, borradores y propuestas de respuesta con referencias al hilo.
- [ ] Contratos de herramientas: schemas, permisos, timeout, auditoría, idempotencia
  y separación read/write. Gateway ejecuta; brain solicita sin acceder a canales.
- [ ] ADR para efectos externos/equipos si se solicitan; no activar automáticamente
  CRM, calendarios, mensajes externos ni cambiar SDK/proveedores por disponibilidad.
- [ ] Evaluaciones con conversaciones sintéticas: no enviar en human, no confundir
  notas con mensajes entregados, no usar datos de otra cuenta y reconocer límites.

**Aceptación:** asistencia comprobable que respeta control humano y permisos.

## Cierre obligatorio de cada sesión

Actualizar SESSION-STATE con unidad trabajada, resultado comprobado, archivos,
comandos/resultados, pendientes, decisiones nuevas y próxima tarea exacta. Marcar
solo checkboxes demostrados; ajustar este orden si una dependencia real lo exige.
El prompt es estable; el estado cambia. No abrir otra hoja de ruta en paralelo.

## Pendientes heredados conservados

La antigua Fase 9 trataba consolidación multicanal y seguridad. No se borra su
intención ni se toman sus checkboxes como evidencia:

- Índices Map ya existen: Fase 0 debe verificar rendimiento/cobertura antes de
  concluir si quedan optimizaciones pendientes.
- Sync de agenda y reconexión con diálogo activo requieren pruebas de carga y
  validación real; se enlazan con Fases 2, 5 y 6.
- El reset total y una nueva vinculación requieren cuenta de prueba y alcance
  explícito; no forman parte de las verificaciones de esta sesión documental.
- La seguridad del panel existente se conserva y se amplía en Fases 1 y 3.
