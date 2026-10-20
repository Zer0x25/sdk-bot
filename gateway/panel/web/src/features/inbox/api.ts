import type { Contract } from '@sdk-bot/contracts';

export type Account = Contract<'Account'>;
export type Channel = Contract<'Channel'>;
export type Conversation = Contract<'Conversation'>;
export type Lifecycle = Contract<'Lifecycle'>;
export type Message = Contract<'Message'>;
export type PageCursor = Contract<'PageCursor'>;
export type Sequence = Contract<'Sequence'>;
export type ConversationsResponse = Contract<'ConversationsResponse'>;
export type ConversationResponse = Contract<'ConversationResponse'>;
export type AccountsResponse = Contract<'AccountsResponse'>;
export type MessagesResponse = Contract<'MessagesResponse'>;
export type ReadResponse = Contract<'ReadResponse'>;

export class PanelApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'PanelApiError';
    this.status = status;
    this.code = code;
  }
}

interface ErrorPayload {
  error?: {
    code?: unknown;
  };
}

async function getJson<T>(pathname: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${pathname}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new PanelApiError(0, null, 'No se pudo conectar con el servicio de conversaciones.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PanelApiError(502, null, 'El servicio devolvió una respuesta inválida.');
  }

  if (!response.ok) {
    const payload = body as ErrorPayload;
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : null;
    if (response.status === 401) {
      throw new PanelApiError(401, code, 'Tu sesión venció. Vuelve a iniciar sesión.');
    }
    if (response.status === 403) {
      throw new PanelApiError(403, code, 'Tu cuenta no tiene permiso para leer estas conversaciones.');
    }
    if (response.status === 404) {
      throw new PanelApiError(404, code, 'No se encontró esta conversación.');
    }
    if (code === 'CURSOR_EXPIRED' || code === 'DATA_EPOCH_MISMATCH') {
      throw new PanelApiError(response.status, code, 'La bandeja cambió mientras se leía. Actualiza la lista.');
    }
    throw new PanelApiError(response.status, code, 'No se pudieron cargar las conversaciones. Inténtalo de nuevo.');
  }

  return body as T;
}

export function getAccounts(signal?: AbortSignal) {
  return getJson<AccountsResponse>('/accounts', signal);
}

export function getConversations(input: {
  cursor?: PageCursor;
  search?: string;
  unreadOnly?: boolean;
  lifecycle?: Lifecycle;
  channel?: Channel;
}, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '50' });
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.search) query.set('search', input.search);
  if (input.unreadOnly) query.set('unreadOnly', 'true');
  if (input.lifecycle) query.set('lifecycle', input.lifecycle);
  if (input.channel) query.set('channel', input.channel);
  return getJson<ConversationsResponse>(`/conversations?${query.toString()}`, signal);
}

export function getConversation(conversationId: string, signal?: AbortSignal) {
  return getJson<ConversationResponse>(`/conversations/${encodeURIComponent(conversationId)}`, signal);
}

export function getMessages(conversationId: string, input: { cursor?: PageCursor }, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '50' });
  if (input.cursor) query.set('cursor', input.cursor);
  return getJson<MessagesResponse>(`/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`, signal);
}

export async function markConversationRead(conversationId: string, throughInboundSeq: Sequence, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}/read`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ throughInboundSeq }),
      signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new PanelApiError(0, null, 'No se pudo actualizar el estado de lectura.');
  }

  let body: unknown;
  try { body = await response.json(); }
  catch { throw new PanelApiError(502, null, 'El servicio devolvió una respuesta inválida.'); }
  if (!response.ok) {
    const payload = body as ErrorPayload;
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : null;
    if (response.status === 401) throw new PanelApiError(401, code, 'Tu sesión venció. Vuelve a iniciar sesión.');
    if (response.status === 403) throw new PanelApiError(403, code, 'Tu cuenta no tiene permiso para actualizar la lectura.');
    throw new PanelApiError(response.status, code, 'No se pudo actualizar el estado de lectura.');
  }
  return body as ReadResponse;
}
