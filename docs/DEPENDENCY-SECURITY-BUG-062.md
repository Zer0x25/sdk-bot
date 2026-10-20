# BUG-062 — Dependencias de medios transitivas

Actualización: 2026-10-20. Remediación local del gateway; Baileys y sus rangos
directos no cambian.

## Hallazgo y cambio

`npm audit --omit=dev` reportó advisories de disponibilidad en dependencias usadas
por el adapter Baileys: `sharp@0.35.3` tenía avisos high en libheif/librsvg y
`music-metadata@11.14.0` avisos moderate de bucles/crash al analizar medios. La
instalación de la nueva UI no los introdujo; estaban en el lockfile previo.

`npm audit fix` actualizó únicamente el lockfile dentro de los rangos existentes:
`sharp@0.35.5`, `music-metadata@11.16.1`, además de transitive packages cubiertos
por la auditoría. `gateway/package.json` y la versión `@whiskeysockets/baileys`
permanecen iguales.

## Aceptación

- `npm audit fix`: cero vulnerabilidades en el árbol completo.
- `npm audit --omit=dev`: cero vulnerabilidades de runtime.
- `npm ls sharp music-metadata --depth=5`: ambas versiones corregidas bajo Baileys.
- `gateway/npm run check`: lint, tipos, UI y suite completa.
- Docker Node 22 reconstruido con el BuildKit secret opcional para el CA del entorno;
  artefacto de UI y contratos presentes en runtime, Vite y CA ausentes.

No se cambia semántica de Baileys, transporte ni procesamiento de medios; los tests
existentes de multimedia y captura cubren los adapters después de actualizar el
lockfile.
