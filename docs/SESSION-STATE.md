# Estado de continuidad — SDK-Bot

Actualización: 2026-10-19. Última unidad cerrada: **F0.3; Fase 0 completada**.

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
- No se modificaron módulos de producción ni se migraron datos. No hay bandeja nueva,
  DB operativa de conversaciones, API v1 ni control versionado implementados.

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

## Siguiente unidad exacta: Fase 1 / F1A

**Entregable:** workspace Node mínimo y packages/contracts con OpenAPI 3.1/JSON
Schema, validación runtime de formatos y generación/verificación de tipos.

1. Leer AGENTS, arquitectura, ADR-001 a 005, SPEC-OPERATIVA-V1, VALIDACION-V1,
   baseline, SQLITE-SPIKE y BACKLOG. Revisar git status y commits de cierre.
2. Crear workspace/paquete sin mover gateway/brain/stt/panel. Resolver locks, CI,
   Docker/npm ci y release-please de forma coherente; no romper instalaciones
   actuales por introducir una dependencia de workspace que su build no copie.
3. Definir cuenta, identidad, conversación, mensaje, control/operaciones, actor,
   errores y eventos con IDs texto y schemas canónicos, límites y versionado.
4. Separar controlVersion/aggregateVersion, dataEpoch/seq textual, dedup canónica,
   nulls/required y request/response DTO sin raw/secretos. expectedVersion liga control.
5. Validadores runtime y tipos TS generados o comprobados desde una sola fuente;
   OpenAPI referencia esos schemas. No duplicar un motor de políticas para tests.
6. Pruebas de aceptación/rechazo de formas: signo/precisión TG, UUID, Unicode,
   límites/paginación, versiones/errores; detectar deriva de schemas/tipos. Los
   casos de migración/dispatch de fixture siguen pendientes de sus fases reales.
7. Ejecutar checks adecuados con copia/estado temporales, revisar backlog y cerrar
   con docs/estado/commit. No marcar F1B ni endpoints como implementados por crear DTOs.

**Aceptación:** contratos válidos, tipos reproducibles, tests de formas útiles y
checks de compatibilidad del gateway en verde. Sin transporte, claves IA, DB
runtime ni migraciones. F1B incorporará sesión/contexto firmado y resolverá
BUG-013 antes de exponer historial autenticado.

## Pendientes materiales

- Driver SQLite seleccionado y probado en Linux; falta validación Windows/Termux
  y adopción en repositorios runtime. La DB del brain no es el archivo operativo.
- F0.3 fija identidad y retención 90d/7d/180d; falta implementarlas y ensayar el
  corte/rollback con repositorios reales. Los presupuestos de carga no están medidos.
- Historial previo completo no está garantizado por WA/Bot API.
- Validación real WA/TG y ejecución Windows/Termux siguen pendientes; usar cuenta
  de prueba y una única instancia. Conservar pendientes heredados de ROADMAP.

## Regla de cierre para la siguiente sesión

Actualizar este archivo y solo los checkboxes demostrados. El prompt estable de
[PROMPT-CONTINUIDAD.md](PROMPT-CONTINUIDAD.md) consulta este estado para retomar.
Hacer commit de la unidad probada e informar su hash. BUG-001 a BUG-014 siguen
abiertos; BUG-015 cerrado en F0.2 y BUG-016 cerrado en diseño F0.3, con ejecución
contra el repositorio de mensajes pendiente de F2.
