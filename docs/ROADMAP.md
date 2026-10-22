# Hoja de ruta: plataforma de conversaciones SDK-Bot

Actualización: 2026-10-22. Arquitectura: [ARCHITECTURE.md](ARCHITECTURE.md).
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
  F7.3 cerró BUG-024: la UI y todas las rutas legacy requieren `admin:write`
  explícito; el acceso de solo lectura a la nueva bandeja queda disponible.

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

- [x] **F5.1 — Estado de control durable:** SQLite v5 conserva acceso, modo,
  lifecycle, propietario y versiones por conversación. CAS actualiza controlVersion
  y aggregateVersion junto con el evento/auditoría en una transacción. Los defaults
  de migración son neutrales y con IA apagada. JSON sigue alimentando las lecturas
  hasta el corte verificable. Evidencia: [F5.1](F5.1-CONTROL-DURABLE.md).
- [x] **F5.2 — Importación dry-run:** leer JSON sin mutarlo; checksum por origen,
  reglas conservadoras de handoff/permisos, identidades exactas, conflictos y
  cuarentena. El informe cuadra origen/importado/cuarentena/exclusiones y permite
  revisión; no cambia autoridad ni inicia IA. CLI de solo lectura, bloquea gateway
  activo/WAL pendiente. Evidencia: [F5.2](F5.2-IMPORT-DRY-RUN.md).
- [x] **F5.3 — Staging y corte de autoridad:** esquema v6, importación idempotente
  por migrationId, snapshot de fuentes/archivo, staging y verificación por lotes,
  delta y rollback recuperable. Bajas/remapeos bloquean salvo aceptación explícita;
  JSON se conserva. Si el corte cae a mitad, el gateway falla cerrado y exige
  reanudar o rollback. La autoridad permanece legacy hasta que F5.4 registre el
  servicio SQLite listo. Handoff vencido sigue human explícito. Evidencia:
  [F5.3](F5.3-STAGING-CUTOVER.md).
- [x] **F5.4 — Servicio de control compartido y activación:** takeover/release/
  resolver y cambios de acceso con expectedVersion, actor/propietario, auditoría y
  operación recuperable mientras drena una salida ya iniciada. API, comandos legacy
  y estado llaman el mismo dominio; resolución exacta por canal/cuenta, sin dígitos
  ambiguos. El gateway registra servicio listo y el corte verificado cambia la
  autoridad a SQLite. Migración v6→v7 conserva eventos y agrega operaciones
  recuperables; la aceptación de corte se ejecutó sobre fixtures, sin datos runtime.
  Evidencia: [F5.4](F5.4-CONTROL-SERVICE.md).
- [x] **F5.5 — Barrera y coordinación de jobs:** serializar por conversación y
  comprobar controlVersion, policyVersion y contextVersion en debounce, pool,
  generación, typing, pausas, retries y cada globo. Cancelar trabajos obsoletos;
  al activar SQLite se archiva la cola JSONL heredada para impedir replay tras
  reiniciar. Evidencia: [F5.5](F5.5-JOB-BARRIER.md).
- [x] **F5.6 — Outbox y salida común:** SendMessage para persona/IA/avisos y puerto
  de campañas con su intent/política. Persistir intención antes de red, usar
  idempotencia local, estados reales y delivery_unknown; una respuesta ambigua
  tras crash queda para reconciliar, sin retry automático ciego. Reconducir `/notify`
  y envíos directos. Evidencia: [F5.6](F5.6-OUTBOX.md); outbox SQLite v8, pruebas
  de concurrencia/reinicio y campañas heredadas pausadas ante ambigüedad.
- [x] **F5.7 — Contexto y reanudación IA:** GenerateReply con generationId y
  contexto explícito/versionado, incluir mensajes humanos, invalidar respuestas
  canceladas y confirmar solo globos enviados. Release usa `future_only`; la pausa
  global conserva captura y respuesta humana autorizada. Evidencia:
  [F5.7](F5.7-CONTEXTO-IA.md); archivo SQLite v9 y pruebas de replay/contexto.
- [x] **F5.8 — Aceptación integrada:** ejecutar la matriz siguiente con transportes
  falsos, incluyendo reinicios y fallos entre commit/red/ACK. Los defectos que no
  bloqueen la unidad se registran en backlog con prioridad y fase límite. Evidencia:
  [F5.8](F5.8-ACEPTACION-INTEGRADA.md); lint, tipos, panel y 310 pruebas Node pasan.

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

- [x] **F6.1** Cabecera Tomar control/Devolver a IA, resolver/reabrir y compositor
  condicionados a permisos, propietario y control confirmado. El compositor además
  requiere cuenta conectada y compatible. El envío usa outbox durable,
  `clientMessageId`, reconciliación de archivo/evento y borrador conservado; un
  resultado incierto exige confirmación informada para generar otro envío. Evidencia
  y límites: [F6.1](F6.1-ENVIO-HUMANO.md).
- [x] **F6.2** Devolver a IA conserva la política de acceso y permite elegir
  explícitamente `future_only` o seleccionar entradas pendientes verificables para
  procesarlas; nunca reanudar pendientes sin elección. Evidencia y límites:
  [F6.2](F6.2-REANUDACION-PENDIENTES.md).
- [x] **F6.3** Flujo integrado: entrada -> hilo -> takeover -> mensaje humano ->
  recepción de cliente durante human -> release explícito -> respuesta IA con
  contexto correcto. Evidencia y límites: [F6.3](F6.3-FLUJO-CONVERSACION.md).
- [x] **F6.4** Smoke manual en cuenta de prueba de WhatsApp; una única
  instancia y resultados separados de simulación. Telegram se usa para
  administración, así que el smoke de atención a clientes en ese canal no aplica.
  No ejecutar reset para
  fabricar datos. El recorrido live de WhatsApp incluyó takeover, respuesta
  humana, segunda entrada y release con `process_pending`; la respuesta IA figura
  enviada una vez. El 2026-10-22 también se verificó el hilo/compositor móvil a
  390 × 844 y 320 × 844 px; `ignored_all` quedó activo y el chat volvió a
  `neutral/off`. El recorrido Tab completo y el foco de `Tomar control` quedaron
  verificados. El contexto se comprobó con la traza del constructor live y la
  regresión integrada F6.3; no se conservó el JSON literal de la petición live.
  Las dos parejas teléfono/LID ambiguas permanecen en cuarentena, sin bloquear esta
  aceptación. Estado y evidencia: [F6.4](F6.4-SMOKE-CANAL.md).

**Estado: completada. Aceptación:** flujo operativo completo, reinicios/reconexión,
móvil y teclado.
Esta es la v1 útil; publicar/desplegar es una acción separada, no automática.

## Fase 7 — Sustituir el resto del panel

**Depende de:** v1 estable.

- [x] Resumen orientado a decisiones con métricas reales y periodos explícitos (unidad F7.1).
- [x] Contactos con permisos/perfiles y ficha compartida con bandeja (unidad F7.2).
- [x] **F7.3 — Canales:** estado de WhatsApp/Telegram desde API autenticada; pairing
  WhatsApp QR/código reutiliza el bus existente, restaura estados activos y respeta
  ventana QR de 140s/exclusión QR-código. No crea otra instancia. Telegram queda
  identificado como administrativo, con configuración sin lectura del token y sin
  ejecutar prueba de envío. BUG-024 cerrado con `admin:write`. Evidencia:
  [F7.3](F7.3-CANALES.md).
- [x] **F7.4 — Asistente:** perfiles con vista de solo lectura por metadatos v1 y
  edición protegida por `admin:write`, cambios sin guardar con confirmación,
  importación/exportación Markdown, recarga, prompt compilado y borrado confirmado.
  Evidencia: [F7.4](F7.4-ASISTENTE.md).
- [x] **F7.5 — Sistema:** logs Gateway/Brain, terminal administrativa,
  diagnóstico y mantenimiento; se conserva la doble confirmación del factory reset.
  La UI evita reintentar una operación cuyo resultado no se confirmó. Evidencia:
  [F7.5](F7.5-SISTEMA.md).
- [x] **F7.6 — Inventario de paridad:** cada función antigua queda identificada
  como migrada, deliberadamente fuera de React o disponible en el panel legacy.
  `/` se mantiene mientras existan detalles y operaciones legacy-only. Evidencia:
  [F7.6](F7.6-PARIDAD-PANEL.md).

**Aceptación:** paridad funcional documentada, sin perder OAuth, pairing, comandos,
perfiles o reset por un cambio visual.

**Unidad F7.1 — Resumen:** el panel React ofrece periodos móviles de 7 y 30 días,
expresados como intervalos UTC `[from,to)`. Los conteos salen de mensajes entrantes
archivados y salidas de conversación aceptadas, con desglose WhatsApp/Telegram y
fecha mínima disponible de entradas. La API limita cada consulta a 90 días y exige
`conversations:read`; no expone identidades ni texto de mensajes. La Fase 7 sigue
abierta para las demás secciones y el inventario de paridad.

**Unidad F7.2 — Contactos:** `/inbox/contacts` pagina conversaciones archivadas,
busca por nombre y filtra por canal. Los campos de teléfono/JID/ID remoto no se
exponen. La vista permite editar acceso y perfil por conversación mediante PATCH
v1 con `controlVersion` y `conversations:write`; actores de solo lectura ven valores
sin controles de edición. La ficha de Bandeja muestra los mismos valores. `GET
/profiles` entrega solo claves/nombres, y la actualización valida el inventario de
perfiles en ControlService. No se añadieron operadores con grants limitados ni se
usaron rutas legacy para estas acciones; BUG-024 conserva su alcance explícito.

**Unidad F7.4 — Asistente:** `/inbox/assistant` preserva la paridad de perfiles
Markdown con protección de permisos. Las sesiones de solo lectura consultan solo
metadatos v1; `admin:write` habilita el contenido y las operaciones legacy ya
protegidas desde F7.3. Se conservan borradores al rechazar una operación y se
confirma antes de descartarlos, sobrescribir claves existentes o eliminar perfiles.
La importación y exportación trabajan con archivos locales; exportar incluye el
texto editado aunque aún no se haya guardado. El brain mantiene la validación de las
secciones requeridas y el perfil `default` no se puede eliminar. Véase [F7.4](F7.4-ASISTENTE.md).

## Fase 8 — Estructura final y operación

**Depende de:** límites estables y v1; movimientos pequeños pueden adelantarse si
son necesarios para una fase previa y pasan sus mismas comprobaciones.

- [x] Mover gateway, panel, brain y STT a apps/ uno a uno; imports/entrypoints y
  perfiles siguen funcionando. Compartir solo contratos/testkit, no estados runtime.
  F8.1a movió STT a `apps/stt/`; F8.1b movió Gateway a
  `apps/gateway/`; F8.1c movió el panel a `apps/panel/` con paquete y lockfile
  propios; F8.1d movió código, tests y requirements de Brain a `apps/brain/`.
  Las rutas `.env`, perfiles y estado permanecen en `brain/`.
- [x] Migrar settings/campañas restantes por repositorios con corte verificable;
  retirar accesos JSON directos de los servicios. F8.2a y F8.2b separan campañas
  y settings en repositorios; los formatos/rutas JSON existentes se conservan y
  el corte se verifica con reinicio simulado y snapshot de control SQLite vigente.
  No se migraron los archivos runtime. Revisar locks y release-please al mover paquetes.
- [x] Actualizar Dockerfiles multi-stage, Compose, CI, launchers de Linux/Windows/
  Termux y artefactos frontend. Mantener volúmenes/rutas de credenciales existentes.
  Linux, Compose y Docker se verificaron en esta sesión. Windows y Termux tienen
  launchers/documentación actualizados; falta la prueba real en esos sistemas.
- [ ] Runbook de operación y recuperación: backup/restauración,
  retención/exportación/purga, rollback de código/datos y minimización de métricas/logs.
  - [x] F8.3a — [Inventario y captura offline del volumen de estado; documentar
    el límite de recuperación y validar copias solo en un volumen aislado](F8.3-OPERACION-RECUPERACION.md).
  - [x] F8.3b — [Documentar retención efectiva, purga global disponible y límites
    de exportación/borrado por solicitud](F8.3-OPERACION-RECUPERACION.md).
  - [x] F8.3c — [Rollback de código sin rollback de datos y recuperación del
    corte de control antes del cambio de autoridad](F8.3-OPERACION-RECUPERACION.md).
  - [x] F8.3d — [Minimizar datos de cliente en métricas y logs, con pruebas](F8.3-OPERACION-RECUPERACION.md#f83d--minimizacion-de-datos-en-metricas-y-logs).
- [x] F8.4 — Ensayar migración/restauración con fixture representativo y delta
  posterior al corte; bloquear snapshots obsoletos por cursor, autoridad o ledger
  de envíos y metadatos de adjuntos. F9.4 amplía luego la puerta para validar
  los blobs físicos y el índice FTS.
  [Runbook y límites](F8.3-OPERACION-RECUPERACION.md#f84--ensayo-aislado-y-puerta-de-frescura-de-restore).

**Aceptación:** instalación limpia y upgrade simulados; build/checks/smoke en Linux;
Windows/Termux con evidencia real o pendientes explícitos. Ningún doble transporte.

## Fase 9 — Multimedia y búsqueda de mensajes

**Depende de:** v1 y política de almacenamiento definida.

- [x] Persistir metadatos/archivos con acceso autenticado, límites y retención.
  F9.1 añade descarga autenticada por conversación, archivo privado de 16 MiB
  máximo, cuota total de 1 GiB y purga a 90 días. F9.2 conecta las descargas live
  que cada canal permite. [Evidencia F9.1](F9.1-ADJUNTOS.md).
- [x] Captura live de audio, imágenes, documentos y video por WhatsApp/Telegram;
  citas y ediciones de mensajes disponibles; revocación WhatsApp redacta contenido
  y borra el adjunto. Telegram no aporta borrado general ni recibos para mensajes
  normales de bots; no se simulan. [Evidencia](F9.2-MULTIMEDIA-CANALES.md).
- [x] SQLite FTS5 para búsqueda de texto, captions y transcripciones con páginas ligadas a un snapshot verificable. [Evidencia F9.3](F9.3-BUSQUEDA-FTS.md).
- [x] F9.4 — Integrar ledger, blobs e índice FTS en la puerta de
  backup/restauración y ensayar el ciclo completo en destino aislado.
  [Evidencia](F9.4-BACKUP-RESTORE.md).

**Aceptación:** adjuntos accesibles solo al operador autorizado; mensaje permanece
comprensible si el archivo expiró o no está disponible.

## Fase 10 — Asistencia al operador y herramientas IA

**Depende de:** contexto/autoría robustos y política explícita de capacidades.

- [x] Resúmenes, borradores y propuestas de respuesta con referencias al hilo.
  [Evidencia F10.1](F10.1-ASISTENCIA-OPERADOR.md).
- [x] Contratos de herramientas: schemas, permisos, timeout, auditoría, idempotencia
  y separación read/write. Gateway ejecuta; brain solicita sin acceder a canales.
  [Evidencia F10.2](F10.2-HERRAMIENTAS-IA.md).
- [ ] ADR para efectos externos/equipos si se solicitan; no activar automáticamente
  CRM, calendarios, mensajes externos ni cambiar SDK/proveedores por disponibilidad.
  Condicional: no hay efectos externos solicitados; nada se habilita en F10.2.
- [x] Evaluaciones con conversaciones sintéticas: no enviar en human, no confundir
  notas con mensajes entregados, no usar datos de otra cuenta y reconocer límites.
  [Evidencia F10.4](F10.4-EVALUACIONES-SINTETICAS.md).

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
