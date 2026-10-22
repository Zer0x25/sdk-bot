import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { createAppQueryClient } from '../../app/App';

const actorId = '11111111-1111-4111-8111-111111111111';
const snapshot = { dataEpoch: '44444444-4444-4444-8444-444444444444', seq: '2' };
const initialProfile = `# Ventas\nPerfil para el equipo comercial.\n\n## Personalidad\nCercana y directa.\n\n## Reglas\n- No inventar precios.\n`;
const secondProfile = `# Predeterminado\n\n## Personalidad\nNeutral.\n\n## Reglas\n- Responder con claridad.\n`;
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function installAssistantApi(options: { canManage?: boolean; failSave?: boolean } = {}) {
  const profiles = new Map([['ventas', initialProfile], ['default', secondProfile]]);
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
    if (url.pathname === '/api/v1/profiles') return jsonResponse({ items: [
      { key: 'default', name: 'Predeterminado' }, { key: 'ventas', name: 'Ventas' }
    ] });
    if (url.pathname === '/api/profiles' && method === 'GET') return jsonResponse({ profiles: [
      { key: 'default', nombre: 'Predeterminado', descripcion: 'Perfil base' },
      { key: 'ventas', nombre: 'Ventas', descripcion: 'Perfil comercial' }
    ] });
    if (url.pathname === '/api/profiles/import' && method === 'POST') {
      if (options.failSave) return jsonResponse({ success: false, message: 'Rechazado por el brain' }, 400);
      const request = body as { key: string; content: string };
      profiles.set(request.key, request.content);
      return jsonResponse({ success: true, key: request.key, nombre: request.key === 'ventas' ? 'Ventas' : request.key });
    }
    if (url.pathname === '/api/profiles/reload' && method === 'POST') return jsonResponse({ success: true });
    if (url.pathname.startsWith('/api/profiles/') && url.pathname.endsWith('/file') && method === 'GET') {
      const key = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      const content = profiles.get(key);
      return content === undefined ? jsonResponse({ error: 'No encontrado' }, 404) : jsonResponse({ content, filename: `${key}.md` });
    }
    if (url.pathname.startsWith('/api/profiles/') && method === 'GET') {
      const key = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      return jsonResponse({ key, nombre: key, descripcion: 'Perfil compilado', prompt: `Prompt efectivo para ${key}` });
    }
    if (url.pathname.startsWith('/api/profiles/') && method === 'DELETE') {
      const key = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      profiles.delete(key);
      return jsonResponse({ success: true });
    }
    return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function renderAssistant() {
  window.history.replaceState({}, '', '/inbox/assistant');
  return render(<App queryClient={createAppQueryClient()} />);
}

afterEach(() => {
  cleanup();
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/inbox/');
});

describe('assistant profile management', () => {
  it('shows only v1 profile names to read-only sessions', async () => {
    const { calls } = installAssistantApi();
    renderAssistant();

    expect(await screen.findByRole('heading', { name: 'Asistente' })).toBeInTheDocument();
    expect(await screen.findByText('Vista de solo lectura')).toBeInTheDocument();
    expect(await screen.findByText('Ventas')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Archivo Markdown' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuevo' })).not.toBeInTheDocument();
    expect(calls.some(call => call.path === '/api/profiles' || call.path.startsWith('/api/profiles/'))).toBe(false);
  });

  it('loads an editable file and asks before discarding changes when switching profiles', async () => {
    const user = userEvent.setup();
    const { calls } = installAssistantApi({ canManage: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAssistant();

    await screen.findByRole('option', { name: /Ventas/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Perfil seleccionado' }), 'ventas');
    const editor = await screen.findByRole('textbox', { name: 'Archivo Markdown' });
    expect(editor).toHaveValue(initialProfile);
    await user.type(editor, 'Cambios locales.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Perfil seleccionado' }), 'default');

    expect(confirm).toHaveBeenCalledWith('Hay cambios sin guardar. ¿Descartar el borrador?');
    expect(screen.getByRole('textbox', { name: 'Archivo Markdown' })).toHaveValue(`${initialProfile}Cambios locales.`);
    expect(calls.some(call => call.path === '/api/profiles/default/file')).toBe(false);
  });

  it('keeps an unsaved draft when a navigation link is canceled', async () => {
    const user = userEvent.setup();
    installAssistantApi({ canManage: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAssistant();

    await screen.findByRole('option', { name: /Ventas/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Perfil seleccionado' }), 'ventas');
    const editor = await screen.findByRole('textbox', { name: 'Archivo Markdown' });
    const updated = `${initialProfile}\nNo descartar.\n`;
    fireEvent.change(editor, { target: { value: updated } });
    await user.click(screen.getByRole('link', { name: 'Contactos' }));

    expect(confirm).toHaveBeenCalledWith('Hay cambios sin guardar en Asistente. ¿Descartar el borrador y salir?');
    expect(window.location.pathname).toBe('/inbox/assistant');
    expect(screen.getByRole('textbox', { name: 'Archivo Markdown' })).toHaveValue(updated);
  });

  it('saves the exact draft and only marks it clean after the server accepts it', async () => {
    const user = userEvent.setup();
    const { calls } = installAssistantApi({ canManage: true });
    renderAssistant();

    await screen.findByRole('option', { name: /Ventas/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Perfil seleccionado' }), 'ventas');
    const editor = await screen.findByRole('textbox', { name: 'Archivo Markdown' });
    const updated = `${initialProfile}\n## Formato\nBreve.\n`;
    fireEvent.change(editor, { target: { value: updated } });
    await user.click(screen.getByRole('button', { name: 'Guardar perfil' }));

    expect(await screen.findByText('Guardado')).toBeInTheDocument();
    expect(calls.find(call => call.path === '/api/profiles/import')?.body).toEqual({ key: 'ventas', content: updated });
    expect(screen.getByRole('textbox', { name: 'Archivo Markdown' })).toHaveValue(updated);
  });

  it('keeps the edited draft and dirty state when the brain rejects a save', async () => {
    const user = userEvent.setup();
    installAssistantApi({ canManage: true, failSave: true });
    renderAssistant();

    await screen.findByRole('option', { name: /Ventas/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Perfil seleccionado' }), 'ventas');
    const editor = await screen.findByRole('textbox', { name: 'Archivo Markdown' });
    const updated = `${initialProfile}\nCambio sin confirmar.\n`;
    fireEvent.change(editor, { target: { value: updated } });
    await user.click(screen.getByRole('button', { name: 'Guardar perfil' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('El brain rechazó el perfil');
    expect(screen.getByRole('textbox', { name: 'Archivo Markdown' })).toHaveValue(updated);
    expect(screen.getByText('Cambios sin guardar')).toBeInTheDocument();
  });

  it('asks before a new draft overwrites a profile with the same key', async () => {
    const user = userEvent.setup();
    const { calls } = installAssistantApi({ canManage: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAssistant();

    await screen.findByRole('option', { name: /Ventas/ });
    await user.click(screen.getByRole('button', { name: 'Nuevo' }));
    await user.type(screen.getByRole('textbox', { name: 'Clave del perfil' }), 'ventas');
    await user.type(screen.getByRole('textbox', { name: 'Archivo Markdown' }), initialProfile);
    await user.click(screen.getByRole('button', { name: 'Guardar perfil' }));

    expect(confirm).toHaveBeenCalledWith('El perfil «ventas» ya existe. ¿Quieres reemplazarlo?');
    expect(calls.some(call => call.path === '/api/profiles/import' && call.method === 'POST')).toBe(false);
    expect(screen.getByText('Cambios sin guardar')).toBeInTheDocument();
  });

  it('imports a local Markdown file as a draft and exports the unsaved draft', async () => {
    const user = userEvent.setup();
    installAssistantApi({ canManage: true });
    const createObjectURL = vi.fn(() => 'blob:assistant-profile');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    renderAssistant();

    const input = await screen.findByLabelText('Importar Markdown') as HTMLInputElement;
    const file = new File(['placeholder'], 'campaign notes.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'text', { configurable: true, value: async () => initialProfile });
    await user.upload(input, file);

    expect(await screen.findByRole('textbox', { name: 'Clave del perfil' })).toHaveValue('campaign_notes');
    const editor = screen.getByRole('textbox', { name: 'Archivo Markdown' });
    expect(editor).toHaveValue(initialProfile);
    const draft = `${initialProfile}\nUnsaved export.\n`;
    fireEvent.change(editor, { target: { value: draft } });
    await user.click(screen.getByRole('button', { name: 'Exportar Markdown' }));

    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'text/markdown;charset=utf-8' }));
    expect(downloads).toEqual(['campaign_notes.md']);
    expect(await screen.findByText(/Borrador exportado/)).toBeInTheDocument();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:assistant-profile'));
  });

  it('shows the compiled prompt on demand and reloads profile metadata', async () => {
    const user = userEvent.setup();
    const { calls } = installAssistantApi({ canManage: true });
    renderAssistant();

    await screen.findByRole('option', { name: /Ventas/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Perfil seleccionado' }), 'ventas');
    await screen.findByRole('textbox', { name: 'Archivo Markdown' });
    await user.click(screen.getByRole('button', { name: 'Ver prompt compilado' }));
    expect(await screen.findByText('Prompt efectivo para ventas')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recargar' }));
    await waitFor(() => expect(calls.some(call => call.path === '/api/profiles/reload' && call.method === 'POST')).toBe(true));
  });

  it('deletes a selected non-default profile only after the explicit confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = installAssistantApi({ canManage: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAssistant();

    await screen.findByRole('option', { name: /Ventas/ });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Perfil seleccionado' }), 'ventas');
    await screen.findByRole('textbox', { name: 'Archivo Markdown' });
    await user.click(screen.getByRole('button', { name: 'Eliminar' }));

    await waitFor(() => expect(calls.some(call => call.path === '/api/profiles/ventas' && call.method === 'DELETE')).toBe(true));
    expect(await screen.findByText('Perfil «ventas» eliminado.')).toBeInTheDocument();
  });
});
