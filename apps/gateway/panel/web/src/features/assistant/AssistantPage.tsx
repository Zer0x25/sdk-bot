import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Download, Eye, FileUp, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useAssistantDraftGuard } from '../../app/AppShell';
import { getAutomationProfiles, getSession } from '../inbox/api';
import {
  deleteProfile,
  getCompiledProfile,
  getEditableProfiles,
  getProfileFile,
  reloadProfiles,
  saveProfile,
  type ProfileSummary
} from './api';

const MAX_PROFILE_BYTES = 900_000;
const profileKeyPattern = /^[a-z0-9_-]{1,80}$/;

function asError(value: unknown) {
  return value instanceof Error ? value : new Error('No se pudo completar la operación.');
}

function safeFilename(value: string) {
  return value.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
}

export function AssistantPage() {
  const queryClient = useQueryClient();
  const setAssistantDraftDirty = useAssistantDraftGuard();
  const [selectedKey, setSelectedKey] = useState('');
  const [isNewProfile, setIsNewProfile] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [baselineKey, setBaselineKey] = useState('');
  const [baselineContent, setBaselineContent] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const sessionQuery = useQuery({
    queryKey: ['assistant', 'session'],
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000
  });
  const canManage = sessionQuery.data?.actor.capabilities.includes('admin:write') === true;
  const visibleProfilesQuery = useQuery({
    queryKey: ['assistant', 'visible-profiles'],
    queryFn: ({ signal }) => getAutomationProfiles(signal),
    enabled: sessionQuery.isSuccess && !canManage,
    staleTime: 30_000
  });
  const editableProfilesQuery = useQuery({
    queryKey: ['assistant', 'editable-profiles'],
    queryFn: ({ signal }) => getEditableProfiles(signal),
    enabled: canManage,
    staleTime: 5_000
  });
  const profiles: ProfileSummary[] = canManage
    ? editableProfilesQuery.data ?? []
    : (visibleProfilesQuery.data?.items ?? []).map(profile => ({ key: profile.key, nombre: profile.name, descripcion: '' }));

  const fileQuery = useQuery({
    queryKey: ['assistant', 'file', selectedKey],
    queryFn: ({ signal }) => getProfileFile(selectedKey, signal),
    enabled: canManage && selectedKey !== '',
    staleTime: 0
  });
  const promptQuery = useQuery({
    queryKey: ['assistant', 'compiled', selectedKey],
    queryFn: ({ signal }) => getCompiledProfile(selectedKey, signal),
    enabled: canManage && showPrompt && selectedKey !== '' && !isNewProfile,
    staleTime: 30_000
  });

  const fileReady = selectedKey !== '' && fileQuery.data?.key === selectedKey;
  const dirty = isNewProfile
    ? draftKey !== baselineKey || draftContent !== baselineContent
    : fileReady && draftContent !== baselineContent;
  const contentBytes = new TextEncoder().encode(draftContent).byteLength;
  const keyValid = profileKeyPattern.test(draftKey);
  const contentValid = draftContent.trim().length > 0 && contentBytes <= MAX_PROFILE_BYTES;

  useEffect(() => {
    if (!fileReady || !fileQuery.data) return;
    setDraftKey(fileQuery.data.key);
    setDraftContent(fileQuery.data.content);
    setBaselineKey(fileQuery.data.key);
    setBaselineContent(fileQuery.data.content);
    setError(null);
    setMessage(null);
    setShowPrompt(false);
  }, [fileReady, fileQuery.data]);

  useEffect(() => {
    setAssistantDraftDirty(dirty);
  }, [dirty, setAssistantDraftDirty]);

  useEffect(() => () => setAssistantDraftDirty(false), [setAssistantDraftDirty]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeave);
    return () => window.removeEventListener('beforeunload', warnBeforeLeave);
  }, [dirty]);

  const saveMutation = useMutation({
    mutationFn: ({ key, content }: { key: string; content: string }) => saveProfile(key, content),
    onSuccess: async (saved, variables) => {
      setSelectedKey(saved.key);
      setIsNewProfile(false);
      setDraftKey(saved.key);
      setDraftContent(variables.content);
      setBaselineKey(saved.key);
      setBaselineContent(variables.content);
      setError(null);
      setMessage(`Perfil «${saved.nombre}» guardado.`);
      setShowPrompt(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['assistant', 'editable-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['assistant', 'file', saved.key] }),
        queryClient.invalidateQueries({ queryKey: ['assistant', 'compiled', saved.key] }),
        queryClient.invalidateQueries({ queryKey: ['contacts', 'profiles'] })
      ]);
    },
    onError: value => { setMessage(null); setError(asError(value).message); }
  });
  const reloadMutation = useMutation({
    mutationFn: reloadProfiles,
    onSuccess: async () => {
      setError(null);
      setMessage('Perfiles recargados del brain.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['assistant', 'editable-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['assistant', 'visible-profiles'] })
      ]);
    },
    onError: value => { setMessage(null); setError(asError(value).message); }
  });
  const deleteMutation = useMutation({
    mutationFn: deleteProfile,
    onSuccess: async (_result, deletedKey) => {
      setSelectedKey('');
      setIsNewProfile(false);
      setDraftKey('');
      setDraftContent('');
      setBaselineKey('');
      setBaselineContent('');
      setShowPrompt(false);
      setError(null);
      setMessage(`Perfil «${deletedKey}» eliminado.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['assistant', 'editable-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['assistant', 'visible-profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['contacts', 'profiles'] })
      ]);
    },
    onError: value => { setMessage(null); setError(asError(value).message); }
  });

  function confirmDiscard() {
    return !dirty || window.confirm('Hay cambios sin guardar. ¿Descartar el borrador?');
  }

  function clearEditor() {
    setSelectedKey('');
    setIsNewProfile(false);
    setDraftKey('');
    setDraftContent('');
    setBaselineKey('');
    setBaselineContent('');
    setShowPrompt(false);
  }

  function selectProfile(key: string) {
    if (key === selectedKey && !isNewProfile) return;
    if (!confirmDiscard()) return;
    setMessage(null);
    setError(null);
    setIsNewProfile(false);
    setSelectedKey(key);
    setDraftKey('');
    setDraftContent('');
    setBaselineKey('');
    setBaselineContent('');
    setShowPrompt(false);
    if (!key) clearEditor();
  }

  function startNewProfile() {
    if (!confirmDiscard()) return;
    setSelectedKey('');
    setIsNewProfile(true);
    setDraftKey('');
    setDraftContent('');
    setBaselineKey('');
    setBaselineContent('');
    setShowPrompt(false);
    setError(null);
    setMessage('Borrador nuevo. Completa la clave y el contenido antes de guardar.');
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > MAX_PROFILE_BYTES) {
      setMessage(null);
      setError('El archivo supera el límite de 900 KB.');
      return;
    }
    if (!confirmDiscard()) return;
    try {
      const content = await file.text();
      const importedKey = safeFilename(file.name.replace(/\.(md|txt)$/i, '').toLowerCase());
      setSelectedKey('');
      setIsNewProfile(true);
      setDraftKey(importedKey);
      setDraftContent(content);
      setBaselineKey('');
      setBaselineContent('');
      setShowPrompt(false);
      setError(null);
      setMessage(`Archivo «${file.name}» cargado como borrador. Revisa y guarda para aplicarlo.`);
    } catch {
      setMessage(null);
      setError('No se pudo leer el archivo local.');
    }
  }

  function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || !keyValid || !contentValid || saveMutation.isPending || !dirty) return;
    if (isNewProfile && profiles.some(profile => profile.key === draftKey)
      && !window.confirm(`El perfil «${draftKey}» ya existe. ¿Quieres reemplazarlo?`)) return;
    setMessage(null);
    setError(null);
    saveMutation.mutate({ key: draftKey, content: draftContent });
  }

  function exportDraft() {
    if (!draftKey || !draftContent) {
      setMessage(null);
      setError('Selecciona o importa un perfil antes de exportar.');
      return;
    }
    const filename = `${safeFilename(draftKey) || 'perfil'}.md`;
    const url = URL.createObjectURL(new Blob([draftContent], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setError(null);
    setMessage(`Borrador exportado como «${filename}».`);
  }

  function removeProfile() {
    if (!selectedKey || selectedKey === 'default' || deleteMutation.isPending || !confirmDiscard()) return;
    if (!window.confirm(`¿Eliminar el perfil «${selectedKey}»? Los contactos asignados pasarán al perfil predeterminado.`)) return;
    setMessage(null);
    setError(null);
    deleteMutation.mutate(selectedKey);
  }

  const listError = canManage ? editableProfilesQuery.error : visibleProfilesQuery.error;
  const listLoading = sessionQuery.isSuccess && (canManage ? editableProfilesQuery.isPending : visibleProfilesQuery.isPending);
  const listRefetch = canManage ? editableProfilesQuery.refetch : visibleProfilesQuery.refetch;
  const editorReady = canManage && (isNewProfile || fileReady);
  const sessionUnavailable = !sessionQuery.isPending && sessionQuery.isError;

  return (
    <section className="assistant-page" aria-labelledby="assistant-title">
      <header className="assistant-header">
        <div>
          <p className="eyebrow"><Bot aria-hidden="true" size={14} /> Perfiles y comportamiento</p>
          <h1 id="assistant-title">Asistente</h1>
          <p className="assistant-subtitle">Edita los perfiles de IA, conserva tus borradores y descarga Markdown.</p>
        </div>
        {sessionQuery.isPending ? <span className="assistant-permission">Comprobando permisos…</span>
          : sessionQuery.isError ? <span className="assistant-permission" role="alert">No se pudo comprobar tu sesión.</span>
            : !canManage && <span className="assistant-permission">Vista de solo lectura</span>}
      </header>

      {error && <p className="assistant-feedback is-error" role="alert">{error}</p>}
      {message && <p className="assistant-feedback is-message" role="status">{message}</p>}

      {sessionUnavailable && <div className="assistant-state assistant-state-error" role="alert">
        <div><h2>No se pudo comprobar tu sesión</h2><p>{asError(sessionQuery.error).message}</p></div>
        <button className="assistant-secondary-button" type="button" onClick={() => void sessionQuery.refetch()}><RefreshCw aria-hidden="true" size={14} /> Reintentar</button>
      </div>}
      {!sessionUnavailable && listLoading && <div className="assistant-state" role="status">Cargando perfiles…</div>}
      {!sessionUnavailable && listError && (
        <div className="assistant-state assistant-state-error" role="alert">
          <div><h2>No se pudo cargar la lista de perfiles</h2><p>{asError(listError).message}</p></div>
          <button className="assistant-secondary-button" type="button" onClick={() => void listRefetch()}><RefreshCw aria-hidden="true" size={14} /> Reintentar</button>
        </div>
      )}

      {sessionQuery.isSuccess && !listLoading && !listError && !canManage && (
        <>
          <p className="assistant-readonly-note">Los nombres son visibles para la sesión; el contenido y las acciones requieren permiso administrativo.</p>
          {profiles.length === 0 ? <div className="assistant-state">No hay perfiles disponibles.</div> : (
            <ul className="assistant-profile-list" aria-label="Perfiles disponibles">
              {profiles.map(profile => <li key={profile.key}><strong>{profile.nombre}</strong><code>{profile.key}</code></li>)}
            </ul>
          )}
        </>
      )}

      {sessionQuery.isSuccess && canManage && (
        <div className="assistant-workspace">
          <aside className="assistant-profile-nav" aria-label="Perfiles del asistente">
            <div className="assistant-profile-nav-heading"><h2>Perfiles</h2><span>{profiles.length}</span></div>
            <label className="visually-hidden" htmlFor="assistant-profile-select">Perfil seleccionado</label>
            <select id="assistant-profile-select" value={isNewProfile ? '' : selectedKey}
              onChange={event => selectProfile(event.currentTarget.value)} disabled={editableProfilesQuery.isPending || profiles.length === 0}>
              <option value="">— Seleccionar perfil —</option>
              {profiles.map(profile => <option key={profile.key} value={profile.key}>{profile.nombre} ({profile.key})</option>)}
            </select>
            {profiles.length > 0 && <ul className="assistant-profile-list">
              {profiles.map(profile => <li key={profile.key} className={selectedKey === profile.key && !isNewProfile ? 'is-selected' : ''}>
                <button type="button" onClick={() => selectProfile(profile.key)} aria-current={selectedKey === profile.key && !isNewProfile ? 'true' : undefined}>
                  <strong>{profile.nombre}</strong><code>{profile.key}</code>
                  {profile.descripcion && <span>{profile.descripcion}</span>}
                </button>
              </li>)}
            </ul>}
            {!editableProfilesQuery.isPending && profiles.length === 0 && <p className="assistant-empty-list">Sin perfiles (brain apagado o carpeta vacía).</p>}
            <div className="assistant-sidebar-actions">
              <button className="assistant-secondary-button" type="button" onClick={startNewProfile}><Plus aria-hidden="true" size={14} /> Nuevo</button>
              <button className="assistant-secondary-button" type="button" onClick={() => { setMessage(null); setError(null); reloadMutation.mutate(); }} disabled={reloadMutation.isPending}>
                <RefreshCw aria-hidden="true" size={14} /> {reloadMutation.isPending ? 'Recargando…' : 'Recargar'}
              </button>
            </div>
          </aside>

          <div className="assistant-editor-column">
            <div className="assistant-toolbar">
              <label className="assistant-import-button">
                <FileUp aria-hidden="true" size={15} /> Importar Markdown
                <input type="file" accept=".md,.txt,text/markdown,text/plain" onChange={event => void importFile(event)} />
              </label>
              <span className={dirty ? 'assistant-draft-state is-dirty' : 'assistant-draft-state'} role="status">
                {dirty ? 'Cambios sin guardar' : fileReady ? 'Guardado' : isNewProfile ? 'Borrador nuevo' : 'Selecciona un perfil'}
              </span>
            </div>

            {fileQuery.isError && selectedKey && <div className="assistant-state assistant-state-error" role="alert">
              <div><h2>No se pudo abrir el perfil</h2><p>{asError(fileQuery.error).message}</p></div>
              <button className="assistant-secondary-button" type="button" onClick={() => void fileQuery.refetch()}><RefreshCw aria-hidden="true" size={14} /> Reintentar</button>
            </div>}
            {selectedKey && fileQuery.isPending && <div className="assistant-state" role="status">Cargando Markdown…</div>}

            {editorReady ? (
              <form className="assistant-editor" onSubmit={saveDraft}>
                <div className="assistant-key-row">
                  <label htmlFor="assistant-profile-key">Clave del perfil</label>
                  <input id="assistant-profile-key" type="text" autoComplete="off" value={draftKey}
                    disabled={!isNewProfile || saveMutation.isPending} onChange={event => setDraftKey(event.currentTarget.value)} />
                  {!keyValid && <span className="assistant-field-hint">Usa 1–32 caracteres: minúsculas, números, guion o guion bajo.</span>}
                </div>
                <label className="assistant-content-label" htmlFor="assistant-profile-content">Archivo Markdown</label>
                <textarea id="assistant-profile-content" spellCheck={false} value={draftContent}
                  disabled={saveMutation.isPending} onChange={event => setDraftContent(event.currentTarget.value)}
                  placeholder={'# nombre\nDescripción breve\n\n## Personalidad\nDescribe el tono y el rol.\n\n## Reglas\n- Una regla por línea.'} />
                <div className="assistant-editor-footer">
                  <span className={contentBytes > MAX_PROFILE_BYTES ? 'assistant-field-hint is-error' : 'assistant-field-hint'}>
                    {contentBytes.toLocaleString()} / {MAX_PROFILE_BYTES.toLocaleString()} bytes · requiere ## Personalidad y ## Reglas
                  </span>
                  <div className="assistant-editor-actions">
                    <button className="assistant-primary-button" type="submit" disabled={saveMutation.isPending || !dirty || !keyValid || !contentValid}>
                      <Save aria-hidden="true" size={14} /> {saveMutation.isPending ? 'Guardando…' : 'Guardar perfil'}
                    </button>
                    <button className="assistant-secondary-button" type="button" onClick={exportDraft} disabled={!draftContent}>
                      <Download aria-hidden="true" size={14} /> Exportar Markdown
                    </button>
                    {selectedKey && selectedKey !== 'default' && <button className="assistant-danger-button" type="button" onClick={removeProfile}
                      disabled={deleteMutation.isPending || !fileReady}>
                      <Trash2 aria-hidden="true" size={14} /> Eliminar
                    </button>}
                    {selectedKey && !isNewProfile && <button className="assistant-secondary-button" type="button"
                      onClick={() => setShowPrompt(current => !current)} disabled={dirty}>
                      <Eye aria-hidden="true" size={14} /> {showPrompt ? 'Ocultar prompt' : 'Ver prompt compilado'}
                    </button>}
                  </div>
                </div>
              </form>
            ) : !selectedKey && !isNewProfile && (
              <div className="assistant-editor-empty"><Bot aria-hidden="true" size={22} /><h2>Selecciona un perfil</h2><p>El contenido se carga desde el brain al abrir un perfil.</p></div>
            )}

            {showPrompt && selectedKey && !dirty && (
              promptQuery.isPending ? <p className="assistant-state" role="status">Compilando prompt…</p>
                : promptQuery.isError ? <p className="assistant-feedback is-error" role="alert">No se pudo cargar el prompt compilado.</p>
                  : promptQuery.data && <section className="assistant-prompt" aria-labelledby="assistant-prompt-title">
                    <h2 id="assistant-prompt-title">Prompt compilado · {promptQuery.data.nombre}</h2>
                    {promptQuery.data.descripcion && <p>{promptQuery.data.descripcion}</p>}
                    <pre>{promptQuery.data.prompt}</pre>
                  </section>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
