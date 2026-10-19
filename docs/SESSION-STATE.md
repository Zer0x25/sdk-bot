# Estado de continuidad — SDK-Bot

Actualización: 2026-10-19. Última unidad cerrada: **Fase 0 / F0.1**.

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
- No se modificó runtime ni se migraron datos. Todavía no hay bandeja nueva,
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

## Siguiente unidad exacta: Fase 0 / F0.2

**Entregable:** spike ejecutable y aislado de SQLite con worker y un informe de
compatibilidad que permita elegir el driver antes de incorporarlo al runtime.

1. Leer AGENTS, arquitectura, ADR-001 a 005, baseline y roadmap; revisar git status.
2. Preferir un script pequeño en gateway/scripts/ con DB creada exclusivamente en
   mkdtemp y limpieza/cierre explícitos. No agregar la DB operativa todavía.
3. Verificar node:sqlite en Node 22 usado por CI y establecer versión mínima
   comprobada; probar también runtime disponible. Registrar warnings/flags/API.
4. Verificar worker propietario, WAL, transacciones/rollback, unicidad, orden por
   cursor, errores, cierre/reapertura y backup/restauración consistente.
5. Documentar Linux observado y dejar Windows/Termux pendientes si no hay ejecutor;
   una lectura de compatibilidad no demuestra ejecución en esas plataformas.
6. Actualizar ADR-005 con resultado del driver y este estado con siguiente F0.3.

**Aceptación:** script reproducible sin transporte/red ni datos reales, pruebas de
persistencia/constraints/backup con temporales y decisión sustentada. No mover apps,
introducir paquetes de frontend ni migrar contactos/settings en esta unidad.

## Pendientes materiales

- Spike/driver SQLite todavía no ejecutado; no confundir la DB del brain con el
  futuro almacén de conversaciones del gateway.
- F0.3 debe fijar identidad, retención propuesta de 90d y corte/rollback de datos.
- Historial previo completo no está garantizado por WA/Bot API.
- Validación real WA/TG y ejecución Windows/Termux siguen pendientes; usar cuenta
  de prueba y una única instancia. Conservar pendientes heredados de ROADMAP.

## Regla de cierre para la siguiente sesión

Actualizar este archivo y solo los checkboxes demostrados. El prompt estable de
[PROMPT-CONTINUIDAD.md](PROMPT-CONTINUIDAD.md) consulta este estado para retomar.
