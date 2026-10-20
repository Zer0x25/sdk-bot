import type { Contract } from '@sdk-bot/contracts';

export type Account = Contract<'Account'>;
export type Actor = Contract<'Actor'>;
export type Channel = Contract<'Channel'>;
export type ConversationControl = Contract<'ConversationControl'>;
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
export type SessionResponse = Contract<'SessionResponse'>;
export type Operation = Contract<'Operation'>;
export type SendMessageResponse = Contract<'SendMessageResponse'>;
export type SendMessageRequest = Contract<'SendMessageRequest'>;

export type ControlResponse = Contract<'TakeoverConfirmedResponse'> | Contract<'TakeoverPendingResponse'>;

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
    message?: unknown;
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

async function postJson<T>(pathname: string, body: unknown, idempotencyKey?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${pathname}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new PanelApiError(0, null, 'No se pudo conectar con el servicio de conversaciones.');
  }

  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new PanelApiError(502, null, 'El servicio devolvió una respuesta inválida.'); }
  if (!response.ok) {
    const error = (payload as ErrorPayload)?.error;
    const code = typeof error?.code === 'string' ? error.code : null;
    const message = typeof error?.message === 'string'
      ? error.message
      : response.status === 401 ? 'Tu sesión venció. Vuelve a iniciar sesión.'
        : response.status === 403 ? 'Tu cuenta no tiene permiso para realizar esta acción.'
          : code === 'OUTBOUND_DELIVERY_UNKNOWN'
            ? 'El proveedor pudo haber recibido el mensaje. Revisa el chat antes de volver a enviarlo.'
            : code === 'CONTROL_OWNER_CONFLICT' ? 'La conversación pertenece a otro operador.'
              : code === 'CONTROL_VERSION_CONFLICT' ? 'El control cambió. Actualiza el chat e inténtalo de nuevo.'
                : code === 'CHANNEL_NOT_READY' ? 'El canal no está conectado. Conservamos el borrador.'
                  : 'No se pudo completar la acción. Conservamos el borrador.';
    throw new PanelApiError(response.status, code, message);
  }
  return payload as T;
}

export function getSession(signal?: AbortSignal) {
  return getJson<SessionResponse>('/session', signal);
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

export function getOperation(operationId: string, signal?: AbortSignal) {
  return getJson<Operation>(`/operations/${encodeURIComponent(operationId)}`, signal);
}

export function takeoverConversation(conversationId: string, expectedVersion: ConversationControl['controlVersion'], overrideOwner = false) {
  return postJson<ControlResponse>(`/conversations/${encodeURIComponent(conversationId)}/takeover`, {
    expectedVersion,
    ...(overrideOwner ? { overrideOwner: true } : {})
  }, `panel_takeover_${crypto.randomUUID()}`);
}

export function releaseConversation(conversationId: string, expectedVersion: ConversationControl['controlVersion'], overrideOwner = false) {
  return postJson<ControlResponse>(`/conversations/${encodeURIComponent(conversationId)}/release`, {
    expectedVersion,
    ...(overrideOwner ? { overrideOwner: true } : {}),
    resumePolicy: 'future_only'
  }, `panel_release_${crypto.randomUUID()}`);
}

export function updateConversationLifecycle(conversationId: string, expectedVersion: ConversationControl['controlVersion'], lifecycle: Lifecycle) {
  return fetchConversationUpdate<ControlResponse>(conversationId, { expectedVersion, lifecycle }, `panel_lifecycle_${crypto.randomUUID()}`);
}

async function fetchConversationUpdate<T>(conversationId: string, body: unknown, idempotencyKey: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new PanelApiError(0, null, 'No se pudo conectar con el servicio de conversaciones.');
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new PanelApiError(502, null, 'El servicio devolvió una respuesta inválida.'); }
  if (!response.ok) {
    const code = typeof (payload as ErrorPayload)?.error?.code === 'string' ? (payload as ErrorPayload).error!.code as string : null;
    throw new PanelApiError(response.status, code, response.status === 403
      ? 'Tu cuenta no tiene permiso para cambiar el estado de la conversación.'
      : code === 'CONTROL_VERSION_CONFLICT' ? 'La conversación cambió. Actualízala e inténtalo de nuevo.'
        : 'No se pudo cambiar el estado de la conversación.');
  }
  return payload as T;
}

export function sendConversationMessage(conversationId: string, request: SendMessageRequest) {
  return postJson<SendMessageResponse>(`/conversations/${encodeURIComponent(conversationId)}/messages`, request);
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
