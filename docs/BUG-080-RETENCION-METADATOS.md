# BUG-080 — Retención de metadatos administrativos

## Política

| Registro | Retención | Motivo |
| --- | --- | --- |
| Recibos `control_operations` | `completed`/`failed`: 180 días desde `completed_at`; usa `created_at` si el cierre no quedó fechado. `taking_control` no vence. | Mantiene idempotencia y auditoría del takeover; un pendiente se recupera después de reiniciar. |
| Importación/corte | Indefinida para migraciones, ejecuciones, entradas, snapshots de conversación y snapshots de política. | Los datos sustentan auditoría y rollback; no hay ventana cerrada ni colector seguro de snapshots. |
| Cursores de lectura | Indefinida mientras exista la conversación. | El avance es monotónico y por actor; purgar la fila permitiría perder el watermark guardado. |
| Cuarentenas | Indefinida hasta revisión y limpieza explícitas. | No existe una API de resolución; `requires_review` no se puede retirar por vencimiento. |

La purga está acotada al límite de filas de cada lote y solo elimina recibos
terminales vencidos. No ejecuta exportación ni borrado por actor/conversación.
No crear una poda manual de snapshots o cuarentenas: primero hace falta un flujo
auditable que determine la resolución y garantice rollback/revisión.

## Checkpoint y recuperación

`recoveryCheckpoint()` cuenta y calcula una huella ordenada de cada ledger. El
gate `conversations:restore-check` exige igualdad de cuenta y huella para cada
uno y bloquea diferencias aunque el cursor de eventos no cambie. La salida
operativa muestra contadores y códigos acotados; no publica las huellas.

Los registros protegidos son:

- `control_operations`;
- `control_import_migrations`, `control_import_runs`, `control_import_entries`,
  `control_import_snapshots` y `control_policy_snapshots`;
- `read_cursors`;
- `quarantine`.

## Verificación

- `node --test tests/conversationRecovery.test.js` — 8/8; incluye límite estricto
  de 180 días, retención del takeover pendiente, preservación de ledgers antiguos
  y los cuatro bloqueos de restore sin hashes en la salida.
- `cd apps/gateway && npm run check` — lint y typecheck limpios, Panel 44/44,
  build Vite/servido 1/1 y Gateway 397/397.
- `git diff --check` — limpio.
- Solo se usan SQLite y archivos temporales; no se conectan canales ni se leen
  datos runtime de producción.
