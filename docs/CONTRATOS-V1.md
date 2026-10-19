# Base de contratos v1 — resultado F1A

Fecha: 2026-10-19. Estado: **implementada y probada en Linux x64**.
Seguimiento F1B: [FRONTERA-AUTENTICADA-V1](FRONTERA-AUTENTICADA-V1.md) incorpora
consumo runtime y sesión; lo que sigue describe la evidencia histórica de F1A.
Seguimiento F2B.3: caption opcional junto al tipo multimedia;
[MULTIMEDIA-WHATSAPP-F2B3](MULTIMEDIA-WHATSAPP-F2B3.md), 15 tests actuales.
Código y guía: [packages/contracts](../packages/contracts/README.md).
Norma: [SPEC-OPERATIVA-V1](SPEC-OPERATIVA-V1.md).

## Entrega

Workspace npm mínimo para `packages/*`, con lock raíz y paquete privado
`@sdk-bot/contracts`. Gateway permanece independiente,
con manifest/lock propios. Python y entradas actuales no se movieron. No hay
API v1 ejecutándose, DB de conversaciones ni UI nueva por añadir estos contratos.

JSON Schema 2020-12 es fuente canónica de 53 definiciones: cuentas/capacidades,
identidades/contactos, conversación/control, mensajes/marcadores, operaciones,
actor, errores, páginas, eventos y formatos. OpenAPI 3.1 referencia esos schemas,
incluso las propiedades de query. Tipos TS de operaciones/DTOs generados desde
las referencias con openapi-typescript; no hay DTO de servidor/cliente duplicado.

AJV valida sin coerción, defaults ni eliminación de campos. IDs internos UUID;
IDs Telegram conservan signo/precisión como texto. Versiones y secuencias también
textuales; expectedVersion usa controlVersion. Dedup wire requiere identidad
canónica; no acepta rawChatId. Los objetos son cerrados y null se declara.
Unicode válido, puntos de código y bytes UTF8 se comprueban en runtime con
TextEncoder estándar; sin depender del global Buffer de Node. BUG-018 se reprodujo
al retirar Buffer; la regresión pasa. No se probó bundle/navegador (F4). Los eventos
solo contienen invalidaciones/referencias, sin copiar mensajes ni adjuntos.

Los validadores son de forma. Alias verificados, permisos, barrera de envío,
consistencia entre recursos, época/ámbito de cursor, monotonicidad, versiones
vigentes e idempotencia necesitan repositorios/servicios futuros; no se implementó
un motor alternativo de políticas para hacer pasar ejemplos.

## Instalación y compatibilidad

- Raíz: `npm ci && npm run check` instala/verifica contratos; `npm run
  contracts:generate` actualiza el artefacto versionado.
- Gateway: `cd gateway && npm ci && npm run check` conserva instalación separada.
  Manifest/lock de gateway, Dockerfile, launchers y release-please no cambiaron.
- Se comprobó instalación gateway aun existiendo manifest/workspace padre.
  También un layout temporal con solo gateway/package*.json y `npm ci --omit=dev`,
  igual a la fase de dependencias del Dockerfile; resuelve Baileys/pino sin raíz.
  **No es un build/arranque de imagen Docker.**
- CI agrega job contratos en Node 22.13.0/24, con cache del lock raíz. Conserva
  job gateway con su lock/working-directory y job Python independiente.
  Configuración preparada; no se ejecutó GitHub Actions.
- Release-please sigue `simple` en raíz, CHANGELOG y manifest de versión existentes;
  no publica npm. Root sin versión de producto, paquetes privados. No hace falta
  agregar un release de biblioteca interna por crear el workspace.
- Gateway/panel aún no dependen del paquete. Antes del primer import runtime se
  debe integrar explícitamente resolución/copia/instalación en despliegues, sin
  depender de un symlink solo presente en desarrollo. Esa integración es puerta
  de la unidad que empiece a consumirlo.

## Pruebas y evidencia

Copia temporal de archivos versionados actuales + lista explícita de package.json,
package-lock.json y packages/contracts nuevos, sin copiar .env, sesiones ni DB.
Instalaciones nuevas tanto raíz como gateway; sin enlazar node_modules originales.
Directorio de evidencia efímera: `/tmp/sdkbot-f1a-b65nofug`; puede eliminarse.
No se iniciaron transportes ni se usaron claves/proveedores IA.

| Comando/entorno | Resultado |
|---|---|
| Raíz: npm ci, Node 24.19.0 / npm 11.9.0 | Instalación limpia, lock válido. |
| Raíz: npm run check, Node 24.19.0 | Tipos reproducibles, compilación TS 5.9.3 y 14 tests pasan. |
| Raíz: npm exec --yes --package=node@22.13.0 -- sh -c 'node --version && npm run check' | Mismos checks y 14 tests pasan en mínimo sin flags. |
| Gateway: npm ci && npm run check, Node 24.19.0 | Instalación limpia, lint, tipos y 143 tests pasan. |
| Gateway: npm run spike:sqlite, Node 24.19.0 | 10 comprobaciones pasan, temporales eliminados; experimento previo, no repositorio runtime. |
| Layout Docker de dependencias: npm ci --omit=dev | Dependencias producción resuelven sin workspace padre; no imagen construida. |
| Alterar generated.d.ts en copia, ejecutar check:generated | Rechaza deriva; código distinto de 0. |
| Reactivar defaultNonNullable=true en copia, generar y compilar | Reproduce BUG-017: rechaza DTO sin propiedades opcionales. Original restaurado. |

14 tests agrupan aceptación/rechazo de signo/precisión TG, tipos de identidad,
UUID/secuencias/fecha, límites Unicode/UTF8, paginación, entidades/nulls, formas de
control y selección pendiente, clave dedup canónica, eventos mínimos y errores sin
valores del input. Compilación TS prueba omisión de defaults y rechaza versión
numérica, actor en body y process_pending sin selección.

De los ejemplos F0.3 se ejecutan **TXT-01 a TXT-06 contra el validador real**; ID-01
a ID-07 se comprueban solo como formas wire de sus dos lados. No se declara que
el resolver fusione aliases ni que los otros 69 escenarios funcionales estén probados.
Los tests de forma de dedup/eventos tampoco prueban persistencia/replay.

BUG-017 y BUG-018 reparados y documentados en [BACKLOG](BACKLOG.md). BUG-008 tiene contratos
exactos, pero el runtime legacy conserva su defecto hasta F2/F5. BUG-010/013
mantienen puerta F1B. No cambiaron brain/STT ni scripts de arranque, por lo que no
se repitieron pytest ni smoke; su evidencia previa permanece en la baseline.
Windows/Termux y canales reales siguen pendientes. No se hizo push ni despliegue.

## Siguiente unidad

F1B: endpoint de sesión y actor firmado panel → gateway, autenticación/autorización,
expiración/método/ruta/hash y contexto local dev explícito, timeouts de frontera y
BUG-013 (/history brain). Integrar instalación del contrato si el runtime lo consume;
comprobar rutas anteriores y origen. Solo después F2 inicia captura/repositorios.
