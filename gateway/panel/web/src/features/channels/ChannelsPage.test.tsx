import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { createAppQueryClient } from '../../app/App';
import type { PairingStatus } from './api';

const actorId = '11111111-1111-4111-8111-111111111111';
const snapshot = { dataEpoch: '44444444-4444-4444-8444-444444444444', seq: '2' };

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

class TestEventSource {
  static instances: TestEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string) { TestEventSource.instances.push(this); }
  close() { this.closed = true; }
  send(value: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) })); }
}

function installChannelApi(options: { canManage?: boolean; pairing?: PairingStatus } = {}) {
  let pairing: PairingStatus = options.pairing ?? {
    active: false, method: null, busy: false, code: null, phone: null,
    issuedAt: null, expiresAt: null, expired: false
  };
  let meta = { configured: false, chatIdConfigured: false };
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://panel.local');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    calls.push({ path: url.pathname, method, body });

    if (url.pathname === '/api/v1/session') return jsonResponse({
      actor: {
        id: actorId, displayName: 'Operador',
        capabilities: options.canManage ? ['conversations:read', 'admin:write'] : ['conversations:read']
      },
      policy: { globalMode: 'ignored_all', globalPaused: false, policyVersion: '1' }, snapshot
    });
    if (url.pathname === '/api/v1/accounts') return jsonResponse({ items: [
      { id: '22222222-2222-4222-8222-222222222222', channel: 'whatsapp', displayName: 'WA', status: 'disconnected', capabilities: { attachments: true, deliveryReceipt: false, edit: false, historySync: true, readReceipt: false, reply: true } },
      { id: '33333333-3333-4333-8333-333333333333', channel: 'telegram', displayName: 'TG', status: 'connected', capabilities: { attachments: false, deliveryReceipt: false, edit: false, historySync: false, readReceipt: false, reply: false } }
    ] });
    if (url.pathname === '/api/pairing/status') return jsonResponse(pairing);
    if (url.pathname === '/api/telegram/settings/meta') return jsonResponse(meta);
    if (url.pathname === '/api/qr/refresh' && method === 'POST') {
      pairing = { active: true, method: 'qr', busy: false, code: null, phone: null, issuedAt: Date.now(), expiresAt: Date.now() + 140_000, expired: false };
      return jsonResponse({ success: true });
    }
    if (url.pathname === '/api/pairing' && method === 'POST') {
      const phone = (body as { phone?: string } | null)?.phone;
      pairing = phone
        ? { active: true, method: 'code', busy: false, code: 'A1B2C3D4', phone, issuedAt: Date.now(), expiresAt: Date.now() + 180_000, expired: false }
        : { active: true, method: 'qr', busy: false, code: null, phone: null, issuedAt: Date.now(), expiresAt: Date.now() + 140_000, expired: false };
      return jsonResponse({ success: true, code: phone ? 'A1B2C3D4' : null });
    }
    if (url.pathname === '/api/telegram/settings' && method === 'POST') {
      const settings = body as { token: string; chatId: string };
      meta = { configured: Boolean(settings.token), chatIdConfigured: Boolean(settings.chatId) };
      return jsonResponse({ success: true });
    }
    return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function renderChannels() {
  window.history.replaceState({}, '', '/inbox/channels');
  return render(<App queryClient={createAppQueryClient()} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TestEventSource.instances = [];
  window.history.replaceState({}, '', '/inbox/');
});

describe('channel management', () => {
  it('shows safe channel status to read-only sessions without loading pairing or Telegram controls', async () => {
    const { calls } = installChannelApi();
    vi.stubGlobal('EventSource', TestEventSource);
    renderChannels();

    expect(await screen.findByRole('heading', { name: 'Canales' })).toBeInTheDocument();
    expect(await screen.findByText('Vista de solo lectura')).toBeInTheDocument();
    expect(await screen.findByText('Desconectado')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Solicitar QR' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Token del bot')).not.toBeInTheDocument();
    expect(calls.some(call => call.path === '/api/pairing/status' || call.path === '/api/telegram/settings/meta')).toBe(false);
  });

  it('restores an active QR stream and closes it when the page unmounts', async () => {
    const { calls } = installChannelApi({ canManage: true });
    vi.stubGlobal('EventSource', TestEventSource);
    const view = renderChannels();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Solicitar QR' }));
    await waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    expect(calls.some(call => call.path === '/api/qr/refresh' && call.method === 'POST')).toBe(true);
    act(() => TestEventSource.instances[0].send({ qr: 'data:image/png;base64,c2FmZS1maXh0dXJl', expiresAt: Date.now() + 30_000, expired: false, session: false }));
    expect(await screen.findByRole('img', { name: 'Código QR de WhatsApp para vincular el dispositivo' })).toBeInTheDocument();

    view.unmount();
    expect(TestEventSource.instances[0].closed).toBe(true);
  });

  it('restores a code pairing, keeps the code and excludes QR while its window is active', async () => {
    installChannelApi({ canManage: true, pairing: {
      active: true, method: 'code', busy: false, code: 'A1B2C3D4', phone: '56912345678',
      issuedAt: Date.now(), expiresAt: Date.now() + 180_000, expired: false
    } });
    vi.stubGlobal('EventSource', TestEventSource);
    renderChannels();

    expect(await screen.findByText('A1B2C3D4')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Número con código de país' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Solicitar QR' })).not.toBeInTheDocument();
    expect(TestEventSource.instances).toHaveLength(0);
  });

  it('requests a manual code only after an explicit phone submission', async () => {
    const { calls } = installChannelApi({ canManage: true });
    vi.stubGlobal('EventSource', TestEventSource);
    const user = userEvent.setup();
    renderChannels();

    await user.type(await screen.findByRole('textbox', { name: 'Número con código de país' }), '56912345678');
    await user.click(screen.getByRole('button', { name: 'Pedir código' }));
    expect(await screen.findByText('A1B2C3D4')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Solicitar QR' })).not.toBeInTheDocument();
    expect(calls.filter(call => call.path === '/api/pairing' && call.method === 'POST')).toHaveLength(1);
    expect(calls.find(call => call.path === '/api/pairing' && call.method === 'POST')?.body).toEqual({ phone: '56912345678' });
  });

  it('saves Telegram settings without reading the token or sending a test message', async () => {
    const { calls } = installChannelApi({ canManage: true });
    vi.stubGlobal('EventSource', TestEventSource);
    const user = userEvent.setup();
    renderChannels();

    const tokenInput = await screen.findByLabelText('Token del bot');
    expect(tokenInput).toHaveValue('');
    expect(screen.queryByRole('button', { name: /prueba/i })).not.toBeInTheDocument();
    await user.type(tokenInput, 'secret-fixture-token');
    await user.type(screen.getByLabelText('Chat ID administrativo'), '12345');
    await user.click(screen.getByRole('button', { name: 'Guardar configuración' }));

    await waitFor(() => expect(calls.some(call => call.path === '/api/telegram/settings' && call.method === 'POST'
      && JSON.stringify(call.body) === JSON.stringify({ token: 'secret-fixture-token', chatId: '12345' }))).toBe(true));
    expect(await screen.findByText('Configuración guardada. El token se borró del formulario.')).toBeInTheDocument();
    expect(tokenInput).toHaveValue('');
    expect(calls.some(call => call.path === '/api/telegram/settings' && call.method === 'GET')).toBe(false);
    expect(calls.some(call => call.path === '/api/telegram/test')).toBe(false);
  });
});
