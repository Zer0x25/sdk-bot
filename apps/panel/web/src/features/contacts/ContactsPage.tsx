import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MessageCircleMore, RefreshCw, Search, UsersRound } from 'lucide-react';
import {
  getAutomationProfiles,
  getAccounts,
  getConversations,
  getSession,
  PanelApiError,
  updateConversationSettings,
  type Channel,
  type Conversation,
  type ConversationControl,
  type PageCursor,
  type UpdateConversationRequest
} from '../inbox/api';
import { useInfiniteScroll } from '../../shared/useInfiniteScroll';

type ContactUpdate =
  | { conversation: Conversation; kind: 'access'; value: ConversationControl['accessPolicy'] }
  | { conversation: Conversation; kind: 'profile'; value: string | null };

const channelLabels: Record<Channel, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram' };
const accessLabels: Record<ConversationControl['accessPolicy'], string> = {
  allowed: 'Permitido', ignored: 'Ignorado', neutral: 'Neutro'
};

function asError(value: unknown) {
  return value instanceof Error ? value : new Error('No se pudo cargar el contenido.');
}

export function ContactsPage() {
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState<Channel | ''>('');
  const [updateError, setUpdateError] = useState<string | null>(null);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchText.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const sessionQuery = useQuery({
    queryKey: ['contacts', 'session'],
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000
  });
  const profilesQuery = useQuery({
    queryKey: ['contacts', 'profiles'],
    queryFn: ({ signal }) => getAutomationProfiles(signal),
    staleTime: 30_000
  });
  const accountsQuery = useQuery({
    queryKey: ['contacts', 'accounts'],
    queryFn: ({ signal }) => getAccounts(signal),
    staleTime: 30_000
  });
  const conversationsQuery = useInfiniteQuery({
    queryKey: ['contacts', 'conversations', search, channel],
    initialPageParam: undefined as PageCursor | undefined,
    queryFn: ({ pageParam, signal }) => getConversations({
      search: search || undefined,
      channel: channel || undefined,
      cursor: pageParam
    }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 5_000
  });
  const nextPageError = conversationsQuery.isFetchNextPageError
    ? asError(conversationsQuery.error)
    : null;
  const expiredContactsCursor = nextPageError instanceof PanelApiError
    && (nextPageError.code === 'CURSOR_EXPIRED' || nextPageError.code === 'DATA_EPOCH_MISMATCH');
  const loadMoreRef = useInfiniteScroll(tableWrapRef, {
    enabled: Boolean(conversationsQuery.hasNextPage && !nextPageError),
    loading: conversationsQuery.isFetchingNextPage,
    onLoadMore: () => conversationsQuery.fetchNextPage()
  });

  useEffect(() => {
    tableWrapRef.current?.scrollTo?.({ top: 0 });
  }, [search, channel]);

  const updateMutation = useMutation({
    mutationFn: ({ conversation, kind, value }: ContactUpdate) => {
      const request: UpdateConversationRequest = {
        expectedVersion: conversation.control.controlVersion,
        ...(kind === 'access' ? { accessPolicy: value as ConversationControl['accessPolicy'] }
          : { profileKey: value as string | null })
      };
      return updateConversationSettings(conversation.id, request);
    },
    onSuccess: () => {
      setUpdateError(null);
      void queryClient.invalidateQueries({ queryKey: ['contacts', 'conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: error => {
      setUpdateError(asError(error).message);
      void queryClient.invalidateQueries({ queryKey: ['contacts', 'conversations'] });
    }
  });

  const conversations = conversationsQuery.data?.pages.flatMap(page => page.items) ?? [];
  const canManage = sessionQuery.data?.actor.capabilities.includes('conversations:write') === true;
  const busyFor = (conversationId: string) => updateMutation.isPending
    && updateMutation.variables?.conversation.id === conversationId;

  function saveAccess(conversation: Conversation, value: string) {
    if (!['allowed', 'ignored', 'neutral'].includes(value)) return;
    updateMutation.mutate({ conversation, kind: 'access', value: value as ConversationControl['accessPolicy'] });
  }

  function saveProfile(conversation: Conversation, value: string) {
    updateMutation.mutate({ conversation, kind: 'profile', value: value || null });
  }

  function retryNextPage() {
    if (nextPageError instanceof PanelApiError
      && (nextPageError.code === 'CURSOR_EXPIRED' || nextPageError.code === 'DATA_EPOCH_MISMATCH')) {
      void queryClient.resetQueries({ queryKey: ['contacts', 'conversations', search, channel] });
      return;
    }
    void conversationsQuery.fetchNextPage();
  }

  return (
    <section className="contacts-page" aria-labelledby="contacts-title">
      <header className="contacts-header">
        <div>
          <p className="eyebrow"><UsersRound aria-hidden="true" size={14} /> Directorio de conversaciones</p>
          <h1 id="contacts-title">Contactos</h1>
          <p className="contacts-subtitle">Gestiona el permiso y el perfil IA desde el mismo control que usa la bandeja.</p>
        </div>
      </header>

      <p className="contacts-privacy-note">
        Solo aparecen contactos con una conversación archivada. Los teléfonos y las identidades técnicas del canal no se muestran.
      </p>

      <div className="contacts-toolbar">
        <label className="contacts-search">
          <Search aria-hidden="true" size={16} />
          <span className="visually-hidden">Buscar contactos</span>
          <input type="search" value={searchText} onChange={event => setSearchText(event.currentTarget.value)}
            placeholder="Buscar por nombre" />
        </label>
        <label className="contacts-channel-filter">
          <span>Canal</span>
          <select aria-label="Filtrar contactos por canal" value={channel}
            onChange={event => setChannel(event.currentTarget.value as Channel | '')}>
            <option value="">Todos</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="telegram">Telegram</option>
          </select>
        </label>
        {sessionQuery.isPending ? <span className="contacts-permission-state">Comprobando permisos…</span>
          : sessionQuery.isError ? <span className="contacts-permission-state" role="alert">No se pudo comprobar el permiso de edición.</span>
            : !canManage && <span className="contacts-permission-state">Vista de solo lectura</span>}
      </div>

      {updateError && <div className="contacts-error" role="alert">{updateError}</div>}
      {profilesQuery.isError && (
        <div className="contacts-error" role="alert">No se pudo cargar el inventario de perfiles. Puedes conservar el perfil heredado.</div>
      )}
      {conversationsQuery.isError && conversationsQuery.data && !conversationsQuery.isFetchNextPageError && (
        <div className="contacts-error" role="alert">
          No se pudo actualizar la lista. {asError(conversationsQuery.error).message}
          <button className="text-button" type="button" onClick={() => void conversationsQuery.refetch()}>Reintentar</button>
        </div>
      )}
      <div className="contacts-results">
        {conversationsQuery.isPending && <div className="contacts-state" role="status">Cargando contactos…</div>}
        {conversationsQuery.isError && !conversationsQuery.data && (
          <div className="contacts-state contacts-state-error" role="alert">
            <div><h2>No se pudieron cargar los contactos</h2><p>{asError(conversationsQuery.error).message}</p></div>
            <button type="button" onClick={() => void conversationsQuery.refetch()}><RefreshCw aria-hidden="true" size={15} /> Reintentar</button>
          </div>
        )}

        {conversationsQuery.data && conversations.length === 0 && (
          <div className="contacts-state"><h2>No hay contactos para mostrar</h2>
            <p>{search || channel ? 'Prueba con otra búsqueda o canal.' : 'Las conversaciones nuevas aparecerán aquí cuando queden archivadas.'}</p>
          </div>
        )}

        {conversations.length > 0 && (
          <div className="contacts-table-wrap" ref={tableWrapRef} role="region" aria-label="Lista de contactos"
            aria-busy={conversationsQuery.isFetchingNextPage} tabIndex={0}>
            <table className="contacts-table">
              <thead><tr>
                <th scope="col">Contacto</th><th scope="col">Canal</th>
                <th scope="col">Permiso</th><th scope="col">Perfil IA</th><th scope="col">Conversación</th>
              </tr></thead>
              <tbody>{conversations.map(conversation => {
                const displayName = conversation.displayName?.trim() || 'Contacto sin nombre';
                const busy = busyFor(conversation.id);
                const profileKey = conversation.control.profileKey;
                const profiles = profilesQuery.data?.items ?? [];
                const profileExists = profileKey === null || profiles.some(profile => profile.key === profileKey);
                const account = accountsQuery.data?.items.find(item => item.id === conversation.accountId);
                return (
                  <tr key={conversation.id}>
                    <th scope="row">
                      <span className="contacts-name">{displayName}</span>
                      {conversation.requiresReview && <span className="contacts-review">Requiere revisión</span>}
                    </th>
                    <td>{account ? channelLabels[account.channel] : 'No disponible'}</td>
                    <td>{canManage ? (
                      <select aria-label={`Permiso de ${displayName}`} value={conversation.control.accessPolicy}
                        disabled={busy} onChange={event => saveAccess(conversation, event.currentTarget.value)}>
                        <option value="neutral">Neutro</option><option value="allowed">Permitido</option><option value="ignored">Ignorado</option>
                      </select>
                    ) : accessLabels[conversation.control.accessPolicy]}</td>
                    <td>{canManage ? (
                      <select aria-label={`Perfil IA de ${displayName}`} value={profileKey || ''}
                        disabled={busy || profilesQuery.isPending || profilesQuery.isError}
                        onChange={event => saveProfile(conversation, event.currentTarget.value)}>
                        <option value="">Heredar del sistema</option>
                        {profileKey && !profileExists && <option value={profileKey}>{profileKey} (no disponible)</option>}
                        {profiles.map(profile => <option key={profile.key} value={profile.key}>{profile.name}</option>)}
                      </select>
                    ) : profileKey || 'Heredado del sistema'}</td>
                    <td><Link className="contacts-open-link" to={`/${conversation.id}`}>
                      <MessageCircleMore aria-hidden="true" size={15} /> Abrir chat
                    </Link></td>
                  </tr>
                );
              })}
                {conversationsQuery.hasNextPage && <tr className="contacts-pagination-row"><td colSpan={5}>
                  <div className="contacts-load-more-sentinel" ref={loadMoreRef}>
                    {conversationsQuery.isFetchingNextPage ? <span role="status">Cargando contactos…</span>
                      : nextPageError ? <div className="contacts-pagination-error" role="alert">
                        <span>{nextPageError.message}</span>
                        <button className="contacts-load-more" type="button" onClick={retryNextPage}>
                          {expiredContactsCursor ? 'Actualizar lista' : 'Reintentar'}
                        </button>
                      </div>
                        : <button className="contacts-load-more" type="button" onClick={() => void conversationsQuery.fetchNextPage()}>
                          Cargar más contactos
                        </button>}
                  </div>
                </td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
