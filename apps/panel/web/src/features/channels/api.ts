import type { Contract } from '@sdk-bot/contracts';

type AccountStatus = Contract<'AccountStatus'>;

export interface PairingStatus {
  active: boolean;
  method: 'qr' | 'code' | null;
  busy: boolean;
  code: string | null;
  phone: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  expired: boolean;
}

export interface QrState {
  qr: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  expired: boolean;
  session: boolean;
}

export interface TelegramSettingsMeta {
  configured: boolean;
  chatIdConfigured: boolean;
}

export interface PairingResult {
  success: boolean;
  code: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  needsRestart: boolean;
}

export class ChannelsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ChannelsApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestJson(pathname: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });

  let response: Response;
  let payload: unknown;
  let invalidJson = false;
  try {
    response = await fetch(`/api${pathname}`, {
      ...init,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...init.headers },
      signal: controller.signal
    });
    try { payload = await response.json(); }
    catch { invalidJson = true; throw new Error('Invalid JSON response'); }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChannelsApiError(timedOut ? 0 : invalidJson ? 502 : 0,
      timedOut ? 'La solicitud tardó demasiado.' : invalidJson ? 'El servicio devolvió una respuesta inválida.' : 'No se pudo conectar con el servicio de canales.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }

  if (!response.ok) {
    const message = response.status === 401 ? 'Tu sesión venció. Vuelve a iniciar sesión.'
      : response.status === 403 ? 'Tu cuenta no tiene permiso para administrar canales.'
        : response.status === 429 ? 'Se alcanzó el límite de solicitudes de QR. Espera antes de volver a intentarlo.'
          : 'No se pudo completar la acción de canal.';
    throw new ChannelsApiError(response.status, message);
  }
  if (!isRecord(payload)) throw new ChannelsApiError(502, 'El servicio devolvió una respuesta inválida.');
  return payload;
}

function nullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function nullableString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

export async function getPairingStatus(signal?: AbortSignal): Promise<PairingStatus> {
  const value = await requestJson('/pairing/status', {}, signal);
  const method = value.method === 'qr' || value.method === 'code' ? value.method : null;
  return {
    active: value.active === true,
    method,
    busy: value.busy === true,
    code: nullableString(value.code),
    phone: nullableString(value.phone),
    issuedAt: nullableNumber(value.issuedAt),
    expiresAt: nullableNumber(value.expiresAt),
    expired: value.expired === true
  };
}

async function postPairing(pathname: string, body: unknown = {}): Promise<PairingResult> {
  const value = await requestJson(pathname, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return {
    success: value.success === true,
    code: nullableString(value.code),
    issuedAt: nullableNumber(value.issuedAt),
    expiresAt: nullableNumber(value.expiresAt),
    needsRestart: value.needsRestart === true
  };
}

export function refreshQr() {
  return postPairing('/qr/refresh');
}

export function requestPairingCode(phone: string) {
  return postPairing('/pairing', { phone });
}

export async function getTelegramSettingsMeta(signal?: AbortSignal): Promise<TelegramSettingsMeta> {
  const value = await requestJson('/telegram/settings/meta', {}, signal);
  return { configured: value.configured === true, chatIdConfigured: value.chatIdConfigured === true };
}

export async function saveTelegramSettings(token: string, chatId: string): Promise<boolean> {
  const value = await requestJson('/telegram/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, chatId })
  });
  return value.success === true;
}

export function accountStatusLabel(status: AccountStatus | undefined) {
  if (status === 'connected') return 'Conectado';
  if (status === 'connecting') return 'Conectando';
  if (status === 'requires_auth') return 'Requiere vinculación';
  if (status === 'error') return 'Error';
  if (status === 'disconnected') return 'Desconectado';
  return 'Sin cuenta registrada';
}
