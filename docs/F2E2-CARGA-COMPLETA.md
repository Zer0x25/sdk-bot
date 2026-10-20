# Carga completa del archivo de conversaciones — F2E.2

Fecha: 2026-10-20. El protocolo de [VALIDACION-V1](VALIDACION-V1.md) se ejecutó
con datos y proveedores sintéticos. El informe conserva muestras individuales,
errores, conteos, hashes del dataset y métricas por run:
[F2E2-load-report.json](evidence/F2E2-load-report.json).

## Dataset y persistencia

- Generador `v1-xorshift32`, seed `20261019`, namespace UUIDv5 del fixture.
- 5 cuentas, 2.000 contactos/conversaciones, 1.000.000 mensajes únicos y 50.000
  redeliveries. Los IDs de proveedor se repiten entre chats; 40 aliases JID/LID
  WA verificados se redeliveraron sin alta de filas, eventos ni cuarentenas.
- Importación: **3.152 mensajes únicos/s**. El snapshot quedó con 1.000.000 mensajes,
  50.000 eventos (secuencias 950.001–1.000.000), 40 aliases, integridad SQLite
  `ok` y cero violaciones FK. Las 50.000 redeliveries no avanzaron el cursor.
- En cada uno de los cinco runs se añadieron 2.700 mensajes live y el archivo
  conservó exactamente 50.000 eventos, con el watermark en `1.002.700`.
- La cola limitó 1.100 consultas simultáneas a 1.000 admitidas y 100 rechazadas;
  Telegram conservó cursor `null`, el total de mensajes no cambió y no apareció
  despacho pendiente. En la prueba de bytes, 669 solicitudes ocuparon 33.526.935
  bytes y 131 fueron rechazadas, bajo el límite de 32 MiB.

## Tres runs medidos

Cada run restauró el mismo snapshot, tomó 2.000 muestras por operación, recibió
1.200 mensajes a 10/s y 1.500 a 50/s. Los calentamientos quedan separados en el
JSON. Latencias en milisegundos, p95/p99 nearest-rank:

| Run | Lista 50 p95/p99 | Mensajes 50 p95/p99 | Ingesta steady p95/p99 | Ráfaga p95/p99 | Event loop p99 | RSS pico |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 2,55 / 5,87 | 2,48 / 5,87 | 5,87 / 12,48 | 1,91 / 6,01 | 10,90 | 280,3 MiB |
| 2 | 1,94 / 5,02 | 1,91 / 4,91 | 4,32 / 7,39 | 4,49 / 8,40 | 10,90 | 283,5 MiB |
| 3 | 1,96 / 5,40 | 1,87 / 5,25 | 5,45 / 10,72 | 1,96 / 5,23 | 10,86 | 284,2 MiB |

Los tres runs tuvieron cero errores/timeouts, pico de cola entre 3 elementos y
427–443 bytes, y completaron todas las muestras. La importación por lotes de 1.000
midió por separado p95 502,7 ms y p99 748,9 ms; esa cifra mide el commit del lote
completo, no el commit de una ingesta individual. Las ingestas live individuales
cumplieron p95 <100 ms y p99 <500 ms.

Los umbrales medidos para páginas, ingesta live, event loop, RSS e importación se
cumplieron en esta ejecución. El entorno fue Linux x64, Node 24.19.0, SQLite 3.53.3,
3 CPU lógicas y 10,45 GiB visibles; **no coincide** con el perfil de referencia de
2 CPU/4 GiB y el informe no lo presenta como aprobación de ese perfil. Repetir allí
antes de certificar rendimiento de producción.

## Alcance que queda para otras fases

- No existe todavía el servicio de takeover, así que `takeoverCommitMs` queda para
  F5. No se simuló como si fuera una operación real.
- La fuente DTO conserva la autoría sintética `customer/ai/operator`; el archivo
  actual persiste como `unknown` la autoría outbound de backfill. La atribución
  durable corresponde al outbox de F5.
- La prueba mide las páginas del archivo, no rutas HTTP autenticadas, SSE ni browser.
  F3 implementa esa frontera y debe devolver `resync.required` para un cursor
  anterior a la ventana retenida.

## Implementación y verificación

El generador emite cinco JSONL canónicos con DTOs v1 y hashes SHA-256. Archivos y DB
vivieron bajo un directorio temporal con limpieza posterior; no se abrió ningún
canal real ni se usaron credenciales o datos de usuario. La huella de los archivos
de implementación ejecutados se conserva dentro del informe junto al commit base.

`gateway npm run check`: lint, typecheck y 256 pruebas pasan. El generador también
se prueba con una muestra reducida; la importación por archivo demuestra que cuatro
redeliveries por JID/LID conservan seis mensajes y seis eventos.
