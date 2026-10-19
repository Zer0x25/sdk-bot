# Captura base WhatsApp — F2B.2

Fecha: 2026-10-19. Unidad implementada y probada con transporte simulado y SQLite
real. La evidencia de este informe es histórica de F2B.2.
**F2B.3 ya completa el enriquecimiento multimedia** (BUG-033/034):
[MULTIMEDIA-WHATSAPP-F2B3](MULTIMEDIA-WHATSAPP-F2B3.md).
No hay bandeja nueva ni API de conversaciones/control humano todavía.

## Autoridad y recorrido

[ADR-006](adr/006-admision-durable-en-adapter.md) hace explícita la ampliación de
ADR-003 para esperar admisión durable antes de emitir al handler legacy.

`gateway/index.js` espera readiness y purga inicial antes de conectar canales.
Inyecta el archivo F2A en `WhatsappAdapter`; contactos/settings siguen en JSON.
El módulo `services/conversations/whatsappCapture.js` no importa Baileys, permisos,
STT, modelos ni HTTP. SQLite sigue exclusivamente dentro del worker existente.

1. El callback acepta observaciones únicamente del socket actual y recorre el
   lote completo. `messages.upsert` con `type=notify` es live; `append`/otros son
   historia conservadoramente. `messaging-history.set` entra como history.
2. Cuenta estable por `sock.user.id` del transporte autenticado: PN JID exacto,
   sin sufijo de dispositivo. Otra cuenta tiene otro namespace; reconectar la
   misma conserva UUID. Sin PN verificado se informa fallo y no se procesa el lote.
   No se leen tokens ni se usa el nombre, teléfono de settings o UUID aleatorio
   de arranque como identidad de cuenta.
3. Solo PN/LID individuales son archivo de cliente. Self-chat del PN/LID
   autenticado se clasifica administración y conserva comandos legacy fuera del
   archivo. Grupos/status/broadcast/newsletter y eventos sin cuerpo se excluyen.
4. `key.remoteJidAlt` del mensaje Baileys es evidencia de alias PN/LID de esa
   cuenta; nunca participant/nombre/coincidencias de dígitos. Historias ya
   independientes se conservan en cuarentena, sin mezclarlas.
5. La admisión conserva ID remoto nullable, fecha original en segundos UTC,
   dirección, origen y contenido normalizado. Fecha/ID/texto malformados generan
   degradación observable; no se inventa fecha o confirmación de entrega.
6. FIFO serial: registro de cuenta, alias comprobado, transacción de ingesta F2A,
   consulta de `requires_review`. Archivo/proyección/evento/huella se confirman
   antes de emitir al consumidor legacy. Permisos, pausa y handoff no filtran la
   captura; siguen evaluándose posteriormente en el handler existente.
7. Solo una entrada live nueva, sin revisión ni oversized, puede pasar al handler.
   Historia, duplicados, cuarentena y fromMe no disparan respuestas de cliente.
   El cache RAM recibe live/historia después de commit; no es autoridad durable.

Un eco propio individual se archiva aunque antes el filtro global lo habría
descartado. La correlación local volátil usa cuenta + chat + ID, caduca a 60 s y
se limita a 10000 claves; protege también self-chat. Un eco local conocido queda
`unknown`, sin inventar autoría ai/operator; otro fromMe live queda `external_self`
y el histórico `unknown`. La atribución durable y suspensión de IA por mensajes
desde el teléfono siguen en F5 con control/outbox. Telegram conserva BUG-009.

`requires_review` impide admitir nuevas respuestas desde esta captura y
`sendMessage` consulta la marca antes de llamar al transporte individual.
No es la barrera atómica de control F5: trabajos ya admitidos pueden seguir
generando y las rutas antiguas conservan BUG-006/008. No se creó un control
SQLite paralelo al JSON ni se ofrece toma humana desde el panel.

## Límites, fallos y ciclo de vida

- Cola de captura: 1000 observaciones o 32 MiB de JSON del mensaje crudo,
  incluyendo la observación activa. No almacena blobs/URLs/credenciales en SQLite.
  El presupuesto es de admisión serializada, no una medición del heap completo.
- Saturación rechaza los excedentes; no existe una segunda cola de espera sin
  límite ni confirmación durable ficticia. `capture_status` publica `degraded`,
  código y fecha en `channels.whatsapp.capture` del status existente; también log
  saneado. Queda visible hasta reiniciar. Es diagnóstico runtime, aún sin evento
  durable de hueco ni pantalla nueva. WA no garantiza redelivery: revisar ese
  intervalo, sin afirmar recuperación íntegra. Un nuevo intento tras drenar sí
  puede admitirse; las huellas evitan duplicar lo ya guardado.
- Error RPC detiene nuevas admisiones hasta reiniciar. Un timeout puede haber
  hecho commit: no se reintenta automáticamente. Tras reabrir, redelivery consulta
  las huellas; no vuelve a automatizar el mensaje cuyo resultado fue incierto.
- Mensaje sin ID remoto conserva calidad de deduplicación `unknown`: observaciones
  repetidas pueden crear IDs locales distintos. No se deduplica por texto/fecha.
- La normalización copia valores antes de encolarlos. El texto >64 KiB se pasa
  al worker para hash del original y marcador oversized; no se manda a IA.
- Todas las suscripciones WA verifican el socket capturado, incluidas credenciales,
  contactos, historia y presencia. STT revalida tras esperas para no emitir texto
  ni presencia desde una conexión reemplazada. Trabajo admitido mientras el socket
  era válido puede terminar su commit; no programa automatización si fue reemplazado.
- Una revisión de conexión descarta un `loadAuth` antiguo que termina después del
  más reciente (BUG-032). No se crea otro socket durante pairing activo.
- Shutdown/reset desconectan productores, drenan captura admitida (incluso si
  end del transporte lanza error), detienen purga
  y cierran el worker antes de salir/borrar. Se conservan las guardas F2B.1.
- Purga inicial y diaria, lotes SQL de 500, cediendo event loop entre llamadas.
  Reutiliza retención estricta 90/7/180 días del repositorio. Fallo inicial impide
  conectar canales; fallo diario se registra. Backups diarios y la invalidación
  del contexto derivado no están implementados; corresponden a F5/F8.

## Multimedia: alcance exacto de esta unidad

Audio/imagen/video/documento sin caption quedan como marcador base antes de STT,
incluso si está desactivado, falla o el socket se reemplaza. Mensajes no soportados
tienen marcador `unsupported`. Wrappers ephemeral/viewOnce/documentWithCaption
se reconocen para capturar contenido base; no se descargan adjuntos para el archivo.

**BUG-033 abierto, F2B.3:** STT legacy aún emite texto solo al handler; no actualiza
transcript/estado/evento del mensaje archivado. El marcador sigue `not_requested`,
por lo que aún no informa el resultado real de un intento. Debe resolverse antes
de cerrar F2B: mismo messageId, eventos de actualización y commit antes de IA;
fallo/purga/duplicado no recrean cuerpos ni cambian la huella del mensaje base.

**BUG-034 abierto, F2B.3:** una imagen/documento/video con caption se conserva como
texto; el contrato actual no permite caption junto al marcador multimedia.
Extender contrato/normalización con pruebas y refrescar dependencia gateway.
No afirmar captura multimedia completa hasta resolver ambas carencias.

## Validación

Copias temporales independientes sin .env, cuentas ni DB originales. Dependencias
instaladas enlazadas; manifiestos/contratos no cambiaron, no nuevo npm ci.

| Comprobación | Resultado |
|---|---|
| Gateway `npm run check`, Node 24.19.0 Linux | Lint/tipos y 204 tests pasan. |
| Gateway `npm run check`, mínimo Node 22.13.0 Linux | Lint/tipos y 204 tests pasan. |
| Docker Node 22.23.3, `--network none`, dependencias de producción | 52 tests de captura/archivo/entry/reset pasan. |

204 = 188 anteriores +15 de captura/retención +1 de integración del entry. No
son 204 recorridos E2E de conversaciones ni el benchmark completo de VALIDACION.
Docker reutiliza `sdkbot-f2a:local` con los archivos actuales y tests montados de
solo lectura, más profiles como Compose; no es una imagen nueva ni un despliegue.

Evidencia: captura de lotes y cache live, reinicio con mismos IDs/epoch/seq, exactitud
cuenta/chat, aliases verificados/conflicto, fuente history/append inerte, fromMe,
media base, oversized, identidad/fecha/texto malformados, STT tardío descartado,
reconexiones solapadas, resultado incierto tras commit y fallo cerrado.

La ráfaga de 1001 mensajes sobre SQLite real admite 1000, informa saturación y
conserva el restante al recibirlo otra vez. Un heartbeat sigue avanzando; no mide
presupuestos p95/p99 ni simula redelivery garantizado. Otro test limita 32 MiB con
archivo simulado. Entry real abre dos veces con Baileys sustituido, IA pausada,
puertos efímeros y SIGTERM 0; conserva tres mensajes/eventos y reconstruye cache.

Reproducción del adapter de `4bb4ec3` con dependencias falsas: lote de tres emite
uno; mensaje/presencia de socket viejo tienen efectos; auth antiguo sustituye la
conexión más nueva. Regresiones nuevas pasan. Cierra BUG-001/002/003/032; BUG-008
solo tiene aislamiento de archivo y BUG-009 se corrige para WA, Telegram pendiente.

Evidencia efímera: `/tmp/sdkbot-f2b2-uh19lsui` (checks Node, Docker, reproducción).
Brain/contratos no cambiaron: sus suites no se repitieron. Launcher global no se
repitió para conservar logs preexistentes; entry real sí se probó. Sin cuentas,
IA, OAuth reales, push ni despliegue. Windows/Termux y carga completa pendientes.
Cierre: commit local `git log --grep="close F2B.2"`.
