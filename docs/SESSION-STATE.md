# Estado de continuidad — SDK-Bot

Actualización: 2026-10-22. El checkout se sincronizó con `origin/main` en
`df1f111` antes de iniciar F5. F4.2 se fusionó en main en 7526edc (PR #4).
BUG-064 y BUG-065 están cerrados y sus arreglos pasaron CI. Release PR #2 actualizó
el manifiesto a 0.3.0 en 9b0d0b5; PR #6 fusionó la versión 0.4.0 en bfe3fa9.

Release Please run #36 (39476647006) creó el release v0.4.0 como borrador y luego
abrió PR #8 v0.5.0 con el mismo changelog que PR #6: ambas añaden 153 líneas.
El log del run confirma `Expected 1 releases, only found 0` y que buscó el tag
`v0.4.0`; GitHub no publica el tag mientras el release siga en borrador. BUG-069
registra la causa. `release-please-config.json` cambia a `draft: false` para que
las futuras fusiones de PR de release publiquen también el release/tag. El draft
v0.4.0 existente y la PR duplicada #8 aún requieren reconciliación manual; no
fusionar la #8 como una versión nueva.

BUG-066 sigue abierto: checks de PRs generadas por Release Please pueden quedar
`action_required` sin jobs. BUG-067 eliminó el input inválido `draft` de la
acción. BUG-068 retiró el deploy Homelab y duplicación CI post-merge. F4.3 está
implementada, verificada y fusionada a main mediante PR #10 (commit `cf1a1cd`).

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
- F2B.3: STT durable sobre el mismo ID y huella, pending/completed/failed con
  message.updated, recuperación de pendientes, captions por tipo y tareas acotadas.
  BUG-033/034/036 cerrados. [MULTIMEDIA-WHATSAPP-F2B3](MULTIMEDIA-WHATSAPP-F2B3.md).
  BUG-037 descarga Baileys sin abort físico queda puerta F8 antes de STT real.
- F2C.1: descubrimiento TG observa el adapter configurado sin getUpdates extra;
  HTTP cancelable/cierre antes de reemplazo, offset RAM separado al cambiar token,
  backoff/4xx y setup parcial. BUG-004/038–043 cerrados; el retry Telegram quedó
  ligado a la cuenta de origen antes de continuar con control F5.
  [TELEGRAM-DUENO-UNICO-F2C1](TELEGRAM-DUENO-UNICO-F2C1.md).
- F2C.2: `getMe` verifica el bot y deriva `telegram_bot:<id>` estable; la migración
  v2 añade cursores por cuenta. Cada lote confirma mensajes, huellas, eventos,
  proyección y cursor antes del offset siguiente. JSON conserva IDs enteros no
  seguros; mensajes deduplican por bot/chat/message_id. Administración, grupos y
  tipos excluidos avanzan cursor transaccionalmente. El audio se archiva como
  marcador y STT actualiza el mismo mensaje antes del pipeline. BUG-005/009/044/047
  y la porción TG de BUG-008 cerrados; F2D cierra después BUG-045 y BUG-046 inbox
  admin queda diferido. Evidencia: [TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md).
- F2D: migración SQLite v3 agrega `legacy_dispatch` atómico con la captura WA/TG;
  el pump reconstruye `StandardMessage` cuando el canal abre, trata eventos como
  wake-up y persiste ACK. Audio espera STT; respond mantiene pendiente el ACK hasta
  completar debounce/IA. BUG-045 cerrado para el corte post-commit→handler;
  BUG-050 mantiene abierta la idempotencia de efectos externos y BUG-051 la
  reconciliación antes de desplegar sobre archivos reales. Evidencia:
  [REPLAY-LEGACY-F2D](REPLAY-LEGACY-F2D.md).
- F2E.1: `sendMessage` de WA archiva la aceptación del proveedor con su ID y el eco
  `fromMe` converge en ese mensaje; la prueba cubre el eco antes del retorno. TG
  archiva el `Message` aceptado solo para chats privados exactos, fuera del chat
  admin/grupos; HTTP 200 `{ok:false}` falla y no deja salida. Ambas salidas quedan
  `external_self` hasta tener origen correlacionado en F5. Respuesta TG con UTF-8
  dividido conserva contenido e IDs >2^53. BUG-052/053/054 cerrados.
  Evidencia: [SALIDAS-ACEPTADAS-F2E1](SALIDAS-ACEPTADAS-F2E1.md).
- Sin migrar datos antiguos ni conectar cuentas reales. La bandeja web consulta
  páginas/SSE autenticados existentes, pero la UI aún no integra SSE ni ofrece API
  de envío/control; la barrera de automatización v1 sigue pendiente de F5.

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
  callbacks de socket reemplazado. F2B.3 repara BUG-033/034/036; la descarga
  física tiene BUG-037 antes de aceptación STT real F8.
- F2C.1 repara el descubridor paralelo testAndGetChatId y las carreras del request
  en reconnect; descubrimiento solo observa al owner configurado, sin nuevos offsets.
- F2C.2 persiste captura y cursor Telegram antes de emitir al legacy. F2D reanuda
  clientes desde outbox hasta handler/IA; un resultado externo ambiguo aún puede
  repetirse si falla antes del ACK (BUG-050/F5). El comando admin confirma cursor
  antes de ejecución y tampoco tiene inbox durable (BUG-046/F5).
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

## Validación ejecutada en F2B.3

- Gateway npm run check: lint/tipos y **218 tests** pasan en Node 24.19.0 y mínimo
  22.13.0 Linux, copias independientes sin secretos/DB. 204 anteriores +5 archivo
  +8 captura/enriquecimiento +1 cancelación STT. Dependencias enlazadas tras npm ci
  --offline gateway con scripts habilitados para refrescar contracts empaquetado.
- Contratos raíz npm run check: generación/tipos y **15 tests** pasan en ambas
  versiones. Caption opcional conserva marcadores previos; tipos regenerados.
  No cambios de manifiestos/lock ni nuevas dependencias.
- SQLite real: CAS, evento mínimo/versión atómicos, huella estable, alias/dedup,
  reinicio de pending a failed, purga sin recreación, caption/oversized y texto
  antiguo conservado ante forma incompatible nueva en cuarentena.
- STT sustituido: pending antes de descarga y completed antes de legacy; captura
  de texto progresa durante STT. Falla/exceso/Unicode, deadline/saturación, cancelación
  de socket, revisión de identidad y resultado incierto sin retry pasan. Self-chat
  audio sigue fuera del archivo. History/fromMe/duplicados no inician STT.
- Cuatro trabajos sin cola, deadline 150 s, acumulación por stream limitada a
  STT_MAX_UPLOAD_BYTES. Un trabajo que ignora abort conserva plaza hasta terminar;
  no publicar resultados tardíos. Shutdown/reset drenan actualizaciones antes de SQLclose.
- Imagen nueva sdkbot-f2b3:local construida con npm ci --omit=dev, contrato actual
  empaquetado y sin node_modules raíz; CA temporal solo en RUN/TLS verificado.
  **72 tests** pasan Node22.23.3 --network none, profiles como Compose. No despliegue.
- Reproducción adapter/normalizador 7d99f36 confirma cinco STT sin límite, estados
  not_requested tras terminar y caption como texto. BUG-033/034/036 cerrados.
  BUG-037 nuevo: fetch sustituido confirma que Baileys no reenvía signal de descarga;
  deferido P2/F8 antes de aceptar STT real, sin afirmar aborto físico/handles cerrados.
- Evidencia efímera /tmp/sdkbot-f2b3-9a8_8bcc. Fixture 75 expectativas sin cambios;
  no carga completa. Brain/launcher no cambiaron ni se repitieron, logs conservados.
  Sin cuentas/STT/modelos/OAuth reales, push, despliegue, Windows/Termux/GitHub Actions.

## Validación ejecutada en F2C.1

- Gateway npm run check: lint/tipos y **233 tests** pasan Node24.19.0 y mínimo
  22.13.0 Linux, copias independientes sin secretos/DB. 218 anteriores +10 ownership/
  bus +4 HTTP +1 setup. Diez tests Telegram previos actualizados y conservados.
- Descubrimiento concurrente sobre poll activo, mensajes al consumidor normal,
  sin peticiones/offset extra. Caché cinco minutos, esperas 1,5 s/máximo 64,
  cancelación individual, token no guardado, timeout/reinicio y setup parcial pasan.
- Reemplazos esperan cierre del request local; connects superados no instalan
  loops. Offset RAM conserva el mismo token y reinicia al cambiarlo. Audio legacy
  revalida token/generación tras esperas; STT tardío no emite con el reemplazo.
- HTTP local: deadline absoluto, cancelación y cierre sin headers/con body detenido,
  8 MiB, UTF-8 fragmentado/dañado y JSON inválido. 4xx paran visibles; 5xx/red
  aplican pausa cancelable. POST de prueba de notificación acotado y sin retry.
- Reproducción 42b8321 confirma dos lectores, petición A viva al abrir B, offset
  124 heredado, retry inmediato de 500, UTF-8 corrupto y UI parcial bloqueada.
  BUG-004/038/039/040/041/042 cerrados. Esa revisión detectó BUG-043, que se
  cerró posteriormente con una guarda de cuenta/generación en el retry Telegram;
  ver la sección F5 anterior. El hallazgo original fue reparado.
- Docker sdkbot-f2b3:local con dependencias de producción, código afectado/tests
  actuales readonly y profiles como Compose: **97 tests** pasan Node22.23.3,
  --network none. No imagen nueva, compose up ni despliegue.
- Evidencia efímera /tmp/sdkbot-f2c1-d6sse47d. Sin cambios de manifiestos/contratos/
  brain: no npm ci nuevo ni sus suites. Sin launcher global para conservar logs.
  Fixture 75 expectativas intacto; no carga completa. Sin cuentas/getUpdates/getMe/
  envíos/STT/OAuth reales, push ni GitHub Actions. Windows/Termux pendientes.

## Validación ejecutada en F2C.2

La evidencia y límites de esta unidad están en
[TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md).

- Gateway `npm run check` en copias del árbol staged: Node 24.19.0 y mínimo
  Node 22.13.0, lint/tipos y **242 pruebas** pasan en ambos. Node 22 emite la
  advertencia conocida de `node:sqlite` experimental.
- Docker cacheado `sdkbot-f2b3:local`, Node 22.23.3, `--network none`, imagen de
  producción sin dependencias de desarrollo: **242 pruebas** pasan con el snapshot
  completo versionado y dependencias runtime; no se reconstruyó imagen ni se ejecutó
  Compose. La primera pasada montó solo `gateway/` y falló tres pruebas que requieren
  perfiles versionados de `brain/`; la repetición incluyó el árbol completo y pasó.
- Las 8 pruebas nuevas de `telegramCapture.test.js` cubren migración v1→v2,
  reapertura/offset, IDs mayores de 2^53, rollback de lote, redelivery, namespace,
  exclusiones, despacho admin stale y descarga de audio limitada por stream.
- Códigos y perfiles fueron los del repositorio versionado en copias temporales;
  no se copiaron DB, secretos ni estado local. No se llamaron proveedores/canales,
  STT real, Docker build, ni pruebas de carga de 1M mensajes.

## Validación ejecutada en F2D

La evidencia funcional y los límites de replay están en
[REPLAY-LEGACY-F2D](REPLAY-LEGACY-F2D.md).

- `gateway npm run check` en Node 24.19.0: lint, typecheck y **247 pruebas** pasan.
- Pruebas enfocadas de archivo, captura WA/TG y `legacyDispatch.test.js` pasan;
  migraciones v1/v2→v3, commit/cursor/outbox atómicos, corte antes del wake, reopen,
  ACK persistente, gating por canal, retry, debounce/IA diferido, y transcripción
  audio completada/fallida. `git diff --check` no reporta espacios defectuosos.
- Sin canal real, proveedores, STT real, DB de usuario ni carga de 1M. No se migran
  filas pre-v3 a outbox porque no existe un recibo que pruebe si ya se procesaron.

## Validación ejecutada en F2E.1

- Pruebas WA/TG enfocadas: **34 pasan**, incluyendo ID de proveedor, `external_self`,
  eco WA antes/después del ACK, deduplicación, exclusión de admin/grupos, entero TG
  >2^53, UTF-8 dividido y `ok:false` HTTP 200 sin fila nueva.
- `gateway npm run check` en Node 24.19.0: lint, typecheck y **250 pruebas** pasan.
- Sin canal/proveedor real, credenciales, DB de usuario ni carga de 1M. Detalles y
  límites: [SALIDAS-ACEPTADAS-F2E1](SALIDAS-ACEPTADAS-F2E1.md).

## Validación ejecutada: F2E.2 / carga sintética completa

- Dataset v1 reproducible: 1M mensajes, 2.000 conversaciones, cinco cuentas,
  50.000 redeliveries y 40 aliases WA; throughput 3.152 mensajes/s. Snapshot:
  integridad `ok`, 50.000 eventos retenidos, 0 cuarentenas/FK.
- Dos calentamientos y tres runs medidos, 2.000 páginas por tipo/run y 2.700
  ingestas live/run. En los tres medidos: p95/p99 de lista 1,94–2,55/5,02–5,87 ms;
  página de mensajes 1,87–2,48/4,91–5,87 ms; ingesta steady p99 7,39–12,48 ms;
  event loop p99 10,86–10,90 ms; RSS 280,3–284,2 MiB; cero errores.
- BUG-055: la primera carga halló 50.700 eventos tras el tráfico nuevo; la poda ahora
  ocurre al final de cada commit que genera eventos. La repetición retuvo exactamente
  50.000 en los cinco runs. Saturación por 1.000 items y 32 MiB rechaza con claridad;
  Telegram no confirma el cursor al saturarse y no se crea mensaje/dispatch.
- Evidencia y muestras: [F2E2-CARGA-COMPLETA](F2E2-CARGA-COMPLETA.md) y
  [JSON completo](evidence/F2E2-load-report.json). `gateway npm run check` en
  Node 24.19.0 pasa lint, typecheck y **256 pruebas**.
- Perfil de host distinto (Linux x64, 3 CPU/10,45 GiB vs objetivo 2 CPU/4 GiB): no
  certificar aún el presupuesto de referencia; repetir allí. Takeover queda F5;
  atribución outbound del backfill se mantiene `unknown` hasta el outbox F5.
  Sin canal real, credenciales ni DB de usuario.

## Validación ejecutada: F3.1 / lectura autenticada

Evidencia y contrato de la unidad: [F3.1-LECTURA-AUTENTICADA](F3.1-LECTURA-AUTENTICADA.md).

- API v1 implementada para cuentas, lista y detalle de conversaciones, páginas de
  mensajes y `POST /read`. Panel/gateway validan firma y capacidad; el proxy verifica
  `AccountsResponse`, `ConversationsResponse`, `ConversationResponse`,
  `MessagesResponse` y `ReadResponse`.
- Los cursores son opacos y HMAC; la lista enlaza actor, filtros, época/watermark,
  revisión de agenda/política y lectura local. Cambio concurrente devuelve 410 para
  recargar. Mensajes usan keyset `(occurredAt,id)` y se devuelven cronológicamente.
- `read_cursors` es durable por actor y conversación, monotónico, y no marca recibos
  remotos. Los nombres se proyectan por coincidencia exacta con la agenda; identidad
  no resuelta produce nombre null. Control sigue siendo una proyección de JSON hasta
  F5, sin habilitar takeover ni operadores limitados.
- Añadido BUG-056 (filtros opcionales null) y BUG-057 (búsqueda sensible a caja);
  ambos bloqueaban lectura/filtros F3.1, se reprodujeron, corrigieron y cerraron con
  prueba HTTP. La prueba de archivo también confirma cursor actor-local tras reopen.
- Validación: `npm run check` raíz (contratos/generación/tipos/15 tests) y
  `npm run check` gateway (lint, typecheck y 258 tests) en Node 24.19.0/Linux.
  Prueba adicional de API firmada incluye filtros, empate de timestamps,
  capacidades, historial parcial, rechazo 401/403/422/410 y aislamiento de lecturas.

BUG-024 continúa como puerta antes de crear operadores limitados: esta unidad no
introduce nueva UI ni roles. El SSE exige sesión firmada y `conversations:read`;
cada conexión dura como máximo los 30 segundos del grant firmado, por lo que el
proxy vuelve a resolver y firmar actor/capacidad al reconectar.

## F3.2 completada: SSE, replay y resync

- `GET /v1/events` publica eventos mínimos tras commit desde el worker SQLite.
  El subscriber se instala antes de leer watermark; el replay se pagina hasta ese
  watermark y se deduplica con la cola viva. Sin cursor se entrega un checkpoint
  id-only y el cliente obtiene el snapshot tras abrir el stream.
- Cambio de época o hueco de retención/purga emite `resync.required` en el
  watermark actual. Replay no extiende la ventana de 50.000 eventos. Cola por
  conexión limitada a 1.000 eventos/1 MiB, heartbeat de 15 s y reconexión a 3 s.
- Proxy conserva `Last-Event-ID`, transmite SSE y cierra upstream al desconectar.
  Pruebas cubren auth 401/403, cursor malformado/futuro, cambio de época,
  expiración, carrera determinista replay/live, publicación solo tras commit,
  duplicado silencioso, respuesta de archivo no disponible y cleanup.
- Evidencia: [F3.2-STREAM-SSE-REPLAY](F3.2-STREAM-SSE-REPLAY.md). `gateway npm run
  check`: lint, TypeScript y 264 pruebas; `npm run check` raíz: generación,
  TypeScript y 15 pruebas. Node 24.19.0/Linux. No se encontraron bugs funcionales
  nuevos; BUG-024 permanece como puerta de autorización administrativa legacy.

## F4.1 completada: shell visual de bandeja

- App React/TypeScript/Vite en `gateway/panel/web`, servida por el proceso de panel
  existente bajo `/inbox` solo con `PANEL_CONVERSATIONS_UI_ENABLED=true`. La ruta
  legacy `/` y OAuth se conservan; la UI permanece apagada por defecto.
- Shell adaptable de navegación, conversaciones, hilo y contexto, tokens visuales,
  router y cliente TanStack Query. El ID de chat vive en URL; filtros, búsqueda y
  envío están deshabilitados hasta integrar comportamiento real. No hay fixtures
  de conversación en la interfaz.
- Docker tiene etapa de build separada para Vite y copia el artefacto al runtime,
  que conserva `npm ci --omit=dev`. No se abre un servicio/canal adicional.
- BUG-058/059/060 se reprodujeron y cerraron en esta unidad: import de icono,
  ESLint sobre bundle generado y setup Vitest descubierto como test de Node.
- Evidencia: [F4.1-SHELL-VISUAL](F4.1-SHELL-VISUAL.md). `gateway npm ci` limpio y
  `gateway npm run check`: ESLint/TypeScript pasan; 3 pruebas Vitest, build Vite,
  prueba HTTP del build y 269 pruebas Node gateway pasan en Node 24.19.0/Linux.
- Imagen Docker Node 22 construida con CA temporal vía BuildKit Secret; una prueba
  dentro de la imagen confirma bundle/contratos presentes y Vite ausente del runtime.
  El CA solo se monta durante `npm ci`, no queda en capas. BUG-061 cierra la
  adaptación del builder a instalaciones detrás de CA corporativo.
- La auditoría inicial encontró BUG-062 P1 en `sharp@0.35.3` y
  `music-metadata@11.14.0`, transitivos de Baileys. Se cerró en un commit de lockfile
  separado; la evidencia está abajo y en
  [DEPENDENCY-SECURITY-BUG-062](DEPENDENCY-SECURITY-BUG-062.md).
- No hubo navegador E2E con viewport ni prueba visual manual; queda como límite
  registrado, junto con la conexión de API pendiente. El CSS incluye breakpoints,
  y Vitest verifica regiones, navegación y foco por teclado.

## BUG-062 completado: dependencias de medios

`npm audit fix` actualizó solo `gateway/package-lock.json`: `sharp@0.35.5` y
`music-metadata@11.16.1` bajo el Baileys existente. Auditoría completa y producción
dan cero vulnerabilidades; gateway check conserva 269 pruebas y 3 Vitest. Docker
Node 22 se reconstruyó con el CA temporal y probó runtime, bundle, contrato y
ausencia de Vite/CA. Commit separado de la UI.

## F4.2 completada: lectura HTTP real de la bandeja

- La app consulta cuentas, lista filtrada, detalle e historial paginado a través de
  `/api/v1` del panel OAuth. La selección queda en la URL. Búsqueda por contacto,
  filtros no leídos/abiertas/canal y páginas siguientes usan cursores de la API.
- El hilo carga primero los mensajes recientes, ordena cronológicamente las páginas
  anteriores y conserva el ancla de scroll. Representa contenido multimedia y su
  disponibilidad; la ficha contextual presenta canal/estado, automatización,
  ciclo, no leídos y cobertura sin mostrar IDs del proveedor.
- Al abrir mensajes entrantes actualiza el cursor local monotónico por
  `inboundSeq`; esto no manda recibos remotos. Carga, vacío, errores, reintentos y
  cursor vencido tienen estados explícitos. BUG-063 se cerró: al vencer un cursor
  de lista, “Actualizar lista” vuelve a la primera página.
- Evidencia: [F4.2-LECTURA-HTTP-REAL](F4.2-LECTURA-HTTP-REAL.md). `gateway npm run
  check` pasa en Node 24.19/Linux: 9 pruebas Vitest, build Vite y verificación HTTP
  del artefacto, además de 269 pruebas Node. El build Docker Node 22 pasa con CA
  temporal BuildKit. El contenedor de sondeo no pudo arrancar porque el filesystem
  llegó al 100% y Docker no pudo crear la capa escribible; el build y las pruebas
  locales sí finalizaron.
- La UI no implementa envío ni toma de control; esos flujos quedan para F5/F6.
  F4.3 conecta SSE, caché, reconexión, ancla de scroll y resync.

## F4.3 completada: eventos en vivo de la bandeja

- La UI abre el SSE autenticado y actualiza listas/detalle con invalidaciones
  agrupadas. Para mensajes del chat seleccionado refresca solo páginas necesarias.
- Si el replay supera una página, sigue cursores hacia atrás hasta solapar con el
  snapshot reciente que ya estaba cargado. Deduplica por ID y conserva el ancla
  cuando el operador lee mensajes anteriores; el contador ofrece volver al final.
- Eventos recibidos durante un fetch dejan el hilo marcado para otro refresco al
  terminar la petición en curso. CURSOR_EXPIRED/DATA_EPOCH_MISMATCH reinician las
  páginas y cargan snapshot tras completar el reset.
- BUG-070 cerró el hueco visual con más de 50 mensajes tras una desconexión.
  Evidencia: [F4.3-STREAM-INBOX](F4.3-STREAM-INBOX.md).
- PR #10 fusionada a main (commit `cf1a1cd`, head del PR `a390c71`). GitHub Actions run 39485451344 pasó los cinco jobs:
  13 pruebas Vitest del panel, build/servido del artefacto, 269 pruebas Node,
  smoke, spike SQLite, contratos Node 22.13/24 y brain Ruff/pytest.
- No se probaron canales reales ni E2E manual en navegador. La revisión visual del
  viewport móvil sigue pendiente; F4.3 se validó con pruebas de componente/CI.

## F5: BUG-043 cerrado — reintento Telegram ligado a la cuenta de origen

- `TelegramAdapter.sendMessage` captura token, accountId, adminChatId y generación
  al iniciar el envío. Si llega un 400 de formato después de una rotación, el
  reintento se detiene con `TG_CONNECTION_CHANGED`; no usa el token nuevo.
- Una respuesta aceptada que llega tarde se archiva bajo la cuenta y configuración
  admin capturadas por esa intención, aunque el adapter ya esté conectado a otra.
- Evidencia: regresiones con transporte controlado en
  `gateway/tests/telegramCapture.test.js`; `cd gateway && npm run check` pasó con
  lint, typecheck, 13 pruebas Vitest, build servido y 271 pruebas Node en Node
  24.19.0/Linux.
- Commit local de código y regresiones: `8a84f8c`. F5 no está completada; este
  cierre solo elimina una puerta de seguridad del dispatcher Telegram.

## F5.1: Estado de control durable

- SQLite v5 añade acceso, modo, lifecycle, propietario, versiones, estado de
  operación y metadatos de handoff por conversación. Migrar v4 conserva filas y
  asigna defaults neutrales con IA apagada.
- `writeControlState` aplica CAS con expectedVersion, registra actor en auditoría,
  incrementa controlVersion/aggregateVersion y añade control.changed de forma
  atómica. Conflicto obsoleto no cambia estado/seq; estado y auditoría sobreviven
  una reapertura.
- La bandeja sigue proyectando contactos/settings JSON; los campos SQLite son
  staging hasta completar el informe y corte. No hay endpoints de control ni
  barrera de envíos conectados todavía. Sin bugs de producto nuevos en esta unidad;
  los fallos iniciales fueron fixtures v1/v2 que simulaban versiones antiguas con
  columnas v5 presentes; se corrigieron y sus migraciones pasan.
- Evidencia: [F5.1](F5.1-CONTROL-DURABLE.md). `cd gateway && npm run check` pasó:
  lint, typecheck, 13 Vitest, build/serving del panel y 273 pruebas Node en Node
  24.19.0/Linux.
- Commit local por F5.1: incluido en el historial de esta rama; sin push mientras
  F5 siga abierta: `2ac25ca`. F5.2 también está cerrada y committeada localmente;
  el siguiente punto es F5.3.

## F5.2: Dry-run verificable de importación

- `npm run conversations:control-dry-run` lee contactos/settings JSON y el
  inventario de perfiles, consulta solo conversaciones SQLite y emite checksum
  por archivo/registro, target exacto, recuentos y motivo de revisión/cuarentena.
- Mapea `phone`/`lid` solo por identidad WhatsApp exacta. Ambigüedad entre cuentas,
  identidades faltantes y reglas contradictorias se ponen en cuarentena; grupos
  conocidos se excluyen. Handoff importado sigue en human aunque su TTL legacy
  haya vencido. Settings de proveedor no se imprimen ni migran aquí.
- La CLI bloquea el lock del gateway activo, sidecars WAL/SHM/journal y esquemas
  distintos de v6. SQLite abre immutable/read-only; prueba no cambia bytes de JSON
  ni DB y no crea sidecars. No se leyó ningún contacts/settings real ni se ejecutó
  un corte. Un informe con blockers devuelve exit 2; `cutoverAllowed` queda falso.
- Evidencia: [F5.2](F5.2-IMPORT-DRY-RUN.md). `cd gateway && npm run check` pasó:
  lint, typecheck, 13 Vitest, build/serving del panel y 275 pruebas Node en Node
  24.19.0/Linux. Las dos pruebas F5.2 cubren la política y la CLI read-only.
- No aparecieron bugs de producto nuevos para backlog. El siguiente punto exacto
  es **F5.3: staging idempotente, corte de autoridad y recuperación**, todavía sin
  ejecutar contra datos del entorno.

## F5.3: Staging, delta y corte recuperable

- SQLite migra v5→v6 en el mismo archivo, conserva epoch/secuencia/controles y
  agrega perfil/revisión por conversación, política global, authority y tablas de
  migrationId, ejecuciones, entradas y snapshots. La autoridad inicial continúa
  `legacy`.
- `npm run conversations:control-import` es de solo lectura por defecto. `--apply`
  guarda y verifica el plan por lotes; no escribe columnas de control activas.
  `--exclude-no-conversation` registra explícitamente como excluidos solo los
  contactos sin destino exacto en el snapshot; inválidos y ambiguos permanecen
  bloqueados, y un destino desaparecido tras una importación previa exige revisión.
  Repetir la misma fuente retoma la ejecución idempotente. La delta detecta bajas y
  remapeos; ambos bloquean salvo `--accept-source-removals`/
  `--accept-identity-changes`, decisiones que quedan auditadas en el informe.
- `--cutover` solo acepta staging verificado y requiere que F5.4 registre el servicio
  común listo. La aplicación es por lotes de 100 con snapshot por control; cada
  cambio emite `control.changed`. Una interrupción deja al gateway y dry-run
  bloqueados hasta `--resume-cutover` o `--rollback`; el rollback conserva versiones
  monotónicas. Cada conversación cambiada emite `control.changed`. Se revalidan los
  hashes de JSON/perfiles antes de verificar y activar.
- Se corrigió el caso de F5.2 donde settings omitía `currentProfile`: ahora el
  informe incluye valores efectivos por defecto. No se ejecutó `--apply` contra
  datos runtime, ni se cambió autoridad. BUG-050 permanece F5.6; BUG-051 sigue como
  puerta antes de migrar un archivo real. No apareció otro defecto para backlog.
- Evidencia: [F5.3](F5.3-STAGING-CUTOVER.md). 9 pruebas enfocadas pasan. `cd gateway
  && npm run check` pasó lint, typecheck, 13 Vitest, build/serving del panel y 282
  pruebas Node en Node 24.19.0/Linux.
- F5.3 queda validada y se compromete localmente; sin push hasta cerrar F5. El
  siguiente punto exacto es **F5.4: servicio compartido y activación segura del
  corte**, integrado en API, comandos y estado.

## F5.4: Servicio de control compartido y activación

- `ControlService` centraliza takeover, release, lifecycle, acceso, perfil y política
  global. API autenticada, comandos heredados y estado escriben en la misma autoridad
  con expectedVersion y actor; los destinos legacy se buscan por identidad exacta,
  canal y cuenta, y se rechazan coincidencias ambiguas.
- El takeover guarda operación/idempotency key y versión antes de drenar. El gateway
  espera buffers ACK y salida activa antes de confirmar; al reiniciar retoma
  operaciones pendientes de forma segura. La migración v6→v7 conserva la línea de
  eventos, admite eventos de política sin conversación y crea la tabla de operaciones.
- El gateway registra readiness; el corte verificado de autoridad se probó con DB
  temporal. No se leyó ni modificó el archivo de control runtime ni se ejecutó un
  corte sobre datos reales. La política global se aplica a conversaciones neutrales;
  una revisión requerida, cierre o exclusión mantiene la IA bloqueada.
- Se corrigió durante validación el valor de schemaVersion devuelto al abrir v7,
  aceptación de v7 en el informe de staging y la proyección importada de revisión y
  perfil. BUG-071 documenta un resumen inflado en `/ignorar contactos de agenda`;
  el control aplicado permanece correcto y el ajuste queda para después.
- Evidencia: [F5.4](F5.4-CONTROL-SERVICE.md). 6 pruebas del servicio, 7 pruebas de
  migración/corte, 15 contratos, lint y typecheck pasan.
- F5.4 queda validada y con commit local; sin push hasta cerrar F5. Sigue **F5.5:
  barrera y coordinación de jobs**.

## F5.5: Barrera y coordinación de jobs

- El buffer y el lock de generación usan `conversationId` cuando SQLite es autoridad,
  también cuando un hilo llega por identidades remotas distintas. Cada trabajo lleva
  `controlVersion`, `contextVersion` y `policyVersion`; la captura se vuelve a
  comprobar al vencer debounce, al entrar al pool, antes/después de generar, antes
  de typing, en el retry y antes de cada globo/pausa.
- Un cambio de control aborta el fetch de generación, cancela esperas de typing y
  evita que se envíen globos siguientes. Al cambiar acceso, lifecycle o perfil se
  drena el trabajo obsoleto; un cambio de política global invalida trabajos/buffers
  afectados. La operación de takeover espera el mismo drenaje antes de confirmar.
- Con autoridad SQLite, el arranque archiva el JSONL heredado y deja una cola nueva
  vacía. La cola no se reabre ni reejecuta al reiniciar con la autoridad nueva. No se
  inspeccionó ni modificó la cola runtime; la prueba usa un archivo temporal.
- Evidencia: [F5.5](F5.5-JOB-BARRIER.md). 2 pruebas de barrera IA, 7 de servicio y
  12 de queue/dispatch pasan; también pasan 12 pruebas Telegram, lint y typecheck.
  BUG-050 quedó abierto al cerrar F5.5 y se cerró después en F5.6.
- F5.5 queda validada y con commit local; sin push hasta cerrar F5. Sigue **F5.6:
  outbox y salida común**.

## Pendientes materiales

- F5 aborda toma de control, cancelación de IA, contexto y outbox; BUG-046/050
  son puertas de esa entrega y BUG-051 antes de migrar archivos preexistentes.
- BUG-010 sigue parcial; BUG-035/037 quedan para F8. Windows/Termux y canales reales
  no están validados; la historia previa que conservan los proveedores es limitada.
- BUG-024 antes de operadores limitados; BUG-014 antes de Python paralelo.

## Regla de cierre para la siguiente sesión

Actualizar estado y solo checkboxes demostrados; hacer commit probado e informar
hash. Consultar [BACKLOG.md](BACKLOG.md) para el estado y aceptación de cada bug.

BUG-005/006/007/009/012/043/044/045/047/050/052/053/054/055/070 están cerrados; BUG-008/010/011/014/024/035/037/046/051/071/072 siguen abiertos o parciales según el backlog. BUG-016 fue probado en repositorio y alias del adapter, sin afirmar F2 completa.

Cierres históricos: commits F2C.1/F2C.2/F2D/F2E.1 están en el log local; F2B.3 `42b8321`, F2B.2 `7d99f36`, F2B.1 `4bb4ec3`, F2A `37525a1`.

## F5.6: Outbox y salida común

- `ChannelAdapter.sendMessage` ahora es el puerto común; WhatsApp y Telegram
  implementan `sendMessageRaw` detrás de él. La migración SQLite v7→v8 agrega
  intents con idempotency key/fingerprint, cuenta/destino, actor/origen/política,
  control snapshot y estados `intent`, `sending`, `accepted`, `rejected` y
  `delivery_unknown`.
- El intent se confirma antes de la llamada de red. Duplicados aceptados devuelven
  el resultado persistido; claves con contenido distinto fallan. Un `sending` al
  iniciar se convierte en `delivery_unknown`; no hay retry automático y se añadió
  API interna de consulta/conciliación con actor y nota obligatorios. El claim IA
  verifica control/contexto/política en la transacción de SQLite.
- La IA guarda clave por globo; una salida fallida/ambigua no vuelve a encolar toda
  la generación. La cola antigua usa su UUID durable. Campañas usan una clave por
  broadcast/destino y escriben la clave antes del proveedor. Campañas anteriores
  que quedaron `sending` sin recibo se pausan para revisión. `/notify` requiere una
  clave y usa el adaptador; avisos Telegram usan el mismo puerto.
- BUG-012 y BUG-050 se cerraron con pruebas. BUG-072 anota que `/telegram/test`
  conserva una sonda directa para tokens borrador aún no conectados. BUG-071 sigue
  como defecto de resumen no bloqueante.
- Evidencia: [F5.6](F5.6-OUTBOX.md); migración/concurrencia/reinicio, transportes
  WA/TG y campañas pasan. `gateway npm run check` pasa con lint, tipos, 13 pruebas
  Vitest, build y 301 pruebas Node. No se leyeron ni modificaron archivos runtime.
- F5.6 queda validada; sigue F5.7: contexto explícito,
  generationId/reanudación y confirmación solo de globos enviados.

## F5.7: Contexto explícito y reanudación IA

- Gateway arma cada `GenerateReply` con contexto versionado del archivo. Solo las
  salidas humanas/IA con intent aceptado se incorporan; mensajes propios sin
  correlación aceptada quedan fuera. Brain persiste el borrador por generationId
  para reanudar y no agrega texto no enviado a su memoria legacy.
- SQLite v9 agrega secuencia monotónica y frontera durable por conversación.
  `/limpiar memoria` conserva el archivo, mueve la frontera y cancela trabajos con
  contexto viejo. Las claves de outbox por globo permiten replay local tras
  reinicio y evitan repetir globos aceptados.
- La pausa global drena trabajos IA sin desactivar captura ni salida humana.
  Release conserva `future_only`; `process_pending` responde 409 hasta F6.
- Validación de Brain: Ruff limpio y 26 pruebas. F5.8 agrega la prueba integrada y
  ejecuta el check completo del gateway.
- Evidencia: [F5.7](F5.7-CONTEXTO-IA.md). Commit F5.7: `52f2130`.

## F5.8: Aceptación integrada

- Se ejecutó la matriz con archivo SQLite temporal, proveedor IA falso y transportes
  falsos. Cubre cancelación entre globos, takeover con llamada de red incierta,
  idempotencia/reinicio del outbox, mensajes humanos en el prompt, replay de una
  respuesta aceptada, salida desconocida desde el teléfono, pausa global y frontera
  de `/limpiar memoria`.
- Se corrigieron fixtures de archivo v4–v7 que bajaban `user_version` sin quitar
  las columnas v9 o modelaban una tabla `messages` incompleta. No hizo falta un
  cambio correctivo en la migración de producción.
- Gateway `npm run check`: ESLint y TypeScript limpios; panel typecheck, 13 pruebas
  Vitest, build y servido del build pasan; suite Node 310/310. Brain: Ruff limpio y
  26 pruebas pasan.
- BUG-073 (eco WA antes de ACK lento) y BUG-074 (retención de respuestas de
  generación) quedan abiertos como mejoras no bloqueantes con aceptación y fase
  límite en [BACKLOG.md](BACKLOG.md). No se usaron canales reales ni datos runtime.
- Evidencia: [F5.8](F5.8-ACEPTACION-INTEGRADA.md). Fase 5 queda validada; el próximo
  paso es iniciar F6 después de publicar la rama.

## F6.1: Control humano y envío desde el hilo

- Se conectaron los botones de tomar/devolver control y resolver/reabrir. La toma
  de control pendiente se consulta por operación; el compositor exige permiso,
  canal conectado/compatible, lifecycle abierto, identidad sin revisión y control
  humano confirmado con propietario autorizado.
- `POST /messages` usa la identidad canónica de la conversación y un intent durable
  ligado a actor/conversación/`clientMessageId`. El worker revalida snapshot y
  propietario al reclamar; release, reasignación y resolución esperan si un envío
  humano ya está en curso. La aceptación se reconcilia con el mensaje archivado y
  publica `message.updated` con autor y `clientMessageId`.
- La UI conserva el borrador ante errores, muestra estado optimista y exige
  confirmación informada cuando el resultado HTTP/proveedor sea incierto. Se fuerza
  texto plano para Telegram. Las incertidumbres sobreviven al cambio de conversación;
  una operación todavía `sending` consulta su misma clave y no ofrece crear otro
  intent. El mensaje archivado limpia la incertidumbre y el optimismo. Se amplió
  `ErrorCode` tras encontrar que la frontera no podía serializar los códigos de
  conflicto implementados en F5.
- Evidencia: [F6.1](F6.1-ENVIO-HUMANO.md). `npm run contracts:generate`, `cd
  gateway && npm ci`, `npm run lint`, `npm run typecheck` y `npm run panel:typecheck`
  completados; lint y tipos limpios. No se ejecutaron suites de pruebas en esta
  entrega. No se usó una cuenta de canal real.

## F6.2: Selección explícita de entradas al devolver el control

- La migración SQLite v9→v10 agrega watermarks de entrada atendida y corte de
  reanudación. En bases existentes ambos parten del `inbound_seq` actual, así que
  una actualización no ofrece mensajes históricos como pendientes por accidente.
- `future_only` conserva acceso/perfil y fija el corte en la transacción que
  devuelve el control; los despachos antiguos pendientes quedan omitidos. La
  ruta de despacho vuelve a comprobar el corte antes de iniciar automatización.
- `process_pending` presenta como máximo 100 entradas live, recientes (24 h), no
  atendidas y con texto/transcripción/caption procesable. El operador marca IDs
  explícitos. La selección lleva una huella de control, política, watermarks e
  integridad del payload; el servidor valida esa huella y la lista dentro de la
  transacción que cambia el control. Entradas excluidas permanecen en el historial.
- La aceptación durable de una salida humana o IA avanza el watermark según la
  entrada declarada. Una entrega `sending` o `delivery_unknown` bloquea
  `process_pending`; `future_only` sigue disponible. BUG-075 deja la conciliación
  autenticada de entregas inciertas para F7. BUG-076 registra los metadatos de
  contacto que no están disponibles al reconstruir ciertos replays antiguos.
- Evidencia: [F6.2](F6.2-REANUDACION-PENDIENTES.md). `gateway` lint, typecheck y
  panel typecheck; contratos generados y typecheck pasan. No se ejecutaron suites
  de pruebas ni se usó una cuenta real.
- Próximo: **F6.3**, recorrido E2E de entrada, takeover, respuesta humana, entrada
  durante human, release y respuesta IA con contexto; después F6.4 smoke en cuenta
  de prueba cuando esté disponible. Fase 6 sigue incompleta.

## F6.3: Flujo integrado de conversación

- La prueba `f63ConversationFlow.test.js` recorre SQLite, cola durable, API de
  bandeja/hilo, takeover, salida humana archivada, entrada durante human, selección
  explícita `process_pending` y siguiente respuesta IA con contexto ordenado. Usa
  Brain y transporte falsos; no usa una cuenta ni proveedor real.
- El cutover integrado expuso BUG-077, validadores de importación que rechazaban
  schema v10; se corrigieron y el cutover pasa. También se corrigió BUG-078 para que
  todo inicio recupere intents `sending` a `delivery_unknown`, incluso cuando la base
  ya está en v10. Ambos quedan cerrados con prueba.
- Siete suites enfocadas: 56/56; gateway lint, typecheck y panel typecheck pasan;
  contratos generados y typecheck pasan; `git diff --check` pasa. Evidencia:
  [F6.3](F6.3-FLUJO-CONVERSACION.md).
- F6.3 completada. Próximo: F6.4, smoke manual con cuenta WA/TG de prueba cuando
  esté disponible. La presentación del hilo en navegador tampoco se validó aquí;
  registrar ese límite junto al smoke. Fase 6 sigue incompleta.

## F6.4: Smoke manual de canal

- El 2026-10-21 se conectó una sola instancia local en `work` (`1d76ec2`) con
  WhatsApp abierto, Brain saludable y cola vacía. El marcador
  `F6.4-WA-20261021-01` se archivó una vez en la bandeja/log. El inbound posterior
  al primer reinicio actualizó la actividad a `2026-10-21T06:49:51Z`, quedó con
  `unreadCount=1` y el log registró `ignored_all_strict` a `06:49:51.279Z`; no hubo
  respuesta automática. La simulación F6.3 permanece separada del smoke real.
- En el primer intento de takeover, la UI recibió `CONTROL_AUTHORITY_NOT_ACTIVE`
  porque la autoridad aún era `legacy`; no se envió respuesta y el contacto volvió
  a `neutro`. La razón de no probar respuesta humana/release debió explicarse en
  ese momento: F5.3 bloqueaba el corte por dos identidades ambiguas y no existía
  una decisión parcial documentada.
- Para respetar “mantenerlas bloqueadas”, se añadió `--preserve-ambiguous-blocked`.
  Solo se admite si todas las cuarentenas son `identity_ambiguous`, `globalMode` es
  `ignored_all` y sus cuatro conversaciones candidatas ya están inactivas. El
  plan deja las dos entradas en cuarentena y no escribe esos controles. 14 pruebas
  enfocadas de importación/migración pasan; lint, typecheck, `git diff --check` y
  el build de la bandeja React pasan.
- El dry-run live mostró 43 importados (41 contactos `neutral/off` y 2 settings),
  962 excluidos por no tener conversación, 2 ambiguos y 0 con revisión requerida.
  La revisión confirmó los cuatro candidatos inactivos bajo `ignored_all`. El
  staging y corte terminaron con código 0; autoridad `sqlite`, servicio listo,
  `ignored_all` conservado y `controlsChanged=0` en esas cuatro conversaciones.
  No se eligió ni unió ninguna identidad.
- Se reinició una sola instancia con listeners en `127.0.0.1`, bandeja React
  habilitada y actor dev. Brain, Gateway y panel responden; WhatsApp y Telegram
  figuran `open`, Brain `/health` = `ok`, cola en cero y `globalMode=ignored_all`.
  La API v1 devuelve HTTP 503 `SERVICE_UNAVAILABLE` porque falta
  `SDK_PANEL_GATEWAY_SECRET` en Gateway y panel. El hilo no carga, por lo que aún
  no se hicieron takeover, respuesta humana, segunda entrada ni release. No se
  ejecutó reset ni hubo otro inbound después del corte.
- Teclado y viewport móvil se revisaron parcialmente: Tab alcanzó la navegación
  con foco visible y 390 × 844 px no produjo desbordamiento horizontal. La sesión
  aún no tenía configurado el secreto compartido v1 en ese punto, por lo que no se
  pudo validar entonces el hilo/compositor ni continuar el smoke real.
- El smoke live de WhatsApp completó takeover, respuesta humana, entrada durante
  `human` y release con `process_pending`; el panel mostró una respuesta de IA
  enviada una vez. Para la prueba se habilitó temporalmente `conversations:write`
  en un panel adicional de loopback y luego se cerró; el actor del panel original
  conservó sus capacidades. El chat de prueba quedó `neutral/off` y
  `globalMode=ignored_all` se verificó al final. La evidencia no inspeccionó el
  payload de contexto live. Ver [F6.4](F6.4-SMOKE-CANAL.md).

## Revisión del backlog antes de F7

- En esa revisión, `work` y `origin/work` estaban sincronizados en `5a77104` y no se
  iniciaría F7 mientras F6.4 siguiera pendiente, porque la hoja de ruta exige v1
  estable. F6.4 se cerró en la continuación documentada abajo.
- BUG-006/007 tenían evidencia de cierre F5.5/F5.7/F5.8, pero sus filas seguían
  abiertas; BACKLOG.md ahora refleja los cierres y referencias de aceptación.
- Gates por alcance de F7: BUG-024 antes de habilitar operadores limitados;
  BUG-008/046 antes de afirmar paridad segura de comandos Telegram; BUG-035 en la
  aceptación del pairing; BUG-072 prohíbe asumir retry seguro del test de token.
  BUG-075/076 quedan condicionados a ofrecer conciliación o paridad de replay.
- BUG-010/011 requieren aceptación o reparación si se conserva paridad de comandos
  legacy. BUG-051 bloquea migrar un archivo runtime existente; BUG-071/073/074 y
  BUG-066/069 siguen en sus límites anotados. No se ejecutaron pruebas en esta
  revisión documental.

## Reanudación de F6.4 — 2026-10-22

- En `d7af68b` se inició una instancia local de Brain, Gateway y Panel con listeners
  loopback. Health checks: HTTP 200; WhatsApp/Telegram `open`; Brain `ok`;
  `globalMode=ignored_all`; cola pendiente 0. El actor de Panel tuvo solo
  `conversations:read`. La API mostró 48 conversaciones, 0 no leídas y 4 con
  `requiresReview`; no se modificaron controles ni se enviaron mensajes.
- `cd gateway && npm run panel:check`: typecheck pasa, 13 pruebas Vitest pasan,
  build Vite pasa y `panelWebBuild.test.js` pasa 1/1. `/inbox/` respondió HTTP 200;
  las cuentas WA y TG reportaron estado `connected`.
- En la primera inspección visual CUA reportó inventario vacío de aplicaciones y
  navegadores. El contexto de una generación live no se instrumentó y el smoke de
  Telegram seguía sin ejecutar; la instancia quedó disponible en loopback.
- En la continuación del 2026-10-22 se recibió un segundo marcador WA live durante
  `human`; `pending-resume` mostró un candidato y cero salidas inciertas. Se procesó
  la selección explícita y el archivo confirmó una respuesta IA `external_self`
  enviada una vez. Se permitió temporalmente solo ese chat, con `globalMode` aún
  `ignored_all`; al terminar quedó `neutral/off`, `status=confirmed`, cola y
  trabajos en vuelo en cero. El panel de escritura adicional se cerró.
- Se corrigió el layout móvil: con un hilo seleccionado, 390 × 844 y 320 × 844 px
  mostraron historial y compositor sin overflow ni solapamiento con la navegación;
  a 390 × 844 px el compositor estuvo habilitado durante takeover humano. El build
  de la bandeja pasó con `npm run panel:build`. En la continuación, Tab recorrió
  los 64 elementos alcanzables del hilo con foco visible en todos; incluyó
  devolución de control, resolución, historial y compositor. `Tomar control`
  también recibió foco visible en modo pausado. El hilo se restauró a atención
  pausada y el panel temporal se cerró.
- Telegram se reserva para administración. El marcador enviado al chat
  administrativo/self-chat se enrutó por `self_chat_ai` y produjo una respuesta
  legacy; queda como observación de esa ruta. El smoke de atención a clientes TG
  no aplica al alcance acordado. La revisión final trazó la petición live desde el
  inbound seleccionado hasta `message`, el historial SQLite y la etiqueta
  `Operador humano`; `node --test tests/f63ConversationFlow.test.js` pasó 1/1 y
  comprueba el contrato integrado. No se conservó el JSON literal de la petición
  live. F6.4 y Fase 6 quedan completadas con esa limitación registrada.
  [Evidencia](F6.4-SMOKE-CANAL.md).

## Fase 7.1 — Resumen con métricas del archivo — 2026-10-22

- En `main`, se añadió la primera vista real de F7: Resumen con periodos móviles
  de 7/30 días, inicio incluido y fin excluido en UTC. La API autenticada exige
  ambos límites, máximo 90 días y permiso `conversations:read`.
- Los conteos usan mensajes entrantes con secuencia durable y salidas de IA/humano
  cuyo estado del outbox es `accepted`, agrupados por canal. Se muestra la fecha
  mínima de entrada aún disponible en el archivo; no se infiere actividad fuera
  de sus datos retenidos y no se expone texto ni identidad.
- La migración SQLite v11 añade índices de consulta temporal; se aceptó v11 en
  lectura inmutable/importación. El proxy valida `SummaryResponse`. La navegación
  React enlaza `/inbox/summary`, con estados de carga/error, periodo, métricas,
  tabla de canales y nota de cobertura.
- Verificación: `npm run check` en la raíz (contratos) y `cd gateway && npm run
  check` (lint, typecheck, 14 pruebas Vitest, build y pruebas completas del
  Gateway). La prueba agregada comprueba límites `[from,to)`, conversaciones
  únicas por canal, salidas aceptadas y rechazo de intervalos inválidos; la prueba
  de API cubre contrato, query incompleta y permiso.
- Alcance cerrado: solo la unidad Resumen. Contactos, Canales, Asistente, Sistema
  e inventario de paridad siguen pendientes dentro de F7. No se hizo push ni
  despliegue.

## Fase 7.2 — Contactos — 2026-10-22

- React reemplaza el placeholder de Contactos por una lista paginada de conversaciones
  archivadas, búsqueda por nombre y filtro por canal. La lista no expone teléfono,
  JID ni ID remoto; incluye acceso, perfil IA y enlace a la conversación.
- Los cambios de acceso/perfil usan PATCH v1 por `conversationId`, exigen
  `conversations:write` y comparan `controlVersion`. El backend delega al
  ControlService SQLite; cambiar el perfil mantiene la invalidación durable del
  contexto. El endpoint autenticado `/v1/profiles` devuelve únicamente clave y
  nombre, nunca contenido de prompts. Actores sin escritura ven valores de solo
  lectura. La ficha de Bandeja muestra permiso y perfil desde la misma proyección.
- BUG-024 no se amplió: la UI nueva no llama endpoints legacy y no se incorporaron
  grants limitados. Perfiles no disponibles quedan visibles como tales; la API
  valida cada asignación contra el inventario actual antes de guardar.
- Verificación: raíz `npm run check` pasó (17 pruebas de contratos); tras regenerar
  contratos se ejecutó `cd gateway && npm ci`. `cd gateway && npm run check` pasó
  lint, typecheck, panel typecheck, 16 pruebas React, build Vite, prueba de montaje
  y 318 pruebas de Gateway. La suite de API cubre listado de perfiles sin contenido,
  denegación de escritura a actor de solo lectura y asignación de perfil con CAS.
- No se hizo push ni despliegue. Siguiente unidad: F7.3 Canales; cubrir pairing
  existente sin iniciar una segunda instancia ni alterar QR/código vigentes.

## Fase 7.3 — Canales — 2026-10-22

- `/inbox/channels` muestra el estado de WhatsApp y Telegram desde cuentas v1.
  Pairing WhatsApp reutiliza el único gateway: SSE QR con vencimiento visible,
  solicitud por código restaurada, expiración informativa y bloqueo de controles
  mientras otro método está activo. No se agregó inicio de gateway ni transporte.
- Telegram se presenta solo como canal administrativo. La pantalla escribe token
  y Chat ID reingresados por el administrador; nunca lee sus valores guardados.
  `/telegram/settings/meta` responde solo `configured` y `chatIdConfigured`. No
  hay botón de prueba ni ejecución de `/telegram/test` desde React.
- BUG-024 cerrado: con OAuth, `admin:write` explícito habilita `/api/*` legacy y
  su UI; sesiones de solo lectura conservan `/inbox/*`. Pruebas verifican que
  status, QR, logs, command y reset se deniegan antes del proxy, incluso con
  `X-Status-Token`, mientras una cuenta administrativa autorizada pasa.
- Verificación: raíz `npm run check` pasó (17 contratos). Gateway `npm run check`
  pasó ESLint, typecheck, 21 pruebas React, build y prueba de montaje, más 320
  pruebas Gateway. `panelBoundary.test.js` y `telegram.test.js` pasaron 32/32.
  Se usaron solo datos/stubs; no se inició pairing real ni se envió Telegram.
- No se hizo push ni despliegue. Siguiente unidad: F7.4 Asistente.

## Fase 7.4 — Asistente — 2026-10-22

- `/inbox/assistant` reemplaza el placeholder con lista y editor de perfiles
  Markdown. La sesión sin `admin:write` ve solo claves/nombres mediante `/v1/profiles`
  y no solicita contenido ni llama rutas legacy. La edición usa rutas `/api/*` ya
  cerradas por la frontera OAuth de F7.3.
- El borrador protege los cambios al cambiar de perfil y navegar, y avisa ante
  recarga/cierre. Importa `.md`/`.txt` local hasta 900.000 bytes; exporta desde el
  borrador actual, incluso con cambios pendientes. Incluye guardar, confirmación
  antes de sobrescribir una clave, recarga, prompt compilado y eliminación
  confirmada; `default` conserva su protección. Las restricciones de formato las
  valida el brain y un rechazo conserva el borrador.
- Pruebas de componente con APIs simuladas: 9 casos para permisos, lectura, edición,
  cambios sin guardar, navegación cancelada, guardado exitoso/rechazado, reemplazo,
  importación/exportación, recarga, prompt y eliminación. No se conectó brain live.
- Verificación: `cd gateway && npm run check` pasó ESLint, typecheck Gateway/React,
  30 pruebas React, build Vite y montaje bajo `/inbox`, más 320 pruebas Gateway.
  No cambiaron contratos y no se ejecutó un proveedor real.
- No se hizo push ni despliegue. Siguiente unidad: F7.5 Sistema.

## Fase 7.5 — Sistema — 2026-10-22

- `/inbox/system` reemplaza el placeholder e incorpora diagnóstico, logs SSE de
  Gateway/Brain, consola del manejador administrativo, inicio de Brain, pausa del
  bot y mantenimiento. Sistema aparece también en la navegación móvil.
- Solo `admin:write` solicita estado, logs y operaciones legacy. Los comandos no
  pasan por una shell. Limpiar logs pide confirmación y afecta el archivo activo;
  los rotados se conservan. La pantalla conserva restart, reset de sesión WA y el
  reset limpio con confirmación inicial, 10 s de lectura, palabra `BORRAR-TODO`
  durante 60 s y una sola solicitud. Ante resultado destructivo incierto bloquea
  otro intento y pide revisar el estado.
- Prueba enfocada: 8 casos con API y EventSource simulados. Se probaron permisos,
  estado, Brain, comando único, ciclo SSE/filtros, limpieza de logs, reset WA,
  temporizadores/palabra exacta del reset limpio y reinicio Gateway. No se ejecutó
  ningún comando real ni se modificó estado local/runtime.
- `cd gateway && npm run check` pasó ESLint, typecheck Gateway/React, 38 pruebas
  React, build Vite, montaje bajo `/inbox` y 320 pruebas Gateway. `git diff --check`
  pasó. Sin cambios de contratos y sin proveedores externos.
- Evidencia: [F7.5-SISTEMA](F7.5-SISTEMA.md). No se hizo push ni despliegue.
  Siguiente unidad: F7.6, inventario de paridad.

## Fase 7.6 — Inventario de paridad — 2026-10-22

- Se compararon las pestañas legacy Dashboard, WhatsApp, Telegram, Contactos,
  Perfiles y Logs con las rutas React. El documento distingue funciones migradas,
  nuevas, omitidas deliberadamente y disponibles solo en `/`.
- El panel legacy se mantiene para administradores: conserva métricas de diagnóstico
  que aún no están en React, búsqueda por teléfono/LID y contactos antiguos sin
  conversación. La página React omite la prueba de envío Telegram; configurar el
  canal con Chat ID manual sigue cubierto. No se retiraron rutas ni se llamó al bot.
- La suite de frontera ejecutada en F7.5 verifica que OAuth conserva la separación:
  solo lectura v1 no habilita `/api/*` ni UI legacy y `admin:write` sí. F7.6 es
  documental; no se repitieron pruebas de runtime. Evidencia:
  [F7.6-PARIDAD-PANEL](F7.6-PARIDAD-PANEL.md).
- No se hizo push ni despliegue. Siguiente fase: F8, estructura final y operación.

## Fase 8.1a — STT dentro de `apps/` — 2026-10-22

- `stt/` se movió a `apps/stt/`. La imagen copia desde la nueva ruta de origen,
  pero conserva `/app/stt`, `STT_CACHE=/var/lib/sdk-bot-stt/models` y el volumen
  Compose; no se movieron modelos ni estado runtime.
- `.gitignore`, `.dockerignore`, `AGENTS.md`, `.env.tuning`, comentarios del gateway,
  arquitectura y roadmap reflejan el nuevo código. El resto de componentes sigue
  en sus rutas actuales y F8.1 permanece en progreso.
- Verificación: `python3 -m py_compile apps/stt/server.py`; `cd gateway && node
  --test tests/stt.test.js` (7/7); `SDK_PANEL_GATEWAY_SECRET=local-validation-placeholder docker
  compose -f deploy/docker/compose.yml config --quiet`; build real
  de `deploy/docker/stt.Dockerfile`; contenedor local sin puertos publicados
  devolvió `/health` con status `ok`, `ready:false` (el modelo no se descargó ni
  cargó). El contenedor e imagen temporales se eliminaron. `git diff --check` pasó.
- No se inició Gateway ni se contactó a un canal. Siguiente subunidad: F8.1b,
  mover Gateway con sus rutas de estado y credenciales preservadas.

## Fase 8.1b — Gateway dentro de `apps/` — 2026-10-22

- Los 161 archivos versionados de `gateway/` se movieron a `apps/gateway/`.
  Archivos ignorados de sesiones, datos, logs y dependencias no se movieron.
  `apps/gateway/lib/repoPaths.js` mantiene los defaults de estado en las rutas
  existentes `gateway/` y `brain/`; no se hizo migración de datos.
- El paquete independiente ahora consume contracts con `file:../../packages/contracts`.
  Docker, CI, launchers Linux/Windows/Termux y sus instrucciones ejecutan el nuevo
  entrypoint. Compose mantiene los volúmenes y archivos de estado existentes.
- Verificación: prueba de rutas por defecto 1/1; `npm run check` en
  `apps/gateway/` (lint, typecheck, 38 tests del panel, build Vite y 321 tests del
  gateway); `bash -n` de los launchers; Compose `config --quiet`; smoke Gateway +
  panel en puertos/estado temporales con transporte WhatsApp simulado; build real
  de `deploy/docker/gateway.Dockerfile`; `git diff --check`.
- El smoke no detuvo ni reemplazó los procesos activos del checkout. No se
  conectó a proveedores, no se publicó imagen y no se hizo push. F8.1 sigue en
  progreso; el panel sigue anidado en `apps/gateway/panel/` y el brain en `brain/`.
- Siguiente subunidad: F8.1c, mover el proceso y frontend del panel a `apps/panel/`
  manteniendo sus dependencias y rutas de estado.

## Fase 8.1c — Panel dentro de `apps/` — 2026-10-22

- Los 46 archivos versionados del panel se movieron a `apps/panel/`. El proceso,
  UI legacy y app React/Vite quedan fuera del paquete Gateway; el panel conserva
  solo imports de infraestructura HTTP sin estado desde `apps/gateway/lib/`.
- Panel tiene manifest/lock y dependencias propios, igual que Gateway. Ambos
  consumen `packages/contracts` desde el checkout. El launcher, CI, Docker,
  Compose, Windows, README, AGENTS y guías de arquitectura/OAuth usan las rutas
  nuevas; `.env`, sesión, logs y DB siguen bajo `gateway/` y `brain/`.
- `npm ci` limpio en `apps/gateway/` y `apps/panel/`; `cd apps/gateway && npm run
  check`: lint/typecheck, 38 pruebas Vitest, build Vite, prueba HTTP del artefacto
  y 321 pruebas Gateway pasan. La primera corrida encontró un `require.resolve`
  de test con la ruta vieja; corregido y confirmado con `node --test
  tests/panelBoundary.test.js` (21/21) y la suite completa posterior (321/321).
- `bash -n` de launcher/smoke Linux y scripts Termux; Compose `config --quiet`;
  `git diff --check`. Smoke del launcher en puertos 21510/21520/21530/21540, con
  WhatsApp sustituido por transporte offline y estado, PID, logs y DB temporales;
  Gateway, panel y `/inbox` respondieron y el cleanup liberó los puertos.
- Build de `deploy/docker/gateway.Dockerfile` pasó. Un contenedor temporal con el
  entrypoint real del panel sirvió `/` y `/inbox/` con HTTP 200; imagen y
  contenedor temporales eliminados. No se iniciaron canales ni se contactó IA o
  proveedores; el stack activo de los puertos por defecto permaneció arriba.
- No se hizo push ni despliegue. F8.1 sigue en progreso; brain y sus perfiles/
  estado permanecen en `brain/`. Siguiente subunidad: F8.1d, mover el código del
  brain sin trasladar secretos, memoria ni perfiles.

## Fase 8.1d — Brain dentro de `apps/` — 2026-10-22

- El código Python, tests, requirements y configuración Ruff del Brain viven en
  `apps/brain/`. `brain/` conserva `.env`, perfiles editables, memoria, logs y el
  venv. `runtime_paths.py` resuelve el estado configurable con
  `SDK_BRAIN_STATE_DIR` (por defecto `brain/`); `.env.tuning` continúa en la raíz.
- Linux, Docker, Compose, CI, Windows y Termux usan el entrypoint nuevo. Los
  perfiles, DB, logs, lock y credenciales conservan sus rutas; no se migraron
  datos. Windows/Termux no se ejecutaron en esos sistemas y queda pendiente la
  validación real allí.
- Verificación: Ruff limpio; pytest Brain 29/29; `py_compile`; `bash -n` de los
  launchers; Compose `config --quiet`; `apps/gateway npm run check` (lint,
  typecheck, Panel 38/38, build y Gateway 321/321); `git diff --check`.
  El launcher Brain en puerto temporal :21610 y un contenedor de la imagen
  `brain.Dockerfile` en :21611 devolvieron `/health` con `ok`. Se eliminaron
  ambos puertos, estado temporal, contenedor e imagen; Brain, Gateway y Panel
  habituales permanecieron sanos en :5100, :5300 y :5201.
- No se iniciaron canales ni se contactó a proveedores IA. No se hizo push ni
  despliegue. F8.1 queda cerrada; siguiente punto: revisar/migrar settings y
  campañas mediante repositorios con corte verificable (Fase 8).

## Fase 8.2a — Repositorio de persistencia de campañas — 2026-10-22

- `broadcastService.js` delega lectura y escritura en
  `services/repositories/jsonBroadcastRepository.js`; mantiene el archivo,
  schema, ruta `gateway/broadcast_db.json` y reemplazo atómico `.tmp` + rename.
  El servicio conserva recuperación de cursor y la regla que pausa como incierto
  un envío legado sin clave durable.
- El inventario de accesos confirma que settings/contactos ya pasan por
  `services/db.js`; F8.2a saca la última escritura JSON embebida en lógica de
  campañas. No se hizo corte a SQLite ni migración de datos.
- Verificación: repositorio y servicio de campañas, 15/15 pruebas; ESLint y
  typecheck de Gateway; `git diff --check`. Los tests usan archivos temporales y
  transporte falso; no se iniciaron canales ni se envió ningún mensaje real.

## Fase 8.2b — Repositorio de settings — 2026-10-22

- `db.js` conserva la caché, defaults, debounce, flush de cierre y barrera de
  factory reset; el read/write de `settings_db.json` se delega a
  `services/repositories/jsonSettingsRepository.js`. El schema, archivo y
  autoridad de settings no cambian. La persistencia de contactos sigue en `db.js`.
- Prueba de corte SQLite: se importa y activa control en una DB temporal, se cambia
  la política, se guarda después una configuración Telegram con campos legacy
  antiguos y el snapshot de control sigue vigente; SQLite continúa como autoridad
  para la política global.
- Verificación: repositorio/db/control service, 13/13 pruebas; defaults seguros,
  BOM, debounce con último valor, recarga tras reinicio, ESLint y typecheck. Todo
  usa rutas temporales; no se leyeron ni mutaron archivos runtime reales.
- F8.2 queda cerrada: servicios de campañas y settings usan repositorios para
  persistencia JSON. Los archivos y rutas runtime se conservan; no hay migración
  de formato de datos. Siguiente punto: runbook de backup/restauración, retención,
  exportación/purga y rollback (Fase 8).

## Fase 8.3a — Backup offline y ensayo aislado — 2026-10-22

- `docs/F8.3-OPERACION-RECUPERACION.md` inventaría el estado en volúmenes,
  describe la captura offline del volumen sensible con checksum y fija el límite
  de restauración: la copia se extrae a un volumen nuevo, nunca encima del estado
  activo. El worker puede reaplicar retención y rotar epoch en una copia SQLite;
  la promoción productiva queda pendiente hasta reconciliar el delta posterior.
- No existe aún un job de backup programado, destino externo configurado ni CLI de
  recuperación completa. El runbook lo declara explícitamente; no se operó Docker
  de producción ni se leyeron archivos runtime reales.
- Verificación: `SDK_BOT_TEST=1 node --test tests/conversationArchive.test.js`
  (21/21: backup con WAL, rechazo de destino existente, restore con epoch nuevo e
  independencia del origen); roundtrip tar/checksum/listado/extracción con fixture
  temporal; `bash -n` en los dos bloques del runbook; `git diff --check`.
- F8.3a queda documentada. Siguiente punto: F8.3b, retención, exportación y purga;
  después siguen rollback de código/datos y minimización de métricas/logs.

## Fase 8.3b — Retención, purga y exportación — 2026-10-22

- El runbook documenta la ejecución real de la purga (al arrancar antes de admitir
  canales y luego cada 24 h), lotes de 500 y límites estrictos: cuerpos 90 días,
  eventos 7 días/50.000 secuencias y huellas 180 días. Distingue el API autenticado
  de lectura por páginas de una exportación temporal auditada, que no está
  implementada; tampoco existe purga inmediata por conversación/actor.
- Aclara que esta retención no cubre contactos, settings, campañas, cola, memoria,
  sesión de canal ni logs; los backups tienen su propia ventana y pueden conservar
  contenido ya purgado del archivo vivo.
- Verificación: `SDK_BOT_TEST=1 node --test tests/conversationArchive.test.js
  tests/whatsappCapture.test.js` (46/46). Incluye frontera estricta de 90/180 días,
  corte de eventos, purga previa a admisión, lotes acotados y fallo inicial.
  `git diff --check`; pruebas con DB y estado temporales, sin proveedores.
- Siguiente punto: F8.3c, runbook de rollback de código/datos y delta del corte.

## Fase 8.3c — Rollback de código y corte de control — 2026-10-22

- El runbook separa rollback de código con el mismo volumen, reversión por lotes
  del corte F5.3 mientras la autoridad sigue `legacy`, y recuperación de pérdida
  física. Explica que `--resume-cutover` exige fuentes iguales; `--rollback` solo
  revierte controles aún no activados y deja mensajes, envíos, ledger y JSON en su
  autoridad vigente. Después del cambio a SQLite no se vuelve a JSON ni se repone
  un snapshot antiguo encima de la DB activa.
- Los comandos Compose de recuperación corren Gateway one-shot con el volumen de
  estado y perfiles, sin levantar canales/dependencias. Una fuente cambiada,
  autoridad ya conmutada o conflicto deja la recuperación bloqueada.
- Verificación: `SDK_BOT_TEST=1 node --test tests/conversationControlImport.test.js
  tests/conversationControlMigration.test.js` (14/14: CLI read-only, fuentes,
  delta, cutover interrumpido, rollback por lotes y versiones monotónicas);
  `git diff --check`; pruebas solo con SQLite/JSON temporales.
- Siguiente punto: F8.3d, minimizar datos de cliente en métricas y logs con pruebas.

## Fase 8.3d — Minimización de datos en métricas y logs — 2026-10-22

- Gateway y Brain ya omiten texto/transcripciones, nombres, teléfonos e IDs de
  cliente en logs de atención. Errores quedan en etiquetas acotadas; Uvicorn
  desactiva access logs para no escribir `user_id` de `/history` desde la URL.
  `/status` publica vínculo administrativo como booleano, motivos/códigos de
  captura saneados y métricas agregadas; el panel deja de mostrar el teléfono.
- Los logs históricos no se reescriben y permanecen hasta rotación normal o
  borrado explícito. El runbook documenta esa exposición residual.
- Verificación: `cd apps/gateway && npm run check` (lint, typecheck, panel:
  38 pruebas + 1 prueba de integración/build, Gateway: 330/330); `cd apps/brain && ../../brain/venv/bin/ruff
  check . && ../../brain/venv/bin/python -m pytest tests/ -q` (30/30). Pruebas de
  privacidad usan sentinels y almacenamiento temporal; no iniciaron proveedores
  ni canales reales. `git diff --check`.
- Siguiente punto: F8.4, ensayo aislado de restauración con fixture y delta.

## Fase 8.4 — Ensayo aislado de restauración y delta — 2026-10-22

- `apps/gateway/scripts/restore-promotion-check.js` agrega una puerta offline y
  de solo lectura. Compara la fuente detenida con el candidato por schema,
  `dataEpoch`, secuencia, autoridad de control y huella SHA-256 del ledger entero
  de envíos. Bloquea integridad/FK incorrectas y estados outbound sin resolver;
  no imprime payloads ni muta/restaura/promueve archivos. Gateway detenido y DB
  sin WAL/SHM/journal son requisitos.
- El fixture importa contactos/settings y ejecuta el corte F5 antes del backup.
  Después del snapshot prueba un aviso aceptado sin evento, un intent pendiente,
  un inbound y una respuesta humana aceptada. La puerta bloquea cada delta; el
  restore antiguo solo se abre en una DB temporal y la fuente conserva sus
  mensajes/salidas nuevos. Un snapshot fresco vuelve a pasar.
- Límite: la puerta verifica el archivo SQLite de conversaciones, no valida por
  sí sola el resto del volumen de estado ni promueve una recuperación real. Sin
  fuente actual solo se permite restore aislado y se debe declarar la ventana sin
  cobertura.
- Verificación: `cd apps/gateway && node --test tests/conversationRecovery.test.js`
  (1/1); `npm run check` (lint, typecheck, panel 38/38 + build integration 1/1,
  Gateway 331/331); `git diff --check`. No se conectaron canales ni proveedores.

## Fase 9.1 — Archivo autenticado de adjuntos — 2026-10-22

- SQLite v12 registra metadatos de adjuntos ligados a mensajes y la API v1 los
  entrega por ID solo tras autorizar `conversations:read` y verificar acceso a
  la conversación. Los binarios viven en un directorio privado, con nombres
  opacos, tamaño máximo de 16 MiB, cuota agregada de 1 GiB y retención de 90 días.
  Panel transmite el binario con límites y headers validados; la purga conserva
  un marcador comprensible si el blob vence o falta. F8.4 compara también la
  huella del ledger de metadatos; no comprueba los bytes del volumen.
- Verificación: `npm run contracts:generate && npm run check` en raíz;
  `cd apps/gateway && npm ci && npm run check` (lint, typecheck, panel 39/39 +
  integración/build 1/1, Gateway 338/338); pruebas focales de adjuntos 5/5 y
  regresión de migración/retención/privacidad 70/70; `git diff --check`. Datos
  temporales; no se iniciaron canales ni proveedores.
- Siguiente punto: F9.2, conectar captura durable de medios por canal y cubrir
  citas/ediciones/borrados solo donde cada proveedor expone esa capacidad.

## Fase 9.2 — Multimedia y mutaciones por canal — 2026-10-22

- WhatsApp y Telegram guardan binarios recibidos live en el archivo F9.1, con
  concurrencia acotada y marca durable `failed` si la descarga falla. Las citas
  resuelven el ID interno cuando el original sigue presente; si falta, conservan
  una vista previa acotada. Ediciones observadas generan `message.updated` e
  invalidan `contextVersion`. Revocaciones WhatsApp redactan el contenido y
  programan el borrado del blob. La bandeja representa citas, edición y borrado.
- Límites verificados: el self-chat WhatsApp sigue excluido y no se descargan
  medios del historial. Telegram queda como canal administrativo; no hubo prueba
  real de atención al cliente. El Bot API normal no aporta borrado genérico ni
  recibos de entrega/lectura; no se inventan esos estados. F9.2 no prueba
  recepción con proveedores reales.
- Verificación: `npm run contracts:generate` y `npm run check` en raíz (17/17
  contratos); `cd apps/gateway && npm run check` (lint, typecheck, panel 39/39,
  integración/build 1/1, Gateway 342/342); `node --test
  tests/conversationMultimedia.test.js` (4/4); `git diff --check`.
- Commit local de la unidad creado. No publicar.
- Siguiente punto: F9.3, búsqueda de contenido con FTS5 y paginación verificable.

## Fase 9.3 — Búsqueda FTS5 — 2026-10-22

- SQLite v13 crea el índice FTS5, lo rellena al migrar desde v12 y sincroniza
  altas, ediciones, transcripciones, revocaciones y purgas mediante triggers.
  Indexa texto, captions y transcripciones; excluye cuerpos oversized y borrados.
- `GET /v1/conversations/{id}/search` requiere `conversations:read` y comprueba
  acceso al hilo antes de buscar. Normaliza los términos como texto literal; no
  permite inyectar operadores FTS. Cursor HMAC ligado a actor, hilo, consulta,
  límite, época y secuencia; SQLite valida el snapshot en la misma llamada que
  consulta la página. Una escritura durante la paginación devuelve
  `CURSOR_EXPIRED`; la bandeja permite reiniciar la búsqueda. Los snippets se
  muestran como texto plano.
- Evidencia: [F9.3-BUSQUEDA-FTS.md](F9.3-BUSQUEDA-FTS.md).
- `npm run check` raíz: contratos 17/17. `cd apps/gateway && npm run check`:
  lint, typecheck, Panel 40/40, build, integración 1/1 y Gateway 346/346.
  `git diff --check` limpio. Sin proveedores reales.
- Commit local de la unidad creado. No publicar.
- Siguiente punto: F9.4, integrar ledger, binarios e índices en backup/restauración
  coherente y ensayar el ciclo completo.

## Fase 9.4 — Backup/restauración de ledger, blobs e índice FTS — 2026-10-22

- La puerta offline de restore comprueba consistencia FTS v13 y blobs físicos:
  compara filas indexadas con mensajes elegibles; valida archivos `.blob` privados,
  presencia, tamaño, SHA-256 y ausencia de extras contra el ledger. Un candidato
  que reutiliza el mismo directorio físico de blobs queda bloqueado.
- Ensayo integral: crea caption y blob, genera DB snapshot con `VACUUM INTO`, copia
  blobs, pasa la puerta, restaura a un directorio aislado, consulta FTS y compara
  los bytes descargados. Índice y blob alterados por separado son rechazados.
  Runbook: [F9.4-BACKUP-RESTORE.md](F9.4-BACKUP-RESTORE.md); límites operativos
  actualizados en [F8.3](F8.3-OPERACION-RECUPERACION.md).
- Verificación: pruebas focales F9.4/adjuntos/búsqueda 12/12; `npm run check` raíz
  con 17/17 contratos; `cd apps/gateway && npm run check` con lint, typecheck,
  Panel 40/40, build Vite, integración 1/1 y Gateway 347/347; `git diff --check`.
  Solo DB/archivos temporales; no se iniciaron canales ni proveedores.
- Commit local de esta unidad creado; no publicar.
- Siguiente punto: Fase 10, primera entrega vertical de resúmenes/borradores y
  propuestas de respuesta con referencias verificables al hilo.

## Fase 10.1 — Asistencia al operador con referencias al hilo — 2026-10-22

- Bandeja y contrato v1 preparan resumen y borrador solo para WhatsApp con
  `admin:write` + `conversations:read`, SQLite como autoridad lista, conversación
  permitida/abierta/confirmada y sin revisión. Telegram queda fuera por su uso
  administrativo.
- El Gateway forma contexto reciente desde SQLite (hasta 40 mensajes, 24.000
  caracteres; texto, captions y transcripciones), enlaza la solicitud al snapshot
  y `contextVersion`, valida de nuevo snapshot, control y política al finalizar y
  reconstruye referencias solo con IDs del contexto fuente. Brain valida JSON e
  IDs y no persiste memoria. La UI muestra divulgación del proveedor, citas
  navegables y copia el borrador al compositor solo por acción del operador; esta
  ruta no crea mensajes ni intenciones de salida.
- Evidencia: [F10.1-ASISTENCIA-OPERADOR.md](F10.1-ASISTENCIA-OPERADOR.md).
- Verificación: contratos 18/18; `cd apps/gateway && npm run check` con lint,
  typecheck, panel 41/41, build, integración 1/1 y Gateway 351/351; Brain Ruff
  limpio y 32/32; `git diff --check`. Sin proveedor real ni canales iniciados.
- Commit local de esta unidad creado; no publicar.
- Siguiente punto: F10.2, contratos de herramientas con schemas, permisos,
  timeout, auditoría, idempotencia y separación read/write; Gateway ejecuta y
  Brain solicita sin acceso a canales.

## Fase 10.2 — Contratos y ejecución segura de herramientas IA — 2026-10-22

- Se habilita únicamente `conversation.search_messages`, lectura acotada al hilo
  y snapshot con `conversations:read`; Brain puede pedirla una vez y Gateway la
  ejecuta en tres segundos como máximo. El contrato rechaza efectos write y no da
  al Brain acceso a SQLite, adaptadores, canales, URLs arbitrarias o shell.
- SQLite v14 conserva auditoría con hashes de solicitud/resultado, actor, hilo,
  herramienta, estado e intentos; no consulta ni contenido, retención de 180 días.
  Backup/checkpoint preserva el digest y la puerta de restore bloquea diferencias
  sin exponerlo. La bandeja puede cargar páginas antiguas hasta 50 para enfocar una
  cita de asistencia.
- Evidencia: [F10.2-HERRAMIENTAS-IA.md](F10.2-HERRAMIENTAS-IA.md).
- Verificación: contratos 19/19; Gateway lint/typecheck, panel 42/42, build,
  integración 1/1 y Gateway 356/356; Brain Ruff limpio y 34/34; `git diff --check`.
  Sin proveedores reales ni canales iniciados.
- Commit local de esta unidad creado; no publicar.
- F10.3 sigue condicional: no se pidieron integraciones ni acciones externas.
  Siguiente punto: F10.4, evaluaciones sintéticas de control humano, separación
  entre notas y mensajes entregados, aislamiento entre cuentas y límites explícitos.

## Fase 10.4 — Evaluaciones sintéticas de asistencia — 2026-10-22

- Gateway ejecuta tres escenarios contra la ruta real y SQLite temporal: asistencia
  bajo control humano sin cambios de snapshot/mensajes/outbox; borrador visible como
  borrador y ausente del archivo/outbox; aislamiento de búsqueda entre dos cuentas
  WhatsApp y rechazo de citas al mensaje ajeno.
- Brain ejecuta el caso sintético de una pregunta sin precio conocido con el
  proveedor sustituido; verifica que el prompt pide no inventar y solicitar el dato
  faltante. No mide obediencia ni precisión estadística de un proveedor real.
- Evidencia: [F10.4-EVALUACIONES-SINTETICAS.md](F10.4-EVALUACIONES-SINTETICAS.md).
- Verificación: contratos 19/19; Gateway lint/typecheck, panel 42/42, build,
  integración 1/1 y Gateway 359/359; Brain Ruff limpio y 35/35; `git diff --check`.
  Sin proveedor real ni canales iniciados. La primera ejecución concurrente tuvo
  un fallo de captura en `logPrivacy.test.js`; la prueba aislada pasó y Gateway
  completo aislado pasó 359/359.
- F10.3 sigue condicional; no se solicitó habilitar efectos externos. No hay F11 ni
  otro siguiente punto definido en ROADMAP.md; revisar BACKLOG y priorizar con el
  usuario antes de abrir una nueva unidad.

## F2C.3 — Inbox administrativo Telegram (BUG-046) — 2026-10-22

- SQLite v15 guarda el texto admin normalizado y el cursor Telegram en una sola
  transacción. Un pump reclama por cuenta/update antes del pipeline existente;
  el texto se elimina al terminar. Al reiniciar, claims `processing` pasan a
  `uncertain` y no se repiten; una caída entre claim y efecto también requiere
  revisión manual porque el comando legacy no comparte la transacción SQLite.
- El historial de clientes sigue separado. Checkpoint/restore compara cantidad y
  digest del inbox sin revelar el digest; los recibos terminales vencen a 180 días.
- Evidencia: [BUG-046-TELEGRAM-ADMIN-INBOX](BUG-046-TELEGRAM-ADMIN-INBOX.md).
- Verificación: contratos raíz 19/19; Gateway lint/typecheck, panel 42/42, build,
  integración 1/1 y Gateway 366/366; `git diff --check`. Sin Telegram real ni
  cambios de credenciales/configuración.
- Commit local de esta unidad; no publicar.
- Siguiente punto ejecutable del backlog: BUG-035, esperar `connect()` completo y
  propagar su fallo antes de solicitar código/abrir refresh de pairing.

## BUG-035 — Espera asíncrona de pairing — 2026-10-22

- `createWhatsappPairingCallbacks` hace que el pairing por código espere la
  conexión cuando el socket está cerrado y propague los errores de `connect`.
  Refresh devuelve/espera la misma promesa; una ventana QR vigente no crea un
  segundo socket.
- Evidencia: [BUG-035-PAIRING-ASYNC](BUG-035-PAIRING-ASYNC.md).
- Verificación focal: `tests/whatsappPairing.test.js`, `tests/adminPairing.test.js`
  y `tests/whatsappCapture.test.js`, 45/45; Gateway lint y typecheck; diff limpio.
  Sin cuenta ni transporte WhatsApp real.
- Commit local de esta unidad; no publicar.
- Siguiente prioridad local: BUG-008 (resolución exacta de identidad Telegram en
  el camino legacy, antes de cualquier mutación de contactos).

## BUG-008 — Resolución exacta de identidad legacy — 2026-10-22

- Comandos legacy ahora aceptan solo una identidad completa de teléfono/LID;
  sufijos y colisiones se rechazan antes de mutar estado, perfil, nombre o
  contexto. Los índices retiran aliases de teléfono/LID reemplazados.
- Telegram sigue como canal administrativo: las respuestas conservan ese adapter
  y el objetivo se resuelve en WhatsApp. SQLite mantiene el resolver por
  canal/cuenta; el fallback JSON antiguo solo representa la libreta WhatsApp.
- Evidencia: [BUG-008](BUG-008-RESOLUCION-IDENTIDAD-LEGACY.md).
- Verificación: Gateway `npm run check`, lint/typecheck, Panel 42/42, build,
  prueba de servido 1/1 y Gateway 378/378; focales 29/29; `git diff --check`.
  Sin proveedores ni canales reales.
- Commit local de esta unidad; no publicar.
- Siguiente punto ejecutable del backlog: BUG-010, acotar envíos legacy de
  Telegram sin repetir envíos con resultado incierto.

## BUG-010 — Deadlines de salida Telegram — 2026-10-22

- Adapter: `sendMessage` queda limitado a 10 s y presencia a 3 s. Menú y helper
  de notificaciones legacy usan 8 s. Solo el rechazo explícito de Markdown HTTP
  400 conserva su fallback sin formato y valida la cuenta antes del segundo POST.
- Un envío que vence queda `delivery_unknown`; la clave idempotente impide que
  otra llamada lo reenvíe automáticamente. Respuestas limitadas a 8 MiB y UTF-8
  estricto.
- Evidencia: [BUG-010](BUG-010-TIMEOUTS-SALIDA-TELEGRAM.md).
- Verificación: Gateway `npm run check`, lint/typecheck, Panel 42/42, build,
  servido 1/1 y Gateway 381/381; focales Telegram 31/31, incluida la regresión
  de outbox; `git diff --check`. Sin Telegram real.
- Commit local de esta unidad; no publicar.
- Siguiente punto ejecutable: BUG-011, preservar la elegibilidad de control al
  usar `/humano` y `/ia` con `ignored_all`.

## BUG-011 — Permisos de control legacy — 2026-10-22

- El fallback JSON conserva el acceso que tenía un contacto antes de entrar a
  `handoff`; `/ia` lo restaura y un handoff antiguo sin dato válido retorna a
  neutro. La expiración automática mantiene su comportamiento previo.
- SQLite deja el acceso intacto durante takeover/release. `/humano` y `/ia`
  explican cuando la política ignora al contacto o el modo global bloquea sus
  respuestas.
- Evidencia: [BUG-011](BUG-011-CONTROL-LEGACY.md).
- Verificación: Gateway `npm run check`, lint/typecheck, Panel 42/42, build,
  servido 1/1 y Gateway 384/384; focales 17/17; `git diff --check`. Sin
  proveedores ni canales reales.
- Commit local de esta unidad; no publicar.
- Siguiente punto ejecutable: BUG-071, corregir el total inflado del comando
  `/ignorar contactos de agenda`.

## BUG-071 — Resumen de ignorar agenda — 2026-10-22

- `setNumberState` expone el resultado actualizado/unchanged de SQLite. El
  resumen descuenta solo cambios efectivos y agrupa aliases por conversación.
- `totalIgnored` refleja las conversaciones únicas de agenda que quedan en
  estado ignorado; repetir el comando no aumenta `addedCount`.
- Evidencia: [BUG-071](BUG-071-RESUMEN-IGNORAR-AGENDA.md).
- Verificación: Gateway `npm run check`, Panel 42/42, build, servido 1/1 y
  Gateway 385/385; después del ajuste de lint, lint/typecheck y focal 1/1 pasan.
  `git diff --check` limpio. Sin canales reales.
- Commit local de esta unidad; no publicar.
- BUG-072 (sonda `/telegram/test` para token borrador) queda fuera del camino de
  atención al cliente y no bloquea las fases. Siguiente punto ejecutable: BUG-073,
  eco propio de WhatsApp recibido antes del ACK del envío.
