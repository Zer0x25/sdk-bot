import type { Contract } from '@sdk-bot/contracts';

export type AutomationProfilesResponse = Contract<'AutomationProfilesResponse'>;

export interface ProfileSummary {
  key: string;
  nombre: string;
  descripcion: string;
}

export interface ProfileFile {
  key: string;
  content: string;
  filename: string;
}

export interface CompiledProfile {
  key: string;
  nombre: string;
  descripcion: string;
  prompt: string;
}

export class AssistantApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AssistantApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestJson(pathname: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  let invalidJson = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });

  let response: Response;
  let payload: unknown;
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
    throw new AssistantApiError(timedOut ? 0 : invalidJson ? 502 : 0,
      timedOut ? 'La solicitud tardó demasiado.' : invalidJson ? 'El servicio devolvió una respuesta inválida.' : 'No se pudo conectar con el servicio de perfiles.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }

  if (!response.ok) {
    const message = response.status === 401 ? 'Tu sesión venció. Vuelve a iniciar sesión.'
      : response.status === 403 ? 'Se requiere permiso de administración para editar perfiles.'
        : response.status === 404 ? 'No se encontró el perfil seleccionado.'
          : response.status === 400 || response.status === 422 ? 'El brain rechazó el perfil. Revisa su clave y las secciones requeridas.'
            : 'No se pudo completar la operación de perfiles.';
    throw new AssistantApiError(response.status, message);
  }
  return payload;
}

export async function getEditableProfiles(signal?: AbortSignal): Promise<ProfileSummary[]> {
  const payload = await requestJson('/profiles', {}, signal);
  if (!isRecord(payload) || !Array.isArray(payload.profiles)) throw new AssistantApiError(502, 'La lista de perfiles tiene un formato inválido.');
  return payload.profiles.flatMap(item => {
    if (!isRecord(item) || typeof item.key !== 'string') return [];
    return [{
      key: item.key,
      nombre: typeof item.nombre === 'string' ? item.nombre : item.key,
      descripcion: typeof item.descripcion === 'string' ? item.descripcion : ''
    }];
  });
}

export async function getProfileFile(key: string, signal?: AbortSignal): Promise<ProfileFile> {
  const payload = await requestJson(`/profiles/${encodeURIComponent(key)}/file`, {}, signal);
  if (!isRecord(payload) || typeof payload.content !== 'string') throw new AssistantApiError(502, 'El archivo del perfil tiene un formato inválido.');
  return {
    key,
    content: payload.content,
    filename: typeof payload.filename === 'string' ? payload.filename : `${key}.md`
  };
}

export async function getCompiledProfile(key: string, signal?: AbortSignal): Promise<CompiledProfile> {
  const payload = await requestJson(`/profiles/${encodeURIComponent(key)}`, {}, signal);
  if (!isRecord(payload) || typeof payload.prompt !== 'string') throw new AssistantApiError(502, 'El prompt compilado tiene un formato inválido.');
  return {
    key,
    nombre: typeof payload.nombre === 'string' ? payload.nombre : key,
    descripcion: typeof payload.descripcion === 'string' ? payload.descripcion : '',
    prompt: payload.prompt
  };
}

export async function saveProfile(key: string, content: string) {
  const payload = await requestJson('/profiles/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, content })
  });
  if (!isRecord(payload) || payload.success !== true) throw new AssistantApiError(502, 'El perfil no quedó guardado.');
  return {
    key: typeof payload.key === 'string' ? payload.key : key,
    nombre: typeof payload.nombre === 'string' ? payload.nombre : key
  };
}

export async function reloadProfiles() {
  const payload = await requestJson('/profiles/reload', { method: 'POST' });
  if (!isRecord(payload) || payload.success === false) throw new AssistantApiError(502, 'No se pudieron recargar los perfiles del brain.');
  return true;
}

export async function deleteProfile(key: string) {
  const payload = await requestJson(`/profiles/${encodeURIComponent(key)}`, { method: 'DELETE' });
  if (!isRecord(payload) || payload.success !== true) throw new AssistantApiError(502, 'No se pudo eliminar el perfil.');
  return true;
}
