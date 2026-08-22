# 🗺️ Hoja de Ruta SDK-Bot (Guía de Sesiones)

> Documento vivo. Cada sesión se elige una fase, se trabaja por tareas checkbox, se verifica arrancando brain + gateway, y se commitea con mensaje descriptivo (`feat:` / `fix:` / `refactor:` / `docs:`).

---

## 🚀 Logros Recientes (Fases Completadas)

Las fases pasadas (1 a 7) que incluyeron la corrección de de-bounce de mensajes, resiliencia de desconexión, panel de administración inicial y reset limpio, han sido **completadas**. Su registro queda en el historial del repositorio.

El hito más reciente fue la transición hacia la arquitectura **Adapter Hub**, permitiendo desacoplar a Baileys del código núcleo e introducir a Telegram como canal primario oficial, actualizando en paralelo el Webpanel para soporte Multi-Canal (Fase 8 implícita).

---

## 📋 Resumen del Diagnóstico (Estado Actual)

### Deuda técnica / refactor pendientes
- **R1. Optimización en storage:** `bulkUpsertContactsMetadata` es ineficiente con +5000 contactos. Necesita índices estables (Map phone→key, Map lid→key) para evitar búsquedas O(n).
- **R2. Seguridad del Panel Web:** Falta implementar el token opcional `STATUS_TOKEN` para operaciones de escritura en el API del dashboard y validación de CORS estricta.
- **R3. Verificación en Vivo del Wipe Total:** Validar completamente `npm run clean` en vivo con un teléfono secundario para confirmar el comportamiento post-reset con la agenda.

---

## 🟢 Fase 9 — Consolidación Multi-Canal y Seguridad

Objetivo: Refinar la resiliencia del sistema de adaptadores múltiples y blindar el Webpanel.

- [ ] **Seguridad del Panel** — Token opcional `STATUS_TOKEN` para escrituras (header `X-Status-Token`) + validación de `Origin`; acceso remoto seguro documentado vía Tailscale / túnel SSH.
- [ ] **Caché y RAM Optimizada** — Aplicar índices incrementales `Map` en la DB de contactos para reducir los picos de memoria durante el sync del historial de WhatsApp.
- [ ] **Sincronización Completa de Contactos** — Cola por chunks + índices incrementales. Requiere re-vincular (QR fresco) para confirmar que la agenda baja completa sin saturar RAM.
- [ ] **Reconexión con Backoff en medio del diálogo** — Validar en vivo el comportamiento cuando el teléfono del bot se queda sin internet en mitad de un procesamiento de IA y cómo se maneja el reenvío de mensajes (pendientes de la antigua Fase 1).

---

## 🧭 Cómo avanza cada sesión (metodología)

1. **Abrir la sesión leyendo `ROADMAP.md` + `AGENTS.md`** (siempre están actualizados al commit más reciente).
2. **Elegir la fase activa** (la primera con checkboxes pendientes). Trabajar de arriba hacia abajo dentro de la fase.
3. **Por cada tarea:**
   - Arrancar brain + gateway y reproducir el bug antes de tocar código (evidencia en logs).
   - Implementar con el estilo del repo (español, comentarios solo cuando aportan, módulos pequeños).
   - Verificar el fix en caliente y con la prueba de humo de la fase.
4. **Commit con prefijo semántico:** `fix:`, `refactor:`, `docs:`, `feat:`.
5. **Al terminar la fase:** marcar todos los checkboxes, actualizar la fecha en el header, y escribir en AGENTS.md cualquier gotcha nuevo descubierto.
6. **Al empezar la siguiente fase:** nuevo conjunto de checkboxes y sesión dedicada.

## 🔥 Orden recomendado de ataque para la PRÓXIMA sesión

> Prioridad actual: **Fase 9 (Consolidación Multi-Canal y Seguridad)**. Empezar con la seguridad del panel web (`STATUS_TOKEN`), para luego seguir con la optimización de los índices en RAM para libretas grandes.
