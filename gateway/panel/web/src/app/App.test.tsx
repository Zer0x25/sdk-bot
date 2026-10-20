import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Contract } from '@sdk-bot/contracts';
import App, { createAppQueryClient } from './App';

type Account = Contract<'Account'>;
type Conversation = Contract<'Conversation'>;
type Message = Contract<'Message'>;

const accountId = '33333333-3333-4333-8333-333333333333';
const conversationId = '11111111-1111-4111-8111-111111111111';
const contactId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-10-20T12:00:00.000Z';
const snapshot = { dataEpoch: '44444444-4444-4444-8444-444444444444', seq: '2' };
const capabilities = { attachments: true, deliveryReceipt: true, edit: true, historySync: true, readReceipt: true, reply: true };

const account: Account = {
  id: accountId,
  channel: 'whatsapp',
  displayName: 'Cuenta privada',
  status: 'connected',
  capabilities
};

const conversation: Conversation = {
  id: conversationId,
  accountId,
  contactId,
  canonicalIdentityId: contactId,
  aggregateVersion: '2',
  control: {
    accessPolicy: 'allowed',
    automationMode: 'ai',
    contextVersion: '1',
    controlVersion: '1',
    handoffReason: null,
    lifecycle: 'open',
    ownerId: null,
    status: 'confirmed',
    takenAt: null
  },
  displayName: 'Ana Pérez',
  historyCoverage: { kind: 'capturing_since', capturingSince: timestamp },
  lastActivityAt: timestamp,
  requiresReview: false,
  unreadCount: 2
};

const secondConversation: Conversation = {
  ...conversation,
  id: '77777777-7777-4777-8777-777777777777',
  contactId: '88888888-8888-4888-8888-888888888888',
  canonicalIdentityId: '88888888-8888-4888-8888-888888888888',
  displayName: 'Lucía Ruiz',
  unreadCount: 0
};

function message(id: string, text: string, occurredAt: string): Message {
  return {
    id,
    conversationId,
    actorId: null,
    authorKind: 'customer',
    clientMessageId: null,
    content: { type: 'text', text },
    deduplicationQuality: 'provider_id',
    deliveryStatus: 'received',
    direction: 'inbound',
    inboundSeq: '1',
    ingestedAt: occurredAt,
    occurredAt,
    providerMessageId: 'private-provider-id-must-not-render',
    replyToId: null,
    source: 'live'
  };
}

const latestMessage = message('55555555-5555-4555-8555-555555555555', '¿En qué puedo ayudarte?', timestamp);
const olderMessage = message('66666666-6666-4666-8666-666666666666', 'Hola, tengo una pregunta.', '2026-10-20T11:00:00.000Z');

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function installApiMock(options: { empty?: boolean; listError?: boolean; pagination?: boolean; listPagination?: boolean; cursorExpired?: boolean; media?: boolean } = {}) {
  let markedRead = false;
  const projectedConversation = () => markedRead ? { ...conversation, unreadCount: 0 } : conversation;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input), 'http://panel.local');
    if (url.pathname === '/api/v1/accounts') return jsonResponse({ items: [account] });
    if (url.pathname === '/api/v1/conversations') {
      if (options.listError) return jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
      if (options.cursorExpired && url.searchParams.has('cursor')) {
        return jsonResponse({ error: { code: 'CURSOR_EXPIRED', message: 'La bandeja cambió.', requestId: contactId } }, 410);
      }
      if (options.listPagination && url.searchParams.has('cursor')) {
        return jsonResponse({ items: [secondConversation], nextCursor: null, snapshot });
      }
      return jsonResponse({
        items: options.empty ? [] : [projectedConversation()],
        nextCursor: options.listPagination ? 'opaque-conversation-cursor' : options.cursorExpired ? 'expired-conversation-cursor' : null,
        snapshot
      });
    }
    if (url.pathname === `/api/v1/conversations/${conversationId}/read`) {
      markedRead = true;
      return jsonResponse({ throughInboundSeq: '1' });
    }
    if (url.pathname === `/api/v1/conversations/${conversationId}`) {
      return jsonResponse({ conversation: projectedConversation(), channelCapabilities: capabilities, snapshot });
    }
    if (url.pathname === `/api/v1/conversations/${conversationId}/messages`) {
      if (options.pagination && url.searchParams.has('cursor')) {
        return jsonResponse({ items: [olderMessage], nextCursor: null, snapshot });
      }
      if (options.media) {
        return jsonResponse({
          items: [{ ...latestMessage, content: { type: 'audio', availability: 'not_stored', transcriptionStatus: 'pending', transcript: null } }],
          nextCursor: null,
          snapshot
        });
      }
      return jsonResponse({
        items: [latestMessage],
        nextCursor: options.pagination ? 'opaque-older-page-cursor' : null,
        snapshot
      });
    }
    return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const liveMessage = {
  ...message('99999999-9999-4999-8999-999999999999', 'Mensaje nuevo en vivo', '2026-10-20T12:01:00.000Z'),
  inboundSeq: '2'
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const entries = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener);
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  disconnect() {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }

  dispatch(type: string, data: unknown, lastEventId: string) {
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId });
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  close() { this.readyState = 2; }
}

function installEventSourceMock() {
  FakeEventSource.instances.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  return FakeEventSource.instances;
}

function streamEvent(type: string, data: Record<string, unknown>, seq: string) {
  return {
    schemaVersion: 1,
    cursor: { dataEpoch: snapshot.dataEpoch, seq },
    type,
    occurredAt: timestamp,
    data
  };
}

function renderApp(path = '/inbox/') {
  window.history.replaceState({}, '', path);
  return render(<App queryClient={createAppQueryClient()} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances.length = 0;
  window.history.replaceState({}, '', '/inbox/');
});

describe('inbox shell and real API integration', () => {
  it('loads a real conversation, opens its URL and renders authorized history without provider IDs', async () => {
    const fetchMock = installApiMock();
    const user = userEvent.setup();
    renderApp();

    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
    const conversationLink = await screen.findByRole('link', { name: /Ana Pérez, WhatsApp, 2 sin leer/ });
    expect(conversationLink).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No leídas' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(conversationLink);
    expect(await screen.findByText('¿En qué puedo ayudarte?')).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/inbox/${conversationId}`);
    expect(screen.getAllByText('Ana Pérez').length).toBeGreaterThan(0);
    expect(screen.getByText('Conectado')).toBeInTheDocument();
    expect(screen.getByText(/Captura observada desde/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private-provider-id-must-not-render');
    expect(fetchMock.mock.calls.some(([, init]) => init?.credentials === 'same-origin')).toBe(true);
    await waitFor(() => {
      const readRequest = fetchMock.mock.calls.find(([input]) => new URL(String(input), 'http://panel.local').pathname.endsWith('/read'));
      expect(readRequest?.[1]?.method).toBe('POST');
      expect(JSON.parse(String(readRequest?.[1]?.body)).throughInboundSeq).toBe('1');
      expect(document.querySelector('.unread-count')).toBeNull();
    });
  });

  it('sends unread and contact search filters to the API', async () => {
    const fetchMock = installApiMock();
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('button', { name: 'No leídas' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), 'http://panel.local').searchParams.get('unreadOnly') === 'true')).toBe(true);
    });

    await user.type(screen.getByRole('searchbox', { name: 'Buscar conversaciones por contacto' }), 'Ana');
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), 'http://panel.local').searchParams.get('search') === 'Ana')).toBe(true);
    }, { timeout: 2000 });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Canal' }), 'telegram');
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), 'http://panel.local').searchParams.get('channel') === 'telegram')).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: 'Abiertas' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), 'http://panel.local').searchParams.get('lifecycle') === 'open')).toBe(true);
    });
  });

  it('paginates the conversation list with the server cursor', async () => {
    const fetchMock = installApiMock({ listPagination: true });
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole('link', { name: /Ana Pérez/ });
    await user.click(screen.getByRole('button', { name: 'Cargar más conversaciones' }));
    expect(await screen.findByRole('link', { name: /Lucía Ruiz/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), 'http://panel.local').searchParams.get('cursor') === 'opaque-conversation-cursor')).toBe(true);
  });

  it('reloads the first page when a list cursor expires', async () => {
    const fetchMock = installApiMock({ cursorExpired: true });
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole('link', { name: /Ana Pérez/ });
    await user.click(screen.getByRole('button', { name: 'Cargar más conversaciones' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La bandeja cambió mientras se leía');
    await user.click(screen.getByRole('button', { name: 'Actualizar lista' }));
    await waitFor(() => {
      const firstPageRequests = fetchMock.mock.calls.filter(([input]) => {
        const url = new URL(String(input), 'http://panel.local');
        return url.pathname === '/api/v1/conversations' && !url.searchParams.has('cursor');
      });
      expect(firstPageRequests.length).toBeGreaterThan(1);
    });
  });

  it('loads older pages in chronological order and preserves the selected chat', async () => {
    const fetchMock = installApiMock({ pagination: true });
    const user = userEvent.setup();
    renderApp(`/inbox/${conversationId}`);

    await screen.findByText('¿En qué puedo ayudarte?');
    await user.click(screen.getByRole('button', { name: 'Cargar mensajes anteriores' }));
    const log = await screen.findByRole('log', { name: 'Mensajes del chat' });
    await within(log).findByText('Hola, tengo una pregunta.');
    const text = log.textContent || '';
    expect(text.indexOf('Hola, tengo una pregunta.')).toBeLessThan(text.indexOf('¿En qué puedo ayudarte?'));
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), 'http://panel.local').searchParams.get('cursor') === 'opaque-older-page-cursor')).toBe(true);
  });

  it('renders a safe media marker when the underlying attachment is not stored', async () => {
    installApiMock({ media: true });
    renderApp(`/inbox/${conversationId}`);

    expect(await screen.findByText('Audio recibido · transcripción pendiente')).toBeInTheDocument();
  });

  it('shows a genuine empty state when the API has no conversations', async () => {
    installApiMock({ empty: true });
    renderApp();
    expect(await screen.findByText('Aún no hay conversaciones')).toBeInTheDocument();
  });

  it('shows a retryable error when the conversations service is unavailable', async () => {
    installApiMock({ listError: true });
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar las conversaciones');
    expect(screen.getByRole('button', { name: 'Volver a intentar' })).toBeInTheDocument();
  });

  it('streams new messages without reloading older pages, preserves a scrolled thread and deduplicates replay', async () => {
    const fetchMock = installApiMock();
    const fallback = fetchMock.getMockImplementation();
    expect(fallback).toBeDefined();
    let includeLiveMessage = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://panel.local');
      if (includeLiveMessage && url.pathname === `/api/v1/conversations/${conversationId}/messages`) {
        return jsonResponse({ items: [latestMessage, liveMessage], nextCursor: null, snapshot });
      }
      return fallback!(input, init);
    });
    const sources = installEventSourceMock();
    renderApp(`/inbox/${conversationId}`);

    const log = await screen.findByRole('log', { name: 'Mensajes del chat' });
    expect(await within(log).findByText('¿En qué puedo ayudarte?')).toBeInTheDocument();
    const history = document.querySelector('.message-history') as HTMLDivElement;
    Object.defineProperty(history, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(history, 'clientHeight', { configurable: true, value: 300 });
    history.scrollTop = 200;
    fireEvent.scroll(history);

    const source = sources[0];
    expect(source.url).toBe('/api/v1/events');
    act(() => source.open());
    expect(await screen.findByText('En vivo')).toBeInTheDocument();

    includeLiveMessage = true;
    const eventId = `${snapshot.dataEpoch}:3`;
    const event = streamEvent('message.created', {
      conversationId,
      messageId: liveMessage.id,
      aggregateVersion: '3'
    }, '3');
    act(() => source.dispatch('message.created', event, eventId));

    expect(await screen.findByText('Mensaje nuevo en vivo')).toBeInTheDocument();
    expect(screen.getByText('1 mensaje nuevo')).toBeInTheDocument();
    expect(history.scrollTop).toBe(200);
    expect(within(log).getAllByText('¿En qué puedo ayudarte?')).toHaveLength(1);

    act(() => source.disconnect());
    expect(screen.getByText('Reconectando…')).toBeInTheDocument();
    act(() => source.open());
    expect(screen.getByText('En vivo')).toBeInTheDocument();
    act(() => source.dispatch('message.created', event, eventId));
    expect(screen.getByText('1 mensaje nuevo')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Ver mensajes recientes' }));
    expect(history.scrollTop).toBe(1200);
    expect(screen.queryByText('1 mensaje nuevo')).not.toBeInTheDocument();
  });

  it('resets paginated snapshots when the stream reports that its cursor needs resynchronization', async () => {
    const fetchMock = installApiMock({ pagination: true, listPagination: true });
    const sources = installEventSourceMock();
    renderApp(`/inbox/${conversationId}`);
    await screen.findByText('¿En qué puedo ayudarte?');

    const source = sources[0];
    act(() => source.open());
    await screen.findByText('En vivo');
    const before = fetchMock.mock.calls.filter(([input]) => {
      const url = new URL(String(input), 'http://panel.local');
      return url.pathname === '/api/v1/conversations' && !url.searchParams.has('cursor');
    }).length;

    act(() => source.dispatch('resync.required', streamEvent('resync.required', { reason: 'cursor_expired' }, '4'), `${snapshot.dataEpoch}:4`));
    await waitFor(() => {
      const firstPageRequests = fetchMock.mock.calls.filter(([input]) => {
        const url = new URL(String(input), 'http://panel.local');
        return url.pathname === '/api/v1/conversations' && !url.searchParams.has('cursor');
      });
      expect(firstPageRequests.length).toBeGreaterThan(before);
    });
  });

  it('keeps section navigation and the skip-to-content link keyboard accessible', async () => {
    const user = userEvent.setup();
    renderApp('/inbox/contacts');
    expect(screen.getByRole('link', { name: 'Contactos' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Contactos' })).toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveFocus();
  });
});
