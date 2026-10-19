# Estado de continuidad — SDK-Bot

Actualización: 2026-10-19. Última unidad cerrada: **F2A; repositorios del archivo completados**.

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
- Sin migrar datos ni captura live. No hay bandeja nueva, páginas/SSE públicos,
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

- WA procesa solo primer elemento del lote; live no llama upsertMessage del store.
- Guardas contra socket reemplazado están en connection.update, no en todos los
  eventos de mensajes/contactos/historial/presencia.
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

## Siguiente unidad exacta: Fase 2 / F2B

**Entregable:** captura WhatsApp live/history sobre el archivo F2A. Telegram y ack
serán F2C. Generador/carga completa de VALIDACION es puerta de cierre de F2, no
se declara aprobada por el lote reducido de F2A.

1. Leer AGENTS/estado/arquitectura/ADR-005, SPEC/VALIDACION, informe F2A y backlog;
   revisar git status. Conservar Node >=22.13, worker SQL exclusivo y transportes.
2. Reparar BUG-029 antes de captura live: CLI debe detener/comprobar supervisor o
   abortar antes de borrar; simular auto-reinicio sin tocar servicios ni datos reales.
   BUG-030 está reparado: no volver a ignorar SDK_GATEWAY_LOCK_PATH.
3. Definir cuenta WA por identidad comprobada del proveedor, nunca por token ni
   UUID nuevo en cada arranque; registerAccount devuelve ID durable por providerKey.
   Alcance individual vs self/admin/grupo/status/broadcast explícito. No habilitar
   otra cuenta ni fusionar aliases por coincidencias de dígitos.
4. Captura independiente de texto/IA/STT y de permiso/pausa/handoff: todos los
   elementos messages.upsert, history_sync por lotes, IDs/fechas/procedencia,
   aliases con evidencia. requires_review del archivo debe impedir futura
   automatización/envío, sin crear un segundo control SQLite frente al JSON.
5. Resolver BUG-001/002/003 y parte WA de 008/009 con tests de adapter falso:
   lotes completos, callback de socket reemplazado sin efectos, sync/live/mismo
   ID en chats/cuentas, JID/LID verificados y conflictos sin mezcla. No atribuir
   corrección TG a pruebas WA. No copiar datos reales para validar.
6. Conectar admisión/commit antes de generación; aplicar backpressure a 1000/32MiB,
   observar saturación/fallo sin ack ficticio. No invocar IA en backfill/eco.
   Un timeout de RPC tiene resultado incierto; recuperar/dedup sin reintento ciego.
7. Multimedia base antes de STT y actualización del mismo ID/evento; fallos dejan
   marcador visible. Archivo no depende del cache RAM ni de memoria del brain.
8. Programar purga acotada antes de primeras capturas; cuerpo/eventos/huellas
   90/7/180d, estrictamente <cutoff. Contexto derivado aún no conectado: F5 deberá
   invalidarlo al purgar. No abrir HTTP de conversaciones ni SSE antes de F3.
9. Tests aislados, checks Node22/24 y distribución/launcher afectados; actualizar
   evidencia/backlog/roadmap/estado y commit local. No cerrar F2 completa sin TG
   durable, carga, dedup/retención y aceptación conjunta.

**Aceptación:** una ráfaga WA falsa se conserva al reiniciar, reimportación/eco no
crean nuevas entradas, sockets viejos no modifican estado y captura funciona con
IA pausada/ignorada/human. Sin contacto a cuentas/servicios reales.

## Pendientes materiales

- Driver y repositorios SQLite implementados/probados en Linux; falta Windows/
  Termux y captura en adapters. La DB del brain no es el archivo operativo.
- F2A implementa identidad/huellas/purga en repositorios. Faltan captura, scheduler
  y ensayo completo de corte/rollback/control y retención de contexto derivado. Los presupuestos de carga no están medidos.
- Historial previo completo no está garantizado por WA/Bot API.
- Validación real WA/TG y ejecución Windows/Termux siguen pendientes; usar cuenta
  de prueba y una única instancia. Conservar pendientes heredados de ROADMAP.

## Regla de cierre para la siguiente sesión

Actualizar este archivo y solo los checkboxes demostrados. El prompt estable de
[PROMPT-CONTINUIDAD.md](PROMPT-CONTINUIDAD.md) consulta este estado para retomar.
Hacer commit de la unidad probada e informar su hash. BUG-001 a 012 (010 parcial),
BUG-014, BUG-024 y BUG-029 siguen abiertos. BUG-013/019–023/025 cerrados F1B; BUG-015 F0.2,
BUG-017/018 F1A y BUG-016 cerrado en diseño F0.3, con prueba de repositorio real F2A; captura live aún pendiente.

Cierre F2A: commit local `git log --grep="close F2A"`; BUG-026/027/028/030 cerrados.
