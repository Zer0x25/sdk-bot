# SQLite con worker — resultado F0.2

Fecha: 2026-10-19. Estado: **experimento probado en Linux x64**.
Código: [sqlite-spike.js](../apps/gateway/scripts/sqlite-spike.js).
Decisión relacionada: [ADR-005](adr/005-plataforma-conversaciones.md).

## Decisión

Seleccionar `node:sqlite` / `DatabaseSync` para la implementación de los
repositorios de conversaciones, con un worker propietario y Node **22.13.0 o
posterior**. Se evita añadir un driver nativo externo. La API SQLite de Node 22
todavía emite ExperimentalWarning; queda aislada detrás de repositorios para
acotar el impacto de cambios de API.

El backup compatible con ese mínimo usa `VACUUM INTO`, ejecutado por el worker,
no la función `node:sqlite.backup`: esta última es undefined en Node 22.13.0.
El worker serializa la instantánea con las escrituras de su cola; no se mantiene
una transacción abierta esperando red. Las lecturas/escrituras del mismo worker
esperan durante esa operación, aunque el event loop principal siga libre.

El script no es un repositorio ni una migración de producción. Su schema reducido
demuestra propiedades del driver; no define todas las tablas/columnas de destino.
No se modificaron contactos, settings, credenciales ni memoria del brain.

## Compatibilidad observada

| Runtime | SQLite incorporado | Resultado sin flags SQLite |
|---|---|---|
| Node 22.12.0 / Linux x64 | No cargado | require('node:sqlite') falla con ERR_UNKNOWN_BUILTIN_MODULE. |
| Node 22.13.0 / Linux x64 | 3.47.2 | Las 10 comprobaciones pasan; ExperimentalWarning visible. |
| Node 22.23.3 / Linux x64 | 3.51.3 | Las 10 comprobaciones pasan; ExperimentalWarning visible. |
| Node 24.19.0 / Linux x64 | 3.53.3 | Las 10 comprobaciones pasan. |
| Windows | No ejecutado | Pendiente de ejecutor; no se declara compatibilidad probada. |
| Termux/Android | No ejecutado | Pendiente de comprobar build de Node, módulo incorporado y filesystem local. |

22.13.0 es el mínimo comprobado **sin flags**, no una afirmación de que versiones
anteriores carezcan del módulo con opciones experimentales. No se cambió la
versión efectiva de instalaciones del usuario ni el Dockerfile en esta unidad.
Antes del corte a SQLite, runtime y documentación operativa deben exigir el
mínimo; si una plataforma no lo ofrece, registrar alternativa con evidencia.

## Comprobaciones ejecutadas

1. Conexión abierta solo en un worker diferente del hilo principal; WAL, claves
   foráneas y versión de schema de fixture comprobados por consultas.
2. Texto con comillas/instrucciones SQL se conserva mediante parámetros; mensaje
   y evento se insertan en la misma transacción.
3. Duplicado en cuenta/chat rechaza; mismo ID de proveedor en otro chat, cuenta
   o canal sigue siendo válido. IDs TG negativos se conservan como texto.
4. Lote con segunda inserción inválida revierte también primera inserción/evento;
   evento con mensaje inexistente rechaza por clave foránea.
5. Paginación con cursor (occurred_at,id) estable con timestamps idénticos.
6. Veinte peticiones concurrentes se serializan sin perder escrituras/eventos.
7. Un lote de 5.000 mensajes permite atender timers del hilo principal.
8. Backup con commits en WAL activo, antes de cerrar/checkpoint; restauración
   desde el único archivo del backup y PRAGMA integrity_check = ok.
9. Escritura posterior no cambia el snapshot; cierre/reapertura conserva datos
   y permite seguir escribiendo.
10. Error de operación desconocida se propaga sin inutilizar el worker.

Además se ejecutó `--simulate-failure`: falla después de una escritura, conserva
la excepción original, cierra workers, borra temporales y termina con código 1.
Comprobado tanto con Node 22.13.0 como con Node 24.19.0. Esta prueba cierra
BUG-015 del [backlog](BACKLOG.md).

Cada petición al worker tiene un techo de 30 s; errores de arranque/salida
rechazan peticiones pendientes. El cleanup agrega errores en vez de reemplazar
la excepción original. DB, WAL, SHM y backups viven exclusivamente en mkdtemp y
se eliminan después de cerrar/terminar workers. No se añaden rutas de estado al
producto ni inventario de factory reset porque no hay persistencia runtime nueva.

## Ejecución y mediciones

Desde `apps/gateway/`:

```bash
npm run spike:sqlite
npm exec --yes --package=node@22.13.0 -- node scripts/sqlite-spike.js
npm exec --yes --package=node@22.23.3 -- node scripts/sqlite-spike.js
```

El propio experimento no usa red. npm exec puede descargar el runtime elegido.
No importa gateway/index, handlers, claves ni adapters. El resultado es JSON con
versiones, comprobaciones y eliminación de temporales; falla con exit distinto de 0.

Observación inicial del lote de 5.000, una ejecución por runtime:

| Node | Tiempo observado | Ticks de timer principal durante el lote |
|---|---|---|
| 22.13.0 | 43 ms | 29 |
| 22.23.3 | 33 ms | 25 |
| 24.19.0 | 32 ms | 25 |

Estos valores son mediciones locales sintéticas, no un SLO de producción. El
presupuesto de carga/latencia se fija en F0.3 con un protocolo repetible. No se
comprobó pérdida de energía, corrupción de disco, varios procesos escritores ni
un filesystem remoto; el diseño conserva propietario único y disco local.

## Checks de integración de esta unidad

- Lint y typecheck pasan con runtime actual.
- En copia temporal del repo: `npm run check` con Node 22.13.0 pasa lint, tipos
  y 143 pruebas; `npm run spike:sqlite` vuelve a pasar (lote: 44 ms).
- La copia excluye datos ignorados y enlaza solo node_modules. Log efímero:
  `/tmp/sdkbot-f02-check-e62nru85/gateway-minimum-check.log`.
- CI incorpora `npm run spike:sqlite` al job Node 22. Es configuración preparada;
  no se afirma haber ejecutado GitHub Actions ni se hizo push.
- No se repitió el smoke del launcher ni la suite del brain: no cambiaron sus
  módulos y la evidencia previa de F0.1 sigue separada en la baseline.

## Próximo paso

F0.3 fija identidad/aliases, permisos/control, retención y migración/rollback con
presupuestos de carga. Después se implementan contratos y repositorios reales.
El resto de bugs detectados no bloquea este experimento y mantiene su fase límite.
