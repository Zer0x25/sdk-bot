export type SystemComponent = 'gateway' | 'brain';

export interface SystemStatus {
  [key: string]: unknown;
}

export interface AdminCommandReply {
  type: string;
  text?: string;
  fileName?: string;
  caption?: string;
  base64?: string;
}

export interface AdminCommandResult {
  ok: boolean;
  replies: AdminCommandReply[];
}

export interface SystemActionResult {
  success: boolean;
  message: string;
}

export class SystemApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SystemApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestJson(pathname: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const timeoutSignal = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let invalidJson = false;

  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(`/api${pathname}`, {
      ...init,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...init.headers },
      signal: requestSignal
    });
    try { payload = await response.json(); }
    catch { invalidJson = true; throw new Error('Invalid JSON response'); }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SystemApiError(timeoutSignal.aborted ? 0 : invalidJson ? 502 : 0,
      timeoutSignal.aborted ? 'La solicitud tardó demasiado.' : invalidJson ? 'El servicio devolvió una respuesta inválida.' : 'No se pudo conectar con el sistema.');
  }

  if (!response.ok) {
    const message = response.status === 401 ? 'Tu sesión venció. Vuelve a iniciar sesión.'
      : response.status === 403 ? 'Se requiere permiso de administración para acceder al sistema.'
        : response.status === 404 ? 'La función solicitada no está disponible.'
          : 'No se pudo completar la operación del sistema.';
    throw new SystemApiError(response.status, message);
  }
  if (!isRecord(payload)) throw new SystemApiError(502, 'El servicio devolvió una respuesta inválida.');
  return payload;
}

function parseActionResult(payload: Record<string, unknown>): SystemActionResult {
  return {
    success: payload.success === true,
    message: typeof payload.message === 'string' ? payload.message : ''
  };
}

export async function getSystemStatus(signal?: AbortSignal): Promise<SystemStatus> {
  return requestJson('/status', {}, signal);
}

export async function sendAdminCommand(command: string): Promise<AdminCommandResult> {
  const payload = await requestJson('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command })
  });
  if (!Array.isArray(payload.replies)) throw new SystemApiError(502, 'El comando devolvió una respuesta inválida.');
  const replies = payload.replies.flatMap((reply): AdminCommandReply[] => {
    if (!isRecord(reply) || typeof reply.type !== 'string') return [];
    return [{
      type: reply.type,
      ...(typeof reply.text === 'string' ? { text: reply.text } : {}),
      ...(typeof reply.fileName === 'string' ? { fileName: reply.fileName } : {}),
      ...(typeof reply.caption === 'string' ? { caption: reply.caption } : {}),
      ...(typeof reply.base64 === 'string' ? { base64: reply.base64 } : {})
    }];
  });
  return { ok: payload.ok === true, replies };
}

export async function startBrain(): Promise<SystemActionResult> {
  return parseActionResult(await requestJson('/brain/start', { method: 'POST' }));
}

export async function clearSystemLogs(component: SystemComponent): Promise<SystemActionResult> {
  return parseActionResult(await requestJson(`/logs?component=${encodeURIComponent(component)}`, { method: 'DELETE' }));
}

async function postConfirmed(pathname: string, body: Record<string, unknown> = { confirm: true }): Promise<SystemActionResult> {
  return parseActionResult(await requestJson(pathname, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }));
}

export function resetWhatsAppSession() {
  return postConfirmed('/reset');
}

export function restartGateway() {
  return postConfirmed('/restart');
}

export function resetFactory() {
  return postConfirmed('/reset', { confirm: true, clean: true });
}
