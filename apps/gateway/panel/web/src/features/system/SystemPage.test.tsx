import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { createAppQueryClient } from '../../app/App';

const actorId = '11111111-1111-4111-8111-111111111111';
const snapshot = { dataEpoch: '44444444-4444-4444-8444-444444444444', seq: '2' };
const status = {
  status: 'ok', uptime_seconds: 9300, pid: 42, node: 'v24.21.0',
  channels: {
    whatsapp: { connection: 'open', reconnectAttempt: 1 },
    telegram: { connection: 'close', reconnectAttempt: 0 }
  },
  bot: { profile: 'default', globalMode: 'ignored_all', paused: false },
  database: { contacts: 12, globalMode: 'ignored_all' },
  counters: { sentMessages: 8 },
  brain: {
    aiCalls: 4, lastErrorMsg: null,
    health: { state: 'Stopped', reachable: false, lastError: null, health: { providers: { primary: 'Groq (llama-3.1)' } } }
  },
  runtimeStats: { receivedMessages: 17 },
  queue: { pending: 1, max: 200 },
  broadcast: { pending: 0 },
  memory: { rss: 50_000_000, heapUsed: 20_000_000, heapTotal: 35_000_000 }
};

function jsonResponse(value: unknown, statusCode = 200) {
  return new Response(JSON.stringify(value), { status: statusCode, headers: { 'content-type': 'application/json' } });
}

function installSystemApi(options: { canManage?: boolean; commandOk?: boolean } = {}) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://panel.local');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    calls.push({ path: `${url.pathname}${url.search}`, method, body });
    if (url.pathname === '/api/v1/session') return jsonResponse({
      actor: {
        id: actorId, displayName: 'Operador',
        capabilities: options.canManage ? ['conversations:read', 'admin:write'] : ['conversations:read']
      },
      policy: { globalMode: 'ignored_all', globalPaused: false, policyVersion: '1' }, snapshot
    });
    if (url.pathname === '/api/status') return jsonResponse(status);
    if (url.pathname === '/api/command') return jsonResponse({
      ok: options.commandOk !== false,
      replies: [{ type: 'text', text: options.commandOk === false ? 'Comando rechazado' : 'Comando recibido' }]
    });
    if (url.pathname === '/api/brain/start') return jsonResponse({ success: true, message: 'Brain iniciándose.' });
    if (url.pathname === '/api/logs' && method === 'DELETE') return jsonResponse({ success: true, component: url.searchParams.get('component') });
    if (url.pathname === '/api/reset' && method === 'POST') {
      return body && typeof body === 'object' && (body as { clean?: boolean }).clean === true
        ? jsonResponse({ success: true })
        : jsonResponse({ success: true, message: 'Reset solicitado.' });
    }
    if (url.pathname === '/api/restart' && method === 'POST') return jsonResponse({ success: true, message: 'Gateway reiniciándose.' });
    return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  sendLine(line: string) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ component: 'gateway', line }) })); }
}

function renderSystem() {
  window.history.replaceState({}, '', '/inbox/system');
  return render(<App queryClient={createAppQueryClient()} />);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeEventSource.instances = [];
  window.history.replaceState({}, '', '/inbox/');
});

describe('system operations', () => {
  it('does not request diagnostics, logs, or legacy controls for a read-only session', async () => {
    const { calls } = installSystemApi();
    vi.stubGlobal('EventSource', FakeEventSource);
    renderSystem();

    expect(await screen.findByRole('heading', { name: 'Sistema' })).toBeInTheDocument();
    expect(await screen.findByText('Se requiere permiso administrativo')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ejecutar' })).not.toBeInTheDocument();
    expect(calls.every(call => call.path === '/api/v1/session')).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('renders bounded diagnostics and lets an admin start a stopped brain', async () => {
    const user = userEvent.setup();
    const { calls } = installSystemApi({ canManage: true });
    renderSystem();

    expect(await screen.findByText('Groq')).toBeInTheDocument();
    expect(screen.getByText('llama-3.1')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp').parentElement).toHaveTextContent('open');
    await user.click(screen.getByRole('button', { name: 'Iniciar brain' }));

    expect(await screen.findByText('Brain iniciándose.')).toBeInTheDocument();
    expect(calls.some(call => call.path === '/api/brain/start' && call.method === 'POST')).toBe(true);
  });

  it('executes a command once through the admin command handler and renders its result as text', async () => {
    const user = userEvent.setup();
    const { calls } = installSystemApi({ canManage: true });
    renderSystem();

    const command = await screen.findByRole('textbox', { name: 'Comando administrativo' });
    await user.type(command, '/estado');
    await user.click(screen.getByRole('button', { name: 'Ejecutar' }));

    expect(await screen.findByText('Comando recibido')).toBeInTheDocument();
    expect(calls.filter(call => call.path === '/api/command')).toHaveLength(1);
    expect(calls.find(call => call.path === '/api/command')?.body).toEqual({ command: '/estado' });
  });

  it('streams bounded logs, filters levels, pauses, resumes, and closes the SSE on unmount', async () => {
    const user = userEvent.setup();
    installSystemApi({ canManage: true });
    vi.stubGlobal('EventSource', FakeEventSource);
    const view = renderSystem();
    expect(await screen.findByRole('heading', { name: 'Logs en vivo' })).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0];
    expect(stream.url).toBe('/api/logs?component=gateway&history=100');
    act(() => {
      stream.open();
      stream.sendLine(JSON.stringify({ level: 50, time: Date.now(), cat: 'TEST', msg: 'falló el gateway' }));
      stream.sendLine(JSON.stringify({ level: 30, time: Date.now(), cat: 'TEST', msg: 'inicio normal' }));
    });
    expect(await screen.findByText('falló el gateway')).toBeInTheDocument();
    expect(screen.getByText('inicio normal')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Nivel' }), 'error');
    expect(screen.queryByText('inicio normal')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pausar' }));
    expect(stream.closed).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Reanudar' }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(stream.closed).toBe(true);
    view.unmount();
    expect(FakeEventSource.instances[1].closed).toBe(true);
  });

  it('asks before clearing only the selected active log file', async () => {
    const user = userEvent.setup();
    const { calls } = installSystemApi({ canManage: true });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSystem();
    await screen.findByRole('heading', { name: 'Logs en vivo' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Proceso' }), 'brain');
    await user.click(screen.getByRole('button', { name: 'Limpiar archivo activo' }));

    expect(window.confirm).toHaveBeenCalledWith('¿Limpiar el archivo activo de logs de Brain? Los archivos rotados se conservan.');
    expect(await screen.findByText('Archivo activo limpiado; los logs rotados se conservan.')).toBeInTheDocument();
    expect(calls.some(call => call.path === '/api/logs?component=brain' && call.method === 'DELETE')).toBe(true);
  });

  it('requires confirmation before resetting only the WhatsApp session', async () => {
    const user = userEvent.setup();
    const { calls } = installSystemApi({ canManage: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderSystem();
    await screen.findByRole('heading', { name: 'Sesión de WhatsApp' });
    await user.click(screen.getByRole('button', { name: 'Resetear sesión' }));
    expect(calls.some(call => call.path === '/api/reset')).toBe(false);
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Resetear sesión' }));

    expect(await screen.findByText('Reset solicitado.')).toBeInTheDocument();
    expect(calls.filter(call => call.path === '/api/reset')).toEqual([
      { path: '/api/reset', method: 'POST', body: { confirm: true } }
    ]);
  });

  it('requires the reading timer and exact factory word before one destructive request', async () => {
    const { calls } = installSystemApi({ canManage: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSystem();
    await screen.findByRole('button', { name: 'Abrir doble confirmación' });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir doble confirmación' }));
    expect(screen.getByText(/Podrás escribir la palabra en 10 s/)).toBeInTheDocument();
    for (let second = 0; second < 10; second += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    }
    const input = screen.getByRole('textbox', { name: /BORRAR-TODO/ });
    expect(input).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Ejecutar reset limpio' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'NO' } });
    expect(screen.getByRole('button', { name: 'Ejecutar reset limpio' })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'BORRAR-TODO' } });
    vi.useRealTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ejecutar reset limpio' }));
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    });
    expect(await screen.findByText('Reset limpio completado. El gateway se está reiniciando.')).toBeInTheDocument();
    expect(calls.filter(call => call.path === '/api/reset')).toEqual([
      { path: '/api/reset', method: 'POST', body: { confirm: true, clean: true } }
    ]);
  });

  it('confirms a gateway restart without sending a reset request', async () => {
    const user = userEvent.setup();
    const { calls } = installSystemApi({ canManage: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSystem();
    await screen.findByRole('heading', { name: 'Gateway' });
    await user.click(screen.getByRole('button', { name: 'Reiniciar gateway' }));

    expect(await screen.findByText('Gateway reiniciándose.')).toBeInTheDocument();
    expect(calls.some(call => call.path === '/api/restart' && call.body && (call.body as { confirm?: boolean }).confirm === true)).toBe(true);
    expect(calls.some(call => call.path === '/api/reset')).toBe(false);
  });
});
