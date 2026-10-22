# Contratos v1 — F1A

Base wire para la futura bandeja. No inicia servicios, canales, SQLite ni llamadas
IA. F1B implementa GET /api/v1/session; los demás endpoints siguen pendientes.

Desde la raíz del repo (Node >=22.13.0):

```bash
npm ci
npm run check
npm run contracts:generate
```

El workspace raíz contiene `packages/*`. Gateway sigue siendo paquete independiente:
`cd apps/gateway && npm ci && npm run check`. Desde F1B consume el paquete como
`file:../packages/contracts`; gateway/.npmrc usa install-links=true para empaquetarlo
con sus dependencias, sin symlink ni instalación raíz en producción. Docker copia
el paquete antes de npm ci. Tras cambiar fuente/tipos de contracts, repetir npm ci
en gateway: la copia instalada no se actualiza sola. CI instala desde checkout;
launchers comprueban ausencia/cambios de index/schema. Python mantiene requirements.
No se movieron aplicaciones. Release-please sigue usando `simple` en raíz y
CHANGELOG, sin publicar paquetes npm; ambos manifests nuevos son privados y el
workspace raíz no tiene versión de producto.

## Fuente y consumo

- [schema.json](schema.json): JSON Schema 2020-12 canónico, 53 definiciones,
  objetos cerrados, null explícito y formatos. No editar tipos para cambiar DTOs.
- [openapi.json](openapi.json): OpenAPI 3.1 público `/api/v1`, referencias locales
  a esos schemas incluso para propiedades de query; no duplica campos de DTO.
  El panel futuro traduce a `/v1` interna con actor firmado (F1B).
- [generated.d.ts](generated.d.ts): tipos reproducibles de servidor/cliente,
  rutas y operaciones generados con openapi-typescript; `--check` detecta deriva.
- [index.js](index.js) / [index.d.ts](index.d.ts): validación AJV y API tipada común.

```typescript
import { validate, assertValid, type Contract } from '@sdk-bot/contracts';
const result = validate('TakeoverRequest', inputDesconocido);
if (result.valid) {
  const version: string = result.value.expectedVersion;
}
const id = assertValid('TelegramChatId', '-9007199254740993');
type Message = Contract<'Message'>;
```

`validate` devuelve `{valid:true,value}` o `{valid:false,errors}`; `assertValid`
devuelve el valor o lanza TypeError con issues saneadas. Contrato desconocido falla.
No convierte tipos, aplica defaults, elimina campos ni muta entradas. Error de
validación no copia valores del input. El controlador debe convertir esos issues
en ErrorResponse acotado y asignar requestId; no devolver excepciones crudas.

TypeScript comprueba estructura; formatos UUID, signo, longitud, bytes y campos
extra en datos externos requieren validar runtime. `unicode-text` rechaza surrogates
sueltos; maxLength cuenta puntos de código y `x-maxUtf8Bytes` limita bytes UTF-8.
Otros validadores deben implementar ambos, no ignorar las extensiones. No se
normaliza el texto ni se transforma en comando/Markdown. Los defaults son
anotaciones de comportamiento futuro, no propiedades obligatorias en la entrada.

IDs UUID canónicos en minúsculas; secuencias/versiones como decimal textual.
expectedVersion corresponde a controlVersion; aggregateVersion solo proyección.
La clave de dedup exige accountId/canonicalIdentityId/providerMessageId. La falta
de ID remoto se expresa en Message con null y calidad unknown, nunca clave falsa.
Kind wire `telegram_chat_id` corresponde al `telegram_chat` de ejemplos F0.3.

Query DTO describe el objeto **ya decodificado**: limit entero, unreadOnly booleano,
IDs siempre texto. Controlador F3 validará parámetros duplicados/desconocidos y
codificación, aplicará default 50 y comprobará ámbito/epoch/filtros del cursor.
Forma base64url no demuestra autorización del cursor. SSE usa id `dataEpoch:seq`,
event = Event.type y data = JSON Event; el servicio F3 debe comprobar coherencia
entre campos. El contenido es invalidación mínima; el cliente relee el recurso.

## Qué queda pendiente

La semántica sigue en [SPEC-OPERATIVA-V1](../../docs/SPEC-OPERATIVA-V1.md).
Sesión/frontera F1B: [FRONTERA-AUTENTICADA-V1](../../docs/FRONTERA-AUTENTICADA-V1.md).
Validar una forma no acredita sesión, capacidades, propietario, cancelación,
control confirmado, unicidad durable, alias verificado, idempotencia, monotonicidad,
retención ni entrega. Se implementarán/probarán en F1B/F2/F3/F5, sin un segundo motor
de políticas en este paquete. Un DTO válido no es autorización para enviar.

14 tests verifican referencias OpenAPI, formatos, precisión/signo, Unicode/UTF8,
páginas, nulls, formas de control, dedup y eventos sin cuerpos. Se ejecutan los
seis TXT de F0.3 y se validan las formas de ID, sin afirmar resolución de alias.
La compilación incluye casos positivos/negativos y regresión de defaults opcionales.
CI prepara ejecutarlos en Node 22.13.0/24; Windows/Termux siguen pendientes.
Evidencia local en [CONTRATOS-V1](../../docs/CONTRATOS-V1.md).

F2B.3 amplía MessageContent multimedia con caption opcional (StoredText), sin
invalidar marcadores previos. Tipos regenerados y dependencia gateway refrescada.
Semántica durable y límites: [multimedia WA](../../docs/MULTIMEDIA-WHATSAPP-F2B3.md).
