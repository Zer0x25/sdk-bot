import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Contract } from '@sdk-bot/contracts';
import App, { createAppQueryClient } from '../../app/App';

type Conversation = Contract<'Conversation'>;
const conversationId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const conversation: Conversation = {
  id: conversationId,
  accountId,
  contactId,
  canonicalIdentityId: contactId,
  aggregateVersion: '2',
  control: {
    accessPolicy: 'allowed', automationMode: 'ai', contextVersion: '3', controlVersion: '7',
    handoffReason: null, lifecycle: 'open', ownerId: null, profileKey: null,
    requiresReview: false, reviewReasons: [], status: 'confirmed', takenAt: null
  },
  displayName: 'Ana Pérez',
  historyCoverage: { kind: 'capturing_since', capturingSince: '2026-10-20T12:00:00.000Z' },
  lastActivityAt: '2026-10-20T12:00:00.000Z',
  requiresReview: false,
  unreadCount: 0
};
const secondConversation: Conversation = {
  ...conversation,
  id: '55555555-5555-4555-8555-555555555555',
  contactId: '66666666-6666-4666-8666-666666666666',
  canonicalIdentityId: '66666666-6666-4666-8666-666666666666',
  displayName: 'Beatriz Soto'
};
const snapshot = { dataEpoch: '44444444-4444-4444-8444-444444444444', seq: '2' };

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit
  ) {
    MockIntersectionObserver.instances.push(this);
  }

  intersect() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function installContactsApi(canWrite: boolean, paginate = false) {
  let currentConversation = conversation;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://panel.local');
    if (url.pathname === '/api/v1/session') {
      return jsonResponse({
        actor: { id: contactId, displayName: 'Operador', capabilities: canWrite ? ['conversations:read', 'conversations:write'] : ['conversations:read'] },
        policy: { globalMode: 'ignored_all', globalPaused: false, policyVersion: '1' }, snapshot
      });
    }
    if (url.pathname === '/api/v1/profiles') return jsonResponse({ items: [{ key: 'default', name: 'Predeterminado' }, { key: 'ventas', name: 'Ventas' }] });
    if (url.pathname === '/api/v1/accounts') return jsonResponse({ items: [{
      id: accountId, channel: 'whatsapp', displayName: 'WhatsApp', status: 'connected',
      capabilities: { attachments: true, deliveryReceipt: false, edit: false, historySync: true, readReceipt: false, reply: true }
    }] });
    if (url.pathname === `/api/v1/conversations/${conversationId}` && init?.method === 'PATCH') {
      const request = JSON.parse(String(init.body)) as { expectedVersion: string; accessPolicy?: Conversation['control']['accessPolicy']; profileKey?: string | null };
      if (!canWrite) return jsonResponse({ error: { code: 'FORBIDDEN', message: 'Sin permiso' } }, 403);
      expect(request.expectedVersion).toBe(currentConversation.control.controlVersion);
      currentConversation = {
        ...currentConversation,
        aggregateVersion: '3',
        control: {
          ...currentConversation.control,
          ...(request.accessPolicy ? { accessPolicy: request.accessPolicy } : {}),
          ...(request.profileKey !== undefined ? { profileKey: request.profileKey } : {}),
          controlVersion: '8', contextVersion: request.profileKey !== undefined ? '4' : currentConversation.control.contextVersion
        }
      };
      return jsonResponse({ conversation: currentConversation });
    }
    if (url.pathname === '/api/v1/conversations') {
      if (paginate && url.searchParams.get('cursor') === 'contacts-page-2') {
        return jsonResponse({ items: [secondConversation], nextCursor: null, snapshot });
      }
      return jsonResponse({ items: [currentConversation], nextCursor: paginate ? 'contacts-page-2' : null, snapshot });
    }
    return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderContacts() {
  window.history.replaceState({}, '', '/inbox/contacts');
  return render(<App queryClient={createAppQueryClient()} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  MockIntersectionObserver.instances = [];
  window.history.replaceState({}, '', '/inbox/');
});

describe('contact management', () => {
  it('updates access and profile through versioned v1 conversation writes', async () => {
    const user = userEvent.setup();
    const fetchMock = installContactsApi(true);
    renderContacts();

    expect(await screen.findByRole('heading', { name: 'Contactos' })).toBeInTheDocument();
    expect(await screen.findByText('Ana Pérez')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Ana Pérez/ })).getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.queryByText('111@s.whatsapp.net')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Permiso de Ana Pérez' }), 'ignored');
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      new URL(String(input), 'http://panel.local').pathname === `/api/v1/conversations/${conversationId}`
      && init?.method === 'PATCH'
      && JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify({ expectedVersion: '7', accessPolicy: 'ignored' })
    )).toBe(true));

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Perfil IA de Ana Pérez' }), 'ventas');
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      new URL(String(input), 'http://panel.local').pathname === `/api/v1/conversations/${conversationId}`
      && init?.method === 'PATCH'
      && JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify({ expectedVersion: '8', profileKey: 'ventas' })
    )).toBe(true));
  });

  it('shows read-only values when the session lacks conversations:write', async () => {
    installContactsApi(false);
    renderContacts();

    expect(await screen.findByRole('heading', { name: 'Contactos' })).toBeInTheDocument();
    expect(await screen.findByText('Vista de solo lectura')).toBeInTheDocument();
    expect(screen.getByText('Permitido')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Permiso de Ana Pérez' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Perfil IA de Ana Pérez' })).not.toBeInTheDocument();
  });

  it('loads more contacts inside the contact list when scrolling to its end', async () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    const fetchMock = installContactsApi(false, true);
    renderContacts();

    expect(await screen.findByText('Ana Pérez')).toBeInTheDocument();
    const list = screen.getByRole('region', { name: 'Lista de contactos' });
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    const observer = MockIntersectionObserver.instances.at(-1)!;
    expect(observer.options?.root).toBe(list);

    observer.intersect();
    expect(await screen.findByText('Beatriz Soto')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => {
      const url = new URL(String(input), 'http://panel.local');
      return url.pathname === '/api/v1/conversations' && url.searchParams.get('cursor') === 'contacts-page-2';
    })).toBe(true);
  });
});
