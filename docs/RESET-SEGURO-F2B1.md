# F2B.1 — Parada segura antes del reset CLI

Fecha: 2026-10-19. Unidad previa a captura WhatsApp F2B. El archivo SQLite sigue
sin recibir tráfico de los adapters; F2B y F2 completa permanecen abiertas.

## Problema y resultado

`npm run clean` mataba el PID del gateway/brain y borraba el inventario aunque
systemd pudiera relanzarlo. Además, su detector buscaba la palabra `systemd`,
ausente en cgroups v2 como `/system.slice/sdk-bot-gateway.service`.

La nueva guarda revisa ambos propietarios antes de enviar señales. Si encuentra
un servicio en el cgroup, un contenedor identificable, un propietario incorrecto
o una inspección no verificable, aborta antes de borrar. No ejecuta systemctl ni
adivina nombres de unidades. `--yes` omite confirmaciones, nunca la guarda.

Para procesos manuales Linux comprueba la entrada ejecutada y el inicio del PID,
envía SIGTERM y espera hasta 5 s. Solo escala a SIGKILL después de volver a
comprobar identidad; espera hasta 1 s adicional. Si el proceso sigue vivo, aborta.
Un lock borrado no demuestra cierre: se consulta también el propietario original.
Una ventana final de 500 ms y una comprobación síncrona inmediatamente antes del
borrado detectan locks reemplazados y procesos aparecidos durante la parada.

El CLI informa el aborto con código 1, sin relanzar nada. Tras un reset correcto,
`--yes` sale con 0; el modo interactivo solo relanza instancias manuales que
estaban vivas y cuya parada se comprobó. Un PID huérfano no provoca un relanzamiento.

BUG-031, descubierto al revisar la misma frontera: brain ignoraba
`SDK_BRAIN_LOCK_PATH`. Ahora respeta esa ruta, crea su directorio padre y falla
al arrancar si no puede publicar el lock, en vez de aceptar trabajo invisible
para reset. Su cierre elimina únicamente el lock que todavía le pertenece.

## Uso operativo y límites

- Antes de un reset CLI, detener los supervisores y evitar arranques concurrentes
  de gateway/brain. Para systemd, detener las unidades reales con su gestor;
  para Docker, detener contenedores; para runit/PM2/tareas programadas, detener
  también el supervisor. Mantenerlos detenidos hasta terminar el borrado.
- Usar rutas absolutas y consistentes en productores y CLI. No ejecutar desde
  otro namespace de PID ni suponer que el lock de un volumen identifica un PID
  del host. Este cambio no añade un procedimiento de reset de volúmenes Docker.
- La detección de supervisión por cgroup es conservadora: un servicio ancestro
  también bloquea la parada automática. No es un detector universal de supervisores;
  algunos contenedores ocultan su cgroup. La espera de 500 ms no certifica que un
  supervisor externo esté detenido ni evita un lanzamiento concurrente posterior.
- En plataformas distintas de Linux, o con `/proc` restringido, una instancia
  viva impide la parada automática. Detenerla antes del CLI. Windows/Termux no
  ejecutados; no añadir un fallback que interprete fallo de inspección como ausencia.
- Esta unidad afecta al CLI factory reset. No cambia pairing, las rutas de reset
  del panel/self-chat, contratos, transporte, control humano ni salida IA.

## Evidencia reproducible

Checks en dos copias temporales de fuentes versionadas y archivos nuevos,
sin .env/credenciales/DB; dependencias instaladas enlazadas, manifiestos intactos.

| Comprobación | Resultado |
|---|---|
| gateway `npm run check`, Node 24.19.0 Linux | Lint/tipos y 188 tests pasan. |
| gateway `npm run check`, Node 22.13.0 Linux | Lint/tipos y 188 tests pasan. |
| brain `venv/bin/ruff check .` y `venv/bin/python -m pytest tests/ -q` | Sin hallazgos; 23 tests pasan, suite secuencial. |

Son 174 tests previos +14 de guarda/CLI en gateway, y 21 previos +2 de lock en
brain. No son pruebas de captura WA ni de conversaciones/control completos.
Una primera ejecución de ruff pidió ordenar imports del test nuevo; se corrigió
antes de la suite completa. BUG-014 permanece abierto: no paralelizar suites Python.

Las regresiones usan inventario temporal con canarios: supervisor falso que
relanza, rechazo antes de señales a cualquiera de los propietarios, aborto sin
borrado, reintento offline, sustitución/reutilización de PID, dueño aparecido,
lock desaparecido con proceso vivo, permisos/locks inválidos, SIGKILL y fallo de
parada. Cgroups systemd v1/v2, servicio de usuario y contenedores son fixtures.
Dos subprocesos ejecutan el CLI `--yes` real: aborto supervisado y reset offline,
verificando códigos de salida y conservación/borrado exacto del inventario.

Otro subproceso Linux abre el worker SQLite real, publica lock, espera SIGTERM,
cierra DB y sale 0 antes de borrar DB/WAL/SHM. Pasó la rama manual en este entorno,
sin iniciar canales. La prueba también admite la rama de rechazo si el host
ejecutor coloca al propio fixture bajo un servicio. El test de entry gateway
offline de F2A sigue pasando dentro de las suites completas.

La reproducción ejecuta `stopProcess` de `37525a1` dentro de un sandbox JS con
procesos/cgroup falsos: devuelve `detectedSystemd:false`, envía SIGTERM y deja
vivo el reemplazo del supervisor. No se ejecutó ningún servicio ni reset real.
Las pruebas nuevas del brain verifican la ruta configurada desde un hijo Python,
publicación/remoción del PID y aborto del arranque si el lock no puede escribirse.

Evidencia efímera: `/tmp/sdkbot-f2b1-llaak1dx` (logs Node 22/24, brain y reproducción).
No npm ci nuevo, cambios de contratos ni repetición de checks raíz/Docker/launcher;
sus dependencias/entradas no cambiaron. Logs globales previos conservados. Sin
cuentas/proveedores/OAuth reales, push ni despliegue. Cierre: commit local con
`git log --grep="close F2B.1"`.
