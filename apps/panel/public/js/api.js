// @ts-check
/**
 * 📡 Capa de API HTTP centralizada para el panel
 */

export function getStatusToken() {
  return typeof window !== 'undefined' ? (window.localStorage?.getItem('sdkbot_status_token') || '') : '';
}

export function setStatusToken(token) {
  if (typeof window !== 'undefined') {
    if (token) window.localStorage?.setItem('sdkbot_status_token', token);
    else window.localStorage?.removeItem('sdkbot_status_token');
  }
}

function defaultHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getStatusToken();
  if (token) headers['X-Status-Token'] = token;
  return headers;
}

async function fetchJson(url, options = {}) {
  const opts = { ...options, headers: defaultHeaders(options.headers || {}) };
  const r = await fetch(url, opts);
  return r.json();
}

export async function getStatus() {
  return fetchJson('/api/status');
}

export async function sendCommand(command) {
  return fetchJson('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command })
  });
}

export async function startBrain() {
  return fetchJson('/api/brain/start', { method: 'POST' });
}

export async function getPairingStatus() {
  return fetchJson('/api/pairing/status');
}

export async function refreshQr() {
  return fetchJson('/api/qr/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
}

export async function requestPairingCode(phone) {
  return fetchJson('/api/pairing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone })
  });
}

export async function resetSession() {
  return fetchJson('/api/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true })
  });
}

export async function resetCleanFactory() {
  return fetchJson('/api/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true, clean: true })
  });
}

export async function getContacts({ q = '', estado = '', page = 1, limit = 50 }) {
  const url = `/api/contacts?q=${encodeURIComponent(q)}&estado=${encodeURIComponent(estado)}&page=${page}&limit=${limit}`;
  return fetchJson(url);
}

export async function setContactState(key, estado) {
  return fetchJson(`/api/contacts/${encodeURIComponent(key)}/estado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estado })
  });
}

export async function setContactProfile(key, perfil) {
  return fetchJson(`/api/contacts/${encodeURIComponent(key)}/perfil`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ perfil })
  });
}

export async function getProfiles() {
  return fetchJson('/api/profiles');
}

export async function getProfileDetail(key) {
  const r = await fetch(`/api/profiles/${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error('perfil no encontrado');
  return r.json();
}

export async function getProfileFile(key) {
  const r = await fetch(`/api/profiles/${encodeURIComponent(key)}/file`);
  if (!r.ok) throw new Error('perfil no encontrado');
  return r.json();
}

export async function reloadProfiles() {
  return fetchJson('/api/profiles/reload', { method: 'POST' });
}

export async function saveProfile(key, content) {
  return fetchJson('/api/profiles/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, content })
  });
}

export async function deleteProfile(key) {
  return fetchJson(`/api/profiles/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

export async function clearLogs(component) {
  const r = await fetch(`/api/logs?component=${encodeURIComponent(component)}`, {
    method: 'DELETE',
    headers: defaultHeaders()
  });
  return r.json().catch(() => ({}));
}

export async function getTelegramSettings() {
  const r = await fetch('/api/telegram/settings');
  if (!r.ok) throw new Error('Error al cargar configuración de Telegram');
  return r.json();
}

export async function testTelegramToken(token, chatId = '', idempotencyKey = '') {
  return fetchJson('/api/telegram/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, chatId, idempotencyKey })
  });
}

export async function saveTelegramSettings(token, chatId) {
  return fetchJson('/api/telegram/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, chatId })
  });
}
