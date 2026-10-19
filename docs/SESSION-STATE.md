# Estado de continuidad — SDK-Bot

Actualización: 2026-10-19. Última unidad cerrada: **F2B.2; captura base WA conectada y probada**.

## Objetivo vigente

Plataforma multicanal con bandeja tipo WhatsApp Web, historial persistente,
respuesta humana desde el chat y retorno seguro a IA con contexto actualizado.

## Resultado acumulado

- Política acordada: commit local al cerrar cada fase/unidad probada y bugs en
  [BACKLOG.md](BACKLOG.md). Reparar bloqueantes de la especificación actual;
  diferir los demás con prioridad, fase límite y aceptación.
- Base arquitectónica, ADR-005, roadmap, prompt reutilizable y orientación en
  AGENTS/README creados en la sesión inicial.
- F0.1 completada: [BASELINE-CONVERSACIONES.md](BASELINE-CONVERSACIONES.md) inventaría
  captura, identidad, sockets/polling, comandos, persistencia, generación/envío,
  handoff, endpoints, UI y cobertura existente con referencias de archivo/línea.
- Commit de cierre F0.1: `9155212`, incluye base documental y backlog.
- F0.2 completada: [SQLITE-SPIKE.md](SQLITE-SPIKE.md), script temporal reproducible,
  driver node:sqlite con worker y mínimo sin flags Node 22.13.0 comprobado en Linux.
  Backup VACUUM INTO; Windows/Termux pendientes. CI prepara ejecutar el script.
- Commit de cierre F0.2: `f69ac1d`.
- F0.3 completada: [SPEC-OPERATIVA-V1.md](SPEC-OPERATIVA-V1.md) fija identidades,
  permisos/control/versiones, retención, corte/rollback y límites; 75 escenarios
  sintéticos de aceptación futura y protocolo de medición en VALIDACION-V1.
- F1A completada: workspace raíz packages/* y contracts con JSON Schema/OpenAPI,
  validadores AJV y tipos TS generados; CI de contratos. Gateway conserva su lock
  y despliegue independientes. Evidencia: [CONTRATOS-V1.md](CONTRATOS-V1.md).
- F1B completada: sesión v1, actor/grants servidor, firma panel → gateway, límites
  HTTP/SSE y /history brain autenticado. Contratos instalados en gateway/Docker.
  Evidencia: [FRONTERA-AUTENTICADA-V1](FRONTERA-AUTENTICADA-V1.md).
- F2A: worker SQLite, repositorios, migración, dedup/aliases/cuarentena, eventos,
  retención/backup de repositorio y snapshot durable en sesión. Evidencia:
  [ARCHIVO-CONVERSACIONES-F2A](ARCHIVO-CONVERSACIONES-F2A.md).
- F2B.1: parada segura del reset CLI, rechazo de supervisión antes de señales y
  comprobación de identidad/parada; brain publica lock configurable. BUG-029/031
  cerrados. Evidencia: [RESET-SEGURO-F2B1](RESET-SEGURO-F2B1.md).
- F2B.2: captura base WA live/history antes de legacy, identidad/cuenta exactas,
  cola acotada, guardas de socket y purga inicial/diaria. BUG-001/002/003/032
  cerrados. [ADR-006](adr/006-admision-durable-en-adapter.md) documenta la espera
  de admisión en el adapter antes del consumidor legacy. Evidencia:
  [CAPTURA-WHATSAPP-F2B2](CAPTURA-WHATSAPP-F2B2.md).
- Sin migrar datos antiguos ni conectar cuentas reales. No hay bandeja nueva, páginas/SSE públicos,
  API de envío/control ni barrera de automatización v1.

## Validación ejecutada en F0.1

Los comandos se ejecutaron sobre copia temporal de archivos versionados con
contenido actual, enlazando únicamente dependencias instaladas. Sin copiar .env,
sesiones ni DB del workspace; brain también escribió logs dentro de la copia.

| Comando/entorno | Resultado |
|---|---|
| gateway: npm run check, Node 24.19.0 | Lint, typecheck y 143 pruebas pasan. |
| gateway: npm exec --yes --package=node@22 -- sh -c 'node --version && npm run check', Node 22.23.3 | Lint, typecheck y 143 pruebas pasan. |
| brain: venv/bin/ruff check ., Python 3.12.14 / ruff 0.17.1 | Sin hallazgos. |
| brain: venv/bin/python -m pytest tests/ -q | 21 pruebas pasan. |
| bash deploy/linux/tests/dev-smoke.sh con preload offline WA y TG sin token | Launcher/health/apagado pasan; puertos liberados. |

Smoke de procesos con transporte sustituido: no demuestra pairing, sync, OAuth,
entrega externa ni STT/IA real. No se llamó a proveedores ni se usaron credenciales.
No se ejecutó npm ci limpio. No se observaron fallos previos en los checks hechos.
Detalles de reproducción y logs efímeros están en la baseline.

## Validación ejecutada en F0.2

- `npm run spike:sqlite`: 10 comprobaciones pasan en Linux x64 con Node 22.13.0,
  22.23.3 y 24.19.0; worker/WAL, rollback, aislamiento, cursor, concurrencia,
  lote 5000, backup/restauración y reapertura. Temporales eliminados.
- Fallo simulado después de escribir, en Node 22.13.0/24.19.0: conserva el error,
  código 1, workers cerrados y estado temporal eliminado. Cierra BUG-015.
- `npm run check` con Node 22.13.0 en copia temporal: lint, tipos y 143 pruebas
  pasan; el spike vuelve a pasar. Sin usar credenciales ni canales.
- Node 22.12.0 no carga node:sqlite sin flags; 22.13.0 no tiene sqlite.backup,
  por eso el experimento prueba VACUUM INTO. ExperimentalWarning visible en 22.
- No se repitió smoke/brain, cuyos módulos no cambiaron. No se hizo push ni se
  ejecutó GitHub Actions. Véase SQLITE-SPIKE para comandos/limitaciones.

## Hallazgos que condicionan implementación

- F2B.2 corrige el primer elemento del lote, la conexión live al cache y los
  callbacks de socket reemplazado. Multimedia aún tiene BUG-033/034.
- El descubridor testAndGetChatId todavía llama getUpdates fuera del adapter;
  el test de dueño único no cubre esa competencia indirecta.
- Telegram adelanta cursor en RAM sin ack durable del consumidor asíncrono.
- Handoff/pause no cancelan jobs admitidos ni protegen cada envío; flush de cola
  tampoco reevalúa el control. Brain guarda respuestas antes de entregarlas.
- Identidades/anti-bucle usan índices o IDs sin namespace suficiente; comandos
  por dígitos pierden signo TG y pueden resolver por coincidencias parciales.
- Los checks existentes no prueban estos escenarios de conversación completa.

## Validación ejecutada en F0.3

- Consistencia documental y JSON: 75 IDs de escenario únicos; matriz completa de
  36 combinaciones; UUID/IDs TG, handoff, cuarentena, retención, seis límites Unicode
  y cantidades del dataset/plazos revisados. Hash del fixture en VALIDACION-V1.
- BUG-016 de diseño corregido: deduplicación por identidad canónica verificada,
  sin tratar JID/LID del mismo hilo como dos chats distintos.
- No se cambió runtime ni se ejecutaron suites/benchmark del producto en esta
  unidad documental. Los escenarios aún deben ejecutarse contra implementaciones.

## Validación ejecutada en F1A

- Instalaciones limpias raíz/gateway en copia temporal sin secretos ni DB.
- Raíz npm run check: 14 tests, referencias OpenAPI válidas, tipos reproducibles y
  compilación con casos positivos/negativos pasan en Node 22.13.0 y 24.19.0 Linux.
- TXT-01 a TXT-06 ejecutados contra validador; ID-01 a 07 solo formas, sin demostrar
  resolución/aliases. El resto de escenarios sigue pendiente de servicios reales.
- Gateway npm run check: lint, tipos y 143 tests pasan Node 24.19.0; spike SQLite
  pasa sus 10 comprobaciones y elimina temporales. Brain/smoke no repetidos.
- npm ci --omit=dev en layout de manifiestos Docker resuelve dependencias gateway
  sin raíz. No se construyó imagen ni se ejecutaron canales/IA/GitHub Actions.
- BUG-017 corregido: generador marcaba defaults opcionales como requeridos;
  defaultNonNullable=false. Compilación reproduce fallo al reactivar opción;
  --check rechaza artefacto alterado. BUG-018 corregido: TextEncoder sustituye
  Buffer; test con global Buffer ausente. Bundle/navegador pendiente F4.
  BUG-001 a 014 siguen abiertos.

## Validación ejecutada en F1B

- Raíz npm ci y npm run check: 14 tests de contratos, generación y tipos pasan
  Node 24.19.0. Schemas/OpenAPI no cambiaron; cambió instalación/consumo runtime.
- Gateway npm ci limpio; npm run check pasa lint/tipos y **158 tests** en Node
  24.19.0 y mínimo 22.13.0 Linux. Comprobación final usa copias separadas por
  versión. Son 143 anteriores + 15 de frontera, no 158 casos de chat completo.
- Brain: ruff y 21 tests pasan, suite secuencial desde copia; /history prueba
  contenido privado denegado sin/con clave incorrecta y lectura con clave correcta.
  / y /health públicos. No hubo peticiones /chat ni llamadas a proveedores.
- Imagen de gateway construida en Docker con npm ci --omit=dev, contracts
  empaquetado sin symlink ni node_modules raíz. Dockerfile temporal conserva COPY/
  instalación/entrada reales y solo agrega mount de CA proxy al RUN npm ci para
  este cloud, con TLS verificado; certificado no queda en capas. No build Compose.
- Esa imagen (Node 22.23.3) pasa **15 tests de frontera con --network none**;
  proceso HTTP de panel/bus y OAuth simulado, sin iniciar gateway/index.js/canales.
  Verificado require contracts y precisión TG sin instalación raíz.
- Compose config validado con env_files vacíos temporales y secreto ficticio:
  rechaza ausencia del secreto, comparte variable gateway/panel, conserva comando
  node panel/index.js y bus sin puertos publicados. No se ejecutó compose up.
- bash -n pasa Linux y scripts Termux editados. No se ejecutó smoke del launcher:
  aunque puertos estaban libres, sus logs globales /tmp preexistían; se conservaron.
  Prueba previa de launcher offline sigue en baseline, sin atribuirla a esta unidad.
- Reproducción con panel de f0d2b13 confirma excepción por cookie/Referer dañados,
  OAuth no verificado aceptado, separadores faltantes de cookie y desvío de proxy
  por request-target absoluto; regresiones pasan en implementación nueva.
- BUG-013 y BUG-019 a 023 cerrados; BUG-010 proxy reparado, TG pendiente F5.
  BUG-025 también cerrado: panel/.env ya se excluye de Docker; canary falso
  reproduce inclusión con reglas anteriores y demuestra exclusión tras reparar,
  tanto en COPY directo como en imagen de producción sin ese archivo.
  BUG-024 registrado antes de roles limitados/F3. BUG-014 no bloqueó la suite
  secuencial y sigue abierto. No se marcaron resueltos bugs de captura/control.
- Evidencia efímera: /tmp/sdkbot-f1b-1xfiq0qs (logs de Node/imagen/reproducción).
  Sin .env/sesiones/DB nuevas en workspace, sin credenciales reales en fixtures.
  No push, despliegue, Google OAuth real, IA ni canales reales. GitHub Actions
  preparado, no ejecutado. Windows/Termux no ejecutados.

## Decisiones y puertas después de F1B

- SDK_PANEL_GATEWAY_SECRET >=32 bytes en ambos procesos; Compose lo exige.
  Producción/bind de bus expuesto sin secreto falla cerrado. Solo legacy local
  de desarrollo en loopback admite compatibilidad sin firma. Panel requerido sin
  OAuth no se abre ni habilita dev como fallback.
- PANEL_DEV_ACTOR=true requiere NODE_ENV=development y auth no forzada; grants
  PANEL_ACTOR_GRANTS por google:<sub> o dev:local, omisión solo lectura v1.
  Cookie OAuth anterior conserva legacy; requiere login nuevo para v1.
- Grants v1 no limitan todavía el administrador legacy: BUG-024 antes de ofrecer
  operadores limitados. No describir esto como un sistema global de roles de equipo.
- F1B usaba bootstrap volátil. **F2A ya lo sustituye** por epoch/seq del archivo;
  falta/fallo devuelve 503. Esto no habilita páginas/SSE de F3.
  PolicyVersion efectiva en memoria incluye pausa/modo/perfil global; F5 la hará
  durable. No usarla ahora para afirmar cancelación/entrega segura.
- Cache replay 10000 entradas/30s, no durable entre reinicios. F5 requiere ledger
  de idempotencia antes de mutaciones; no confundir requestId con Idempotency-Key.
- contracts es dependencia file: empaquetada (install-links=true), no workspace
  gateway. Repetir npm ci en gateway tras cambiar contracts. Docker copia fuente;
  launchers/updater detectan cambios. No depender de la instalación raíz en runtime.

## Validación ejecutada en F2A

- Gateway check (lint/tipos): **174 tests** en Node 24.19.0 y mínimo 22.13.0 Linux,
  copias separadas sin secretos/DB, dependencias instaladas enlazadas. No npm ci
  nuevo porque no cambiaron manifiestos. 158 anteriores +14 archivo +1 reset +1
  entry real offline. Raíz check: 14 contratos/generación/tipos pasan.
- Repositorios probados: transacción con rollback, identidad/cuenta exactas,
  JID/LID/dedup/procedencia, conflictos, IDs y secuencias >2^53, cobertura/history,
  páginas internas, marcadores multimedia/oversized, FIFO/saturación/timers,
  retención estricta y huellas después de borrar cuerpo, backup/restore con epoch.
- Otro proceso es eliminado con SIGKILL dentro de transacción sin commit: conserva
  anterior y revierte incompleto. No es prueba de pérdida de energía.
- Sesión firmada real usa snapshot del archivo; archivo cerrado →503 saneado.
  Entry real con WA sustituido/TG sin token prueba dos arranques, PID/lock
  configurables, epoch estable y SIGTERM 0. Smoke gateway+panel con puertos
  efímeros también pasa. Launcher global no repetido para conservar logs previos.
- Docker producción con contracts/npm ci --omit=dev construido; adaptación cloud
  solo mount CA temporal/TLS verificado en instalación. Pruebas sin red y profiles
  montados como Compose: **37 tests pasan**, Node 22.23.3. Primer run sin ese
  montaje falló un assert de profiles del fixture, corregido al montar el volumen. Sin compose up ni canales reales.
- BUG-026/027/028/030 reparados; BUG-029 nuevo pendiente antes de captura live F2B.
  BUG-016 ejecutado contra DB real; bugs de adapters/control no se cerraron.
- Evidencia efímera /tmp/sdkbot-f2a-kg__9opd. Brain/smoke launcher no repetidos,
  Windows/Termux/GitHub Actions no ejecutados. Sin push/despliegue/IA/OAuth real.

## Validación ejecutada en F2B.1

- Unidad acotada por AGENTS: cerrar la puerta de reset antes de conectar captura.
  F2B no se declara completada por esta corrección.
- Gateway npm run check: lint/tipos y **188 tests** pasan Node 24.19.0 y mínimo
  22.13.0 Linux, en copias independientes sin secretos/DB. Dependencias instaladas
  enlazadas; no npm ci nuevo. Son 174 previos +14 de guarda/CLI.
- Brain ruff y **23 tests** pasan, secuenciales: 21 previos +2 de lock configurable
  y fallo de arranque si no se publica. BUG-014 sigue abierto, no paralelizar Python.
- Reproducción de stopProcess de 37525a1 con supervisor falso confirma SIGTERM y
  reemplazo vivo; detector antiguo devuelve false ante cgroup systemd v2. Nueva
  guarda rechaza servicio antes de señales a gateway/brain y antes del borrado.
- Regresiones: supervisor simulado/reintento offline, PID/lock reemplazados,
  inicio durante parada, lock eliminado con proceso vivo, SIGKILL/permiso/fallo de
  inspección. CLI --yes real en hijos prueba aborto 1 y reset offline 0 sobre
  inventario temporal; nunca relanza en --yes. Otro hijo cierra SQLite real antes
  de borrar DB/WAL/SHM. Entry offline anterior sigue pasando en suite completa.
- No detector universal de supervisores ni barrera contra lanzamiento concurrente:
  detener supervisores antes del CLI y mantenerlos detenidos hasta finalizar.
  Cgroup de servicio ancestro se rechaza conservadoramente. No señales a servicios
  reales ni reset de datos originales. Windows/Termux requieren parada previa;
  no ejecutados. Rutas absolutas coherentes en procesos/CLI.
- Evidencia efímera /tmp/sdkbot-f2b1-llaak1dx. Sin cambios de manifiestos/contratos,
  no nuevos checks raíz, build Docker ni smoke launcher. Logs previos conservados.
  Sin proveedores/canales/OAuth reales, push ni despliegue.

## Validación ejecutada en F2B.2

- Gateway npm run check: lint/tipos y **204 tests** pasan Node 24.19.0 y mínimo
  22.13.0 Linux en copias independientes. 188 anteriores +15 captura/retención +1
  entry integrado. No npm ci nuevo: manifiestos/contratos no cambiaron.
- SQLite real y Baileys simulado: lotes/cuenta estable, cache live, restart/dedup,
  JID/LID y cuarentena, IDs entre chats/cuentas, history/append/eco inertes,
  malformed/oversized, cola 1000/32MiB, fallo después de commit sin retry,
  sockets obsoletos, STT tardío y reconexiones solapadas. Purga antes de admisión,
  acotada y con yield, falla cerrada si no puede iniciar.
- Ráfaga de 1001: 1000 admitidos, saturación visible, mensaje restante guardado
  cuando se reentrega. Heartbeat avanza; no demuestra presupuestos p95/p99 ni
  recuperación garantizada WA. La pérdida de proveedor sigue siendo posible.
- Entry real con transporte/auth sustituidos: dos ciclos SIGTERM 0 conservan tres
  mensajes/eventos, epoch/seq estables y cache reconstruida. IA pausada, sin envío.
- Docker de producción F2A ya instalado, código/tests actuales montados readonly,
  profiles como Compose y --network none: **52 tests** pasan Node22.23.3. No nueva
  imagen construida ni compose up; solo compatibilidad con dependencias/layout.
- Reproducción de adapter 4bb4ec3: lote 3 emite 1, eventos de socket viejo tienen
  efectos y auth antigua sustituye conexión nueva. Regresiones cierran
  BUG-001/002/003/032; 008 solo aislamiento de archivo y 009 corregido solo WA.
- Nuevos pendientes: BUG-033/034 antes de cerrar F2B (STT durable/tipo con caption);
  BUG-035 pairing async diferido F8. No se presentan marcadores como transcripciones
  persistidas ni unknown como autoría IA/humana confirmada.
- Evidencia efímera /tmp/sdkbot-f2b2-uh19lsui. Brain/contratos no cambiaron; sin
  repetir sus suites. Launcher global no repetido para conservar logs. Sin
  proveedores/cuentas/OAuth reales, push, despliegue, Windows/Termux ni carga completa.

## Siguiente unidad exacta: Fase 2 / F2B.3

**Entregable:** completar enriquecimiento multimedia WA (BUG-033/034), conservando
la captura base ya operativa. F2B no está cerrada. Telegram/ack sigue F2C;
generador/carga completa de VALIDACION es puerta de cierre de F2.

1. Leer AGENTS, estado, arquitectura/ADR005/006, SPEC/VALIDACION, informes F2A/F2B.1/
   [F2B.2](CAPTURA-WHATSAPP-F2B2.md) y backlog; revisar git status. Conservar
   worker SQL único, Node>=22.13 y guardas de reset/locks. No usar estado real.
2. BUG-033: repositorio de actualización de multimedia por ID original, transacción
   con aggregateVersion/evento message.updated. API interna acotada, no HTTP nuevo.
   No cambiar fingerprint del original al enriquecer; redelivery no es conflicto.
3. Audio base antes de STT; persistir pending/completed/failed y transcript antes
   de emitir texto al handler. Desactivado queda not_requested. Descarga vacía,
   timeout, error, reconexión y reinicio deben dejar estado veraz; no IA tardía.
   Actualización de cuerpo purgado no lo recrea; fallo conserva marcador y no
   inventa éxito. No bloquear captura por la espera STT.
4. BUG-034: conservar tipo de multimedia y caption en contrato/normalización,
   incluyendo wrappers. Si cambia packages/contracts: regenerar, checks raíz y
   npm ci gateway para refrescar copia empaquetada; mantener compatibilidad con
   mensajes text/media existentes. Caption >64KiB con marcador sin IA.
5. Probar actualización/dedup/aliases, transcript fallida/exceso, purga/restart,
   STT sustituido y commit antes de IA en temporales. Regresiones 204 existentes
   siguen como base, no como demostración del control/outbox F5.
6. Cuenta proviene de socket autenticado, no token/settings. requires_review sigue
   bloqueando nueva admisión y envío por adapter. JSON aún autoridad de control;
   external_self no suspende IA con garantía v1 hasta F5. No introducir doble writer.
7. Mantener saturación 1000/32MiB observable y no reintentar RPC de resultado
   incierto. Las observaciones rechazadas pueden faltar si WA no las reentrega.
8. Checks Node22/24 y distribución afectada, evidencia, backlog/roadmap/estado y
   commit de la unidad. No cerrar F2 por pruebas reducidas ni habilitar UI/API F3.

## Pendientes materiales

- F2B.2 archiva observaciones WA admitidas; todavía faltan enriquecimiento completo
  de multimedia, atribución durable de salidas y control desde teléfono/panel.
- Telegram/cursor/descubrimiento (BUG004/005/009) y carga completa F2 pendientes.
- Corte/rollback/control/outbox, invalidación de contexto derivado y backups
  programados siguen F5/F8. Purga de archivo inicial/diaria ya está conectada.
- Historial previo completo no está garantizado por WA/Bot API. Driver probado en
  Linux; Windows/Termux y cuenta real de prueba con una sola instancia pendientes.
- BUG-035 pairing async no bloquea captura autenticada; reparar antes de su
  aceptación F8. BUG-024 antes de operadores limitados F3. No paralelizar suites
  Python hasta BUG-014. No asumir que el panel legacy respeta grants v1.

## Regla de cierre para la siguiente sesión

Actualizar estado y solo checkboxes demostrados; hacer commit probado e informar
hash. El [prompt estable](PROMPT-CONTINUIDAD.md) consulta este estado sin reescritura.
BUG-004–012 (009/010 parciales), BUG-014/024 y BUG-033/034/035 siguen abiertos.
BUG-016 probado en repositorio y aliases del adapter, sin afirmar F2 completa.

Cierre F2B.2: commit local `git log --grep="close F2B.2"`; BUG-001/002/003/032 cerrados.
Cierre F2B.1: `4bb4ec3`; BUG-029/031 cerrados.
Cierre F2A: `37525a1`; BUG-026/027/028/030 cerrados.
