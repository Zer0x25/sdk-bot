// @ts-check
/**
 * 🛠️ Helpers de utilidad general y manipulación del DOM
 */

export const $ = s => document.querySelector(s);
export const $$ = s => document.querySelectorAll(s);

export function esc(s) {
  s = String(s ?? '');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const fmt = n => (n ?? 0).toLocaleString();

export const mem = n => Math.round((n || 0) / 1048576) + ' MB';

export const age = iso => {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  return mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h';
};

export const brainStateClass = st =>
  st === 'Running' ? 'running' : (st === 'Stopped' ? 'stopped' : (st === 'Idle' ? 'idle' : 'standby'));

/** Trunca textos largos añadiendo elipsis (…) en vez de cortar en seco */
export const trunc = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};

/** Separa "Groq (modelo)" en proveedor y modelo para la ficha Brain */
export function splitProvider(s) {
  if (!s || typeof s !== 'string') return { provider: '-', model: '-' };
  const m = s.match(/^(.*?)\s*\(([^)]*)\)$/);
  if (m) return { provider: m[1].trim() || '-', model: m[2].trim() || '-' };
  return { provider: s.trim(), model: '-' };
}

/** Estado genérico de conexión de canal, con motivo legible si lo hay */
export function channelState(conn) {
  const c = conn?.connection || 'starting';
  const r = conn?.lastDisconnectReason;
  if (c === 'open') return { label: 'Connected', cls: 'ok' };
  if (r === 'logged_out') return { label: 'Sesión revocada — revincular', cls: 'bad' };
  if (r === 'sin_sesion') return { label: 'Sin vincular', cls: 'warn' };
  if (r === 'token_invalido') return { label: 'Token inválido — reconfigurar', cls: 'bad' };
  if (c === 'reconnecting') return { label: 'Reconnecting', cls: 'warn' };
  return { label: 'Disconnected', cls: 'warn' };
}

/** Enmascara tokens sensibles */
export function maskToken(t) {
  if (!t || t.length < 10) return t;
  return t.substring(0, 5) + '...' + t.substring(t.length - 5);
}
