# Carga completa del archivo de conversaciones — F2E.2

Fecha de cierre: 2026-10-22. El protocolo de [VALIDACION-V1](VALIDACION-V1.md)
se ejecutó con dataset y proveedores sintéticos, sin canales conectados. El último
informe conserva las muestras, errores, conteos, hashes del dataset y métricas por
run: [F2E2-load-report-2cpu4g-20261022.json](../apps/gateway/docs/evidence/F2E2-load-report-2cpu4g-20261022.json).

## Perfil y persistencia

- Ejecución: Linux x64, Node 24.21.0, SQLite 3.53.4, bajo cgroup v2 temporal con
  `CPUQuota=200%`, `MemoryMax=4G` y `MemorySwapMax=0`. El host expuso 4 CPU lógicas
  y 15,0 GiB; los límites efectivos fueron exactamente 2 CPU y 4 GiB. El informe
  registra `profileMatch: true` y `source: cgroup-v2`. Esto valida el perfil
  limitado de Linux, no una máquina física de 2 CPU/4 GiB. Windows y Termux siguen
  sin esta ejecución.
- Generador `v1-xorshift32`, seed `20261019`, namespace UUIDv5 del fixture.
  Cinco cuentas, 2.000 contactos/conversaciones, 1.000.000 mensajes únicos y
  50.000 redeliveries. IDs de proveedor se repiten entre chats; 40 aliases JID/LID
  WA verificados se redeliveraron sin crear filas, eventos ni cuarentenas.
- Importación: **1.249 mensajes únicos/s** (objetivo >=1.000). Integridad SQLite
  `ok`, cero violaciones FK, 1.000.000 mensajes, 1.050.000 procedencias, 50.000
  eventos (secuencias 950.001–1.000.000), 40 aliases y cero cuarentenas/despachos
  pendientes. Las 50.000 redeliveries no avanzaron el cursor.
- El ensayo dejó el cgroup en `MemoryPeak=4 GiB` y `memory.events max=2230`; no hubo
  OOM ni procesos terminados (`oom=0`, `oom_kill=0`). El RSS de la aplicación,
  medido por separado, quedó bajo el límite de 512 MiB. El scope tocó el techo de
  memoria y el kernel recuperó páginas; esa presión queda registrada y no se
  presenta como margen libre de memoria del host.

## Tres runs medidos

Se ejecutaron dos calentamientos separados y tres runs medidos de 150 s. Cada run
tomó 2.000 muestras por página, 1.200 ingestas steady a 10/s y 1.500 ingestas de
ráfaga a 50/s. Latencias en milisegundos, p95/p99 nearest-rank:

| Run | Lista 50 p95/p99 | Mensajes 50 p95/p99 | Ingesta steady p95/p99 | Ráfaga p95/p99 | Event loop p99 | RSS pico | Errores |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 21,46 / 41,68 | 21,48 / 41,66 | 33,11 / 48,06 | 31,99 / 51,72 | 12,03 ms | 430,0 MiB | 0 |
| 2 | 6,77 / 20,01 | 6,62 / 20,84 | 15,81 / 19,05 | 31,06 / 44,99 | 11,40 ms | 405,0 MiB | 0 |
| 3 | 4,46 / 15,28 | 4,44 / 15,28 | 14,33 / 17,14 | 10,08 / 15,65 | 11,23 ms | 379,5 MiB | 0 |

Las tres mediciones cumplieron los presupuestos de lista (150/500 ms), página de
mensajes (100/300 ms), ingesta (100/500 ms), event loop p99 (20 ms) y RSS
(512 MiB). Los calentamientos también tuvieron cero errores y su mayor RSS fue
482,4 MiB. Los resultados distinguen muestras medidas de calentamientos y no
promedian percentiles.

## Saturación

- Cola por elementos: 1.100 consultas, 1.000 admitidas y 100 rechazadas. Se rechazó
  la captura Telegram durante saturación; el cursor siguió `null`, el total quedó
  en 1.000.000 mensajes y no apareció despacho pendiente. El pico fue 1.000
  elementos/31.000 bytes, bajo ambos límites.
- Cola por bytes: 800 solicitudes, 669 admitidas y 131 rechazadas; pico
  33.526.935 bytes, menor que 32 MiB (33.554.432). Ambas colas permanecieron dentro
  de los límites configurados.

## Alcance que queda para otras fases

- No existe todavía el servicio de takeover, así que `takeoverCommitMs` queda para
  F5. No se simuló como si fuera una operación real.
- La fuente DTO conserva la autoría sintética `customer/ai/operator`; el archivo
  actual persiste como `unknown` la autoría outbound de backfill. La atribución
  durable corresponde al outbox de F5.
- La prueba mide páginas del archivo, no rutas HTTP autenticadas, SSE ni browser.
  F3.1/F3.2 validan esa frontera y su resynchronization por separado; esta carga no
  hace afirmaciones de rendimiento HTTP, SSE o browser.
- El resultado certifica este perfil limitado en Linux x64 con Node 24.21.0. No
  representa rendimiento de proveedores externos ni garantiza otros runtimes,
  sistemas de archivos, plataformas o hardware.

## Implementación y verificación

El generador emite cinco JSONL canónicos con DTOs v1 y hashes SHA-256. Dataset,
snapshots y copias vivieron bajo `/var/tmp` con limpieza posterior; no se abrieron
canales reales ni se usaron credenciales o datos de usuario. La huella del código
ejecutado en el informe es `949c22f6f2396069a34f28b3e86306d548840bce`.
