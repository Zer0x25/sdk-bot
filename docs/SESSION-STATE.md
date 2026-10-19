# Estado de continuidad — SDK-Bot

Actualización: 2026-10-19. Última unidad cerrada: **Fase 0 / F0.2**.

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

## Siguiente unidad exacta: Fase 0 / F0.3

**Entregable:** especificación operativa v1 que cierre identidad/aliases, acceso,
control, retención, migración/rollback y protocolo de medición antes de Fase 1.

1. Leer AGENTS, arquitectura, ADR-001 a 005, baseline, SQLITE-SPIKE, BACKLOG y roadmap;
   revisar git status y commits de cierre. No reabrir elección del driver sin evidencia.
2. Definir claves por cuenta/canal, aliases exactos y tratamiento de ambigüedades;
   traducción legacy de handoff/permisos sin reactivar IA ni mezclar identidades.
3. Fijar retención inicial propuesta de 90d independiente de memoria IA, borrado,
   exportación y caducidad de eventos/cursores de lectura; aclarar cobertura histórica.
4. Definir mantenimiento/corte y snapshot/delta; rollback posterior a nuevas
   escrituras no puede descartar mensajes humanos enviados.
5. Fijar datasets sintéticos y presupuestos verificables de carga/latencia/colas
   para Linux y cómo medir plataformas pendientes. No usar los 32–43 ms de una
   ejecución del spike como garantía de producción.
6. Revisar backlog: reparar un bloqueante de esta unidad si existe, diferir lo
   independiente con fase límite. Actualizar docs/ADR/estado y commit al cerrar.

**Aceptación:** decisiones sin contradicciones, ejemplos límite por cuenta/canal,
criterios de corte/rollback y mediciones reproducibles. Sin migrar datos ni mover
apps. Próxima entrega tras ello: contratos/frontera autenticada de Fase 1.

## Pendientes materiales

- Driver SQLite seleccionado y probado en Linux; falta validación Windows/Termux
  y adopción en repositorios runtime. La DB del brain no es el archivo operativo.
- F0.3 debe fijar identidad, retención propuesta de 90d y corte/rollback de datos.
- Historial previo completo no está garantizado por WA/Bot API.
- Validación real WA/TG y ejecución Windows/Termux siguen pendientes; usar cuenta
  de prueba y una única instancia. Conservar pendientes heredados de ROADMAP.

## Regla de cierre para la siguiente sesión

Actualizar este archivo y solo los checkboxes demostrados. El prompt estable de
[PROMPT-CONTINUIDAD.md](PROMPT-CONTINUIDAD.md) consulta este estado para retomar.
Hacer commit de la unidad probada e informar su hash. BUG-001 a BUG-014 siguen
abiertos; BUG-015 queda cerrado con el commit F0.2 identificado en su registro.
