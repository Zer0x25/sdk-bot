import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { Archive, CircleHelp, MessageCircle, Search, Send, UsersRound } from 'lucide-react';
import { PanelApiError, type Account, type Channel, type Conversation } from './api';
import { BrandLabel } from '../../app/AppShell';
import { useInfiniteScroll } from '../../shared/useInfiniteScroll';
import type { StreamStatus } from './useInboxEvents';

export type InboxFilter = 'all' | 'unread' | 'open';

interface Props {
  conversationId?: string;
  conversations: Conversation[];
  accounts: Account[];
  loading: boolean;
  error: Error | null;
  moreError: Error | null;
  hasMore: boolean;
  loadingMore: boolean;
  filter: InboxFilter;
  channel: Channel | '';
  search: string;
  onFilterChange(filter: InboxFilter): void;
  onChannelChange(channel: Channel | ''): void;
  onSearchChange(value: string): void;
  onLoadMore(): void;
  onRetryMore(): void;
  onRetry(): void;
  streamStatus: StreamStatus;
}

const channelLabel: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram'
};

function activityLabel(timestamp: string | null) {
  if (!timestamp) return 'Sin actividad registrada';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Actividad reciente';
  return new Intl.DateTimeFormat('es-MX', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function modeLabel(mode: Conversation['control']['automationMode']) {
  if (mode === 'human') return 'Atención humana';
  if (mode === 'off') return 'Pausada';
  return 'Atención IA';
}

export function ConversationList(props: Props) {
  const {
    conversationId, conversations, accounts, loading, error, moreError, hasMore, loadingMore,
    filter, channel, search, onFilterChange, onChannelChange, onSearchChange,
    onLoadMore, onRetry, onRetryMore, streamStatus
  } = props;
  const listRef = useRef<HTMLUListElement | null>(null);
  const loadMoreRef = useInfiniteScroll(listRef, {
    enabled: hasMore && !loading && !loadingMore && !moreError,
    loading: loadingMore,
    onLoadMore
  });
  const accountById = new Map(accounts.map(account => [account.id, account]));
  const expiredListCursor = moreError instanceof PanelApiError && (moreError.code === 'CURSOR_EXPIRED' || moreError.code === 'DATA_EPOCH_MISMATCH');

  useEffect(() => {
    listRef.current?.scrollTo?.({ top: 0 });
  }, [filter, channel, search]);

  return (
    <section className="conversation-column" aria-label="Conversaciones">
      <header className="conversation-header">
        <div className="conversation-title-row">
          <div>
            <BrandLabel />
            <h1>Bandeja</h1>
            <p className="header-subtitle">Tus conversaciones, en un solo lugar.</p>
          </div>
          <button className="icon-button quiet-icon" type="button" aria-label="Ayuda próximamente" title="Ayuda próximamente" disabled>
            <CircleHelp aria-hidden="true" size={19} />
          </button>
        </div>
        <label className="search-field">
          <Search aria-hidden="true" size={17} />
          <span className="visually-hidden">Buscar conversaciones por contacto</span>
          <input
            type="search"
            value={search}
            maxLength={200}
            onChange={event => onSearchChange(event.target.value)}
            placeholder="Buscar por contacto"
          />
        </label>
        <div className="list-filter-row">
          <div className="list-tools" aria-label="Filtrar conversaciones">
            <button className={`filter-pill${filter === 'all' ? ' is-selected' : ''}`} type="button" aria-pressed={filter === 'all'} onClick={() => onFilterChange('all')}>Todas</button>
            <button className={`filter-pill${filter === 'unread' ? ' is-selected' : ''}`} type="button" aria-pressed={filter === 'unread'} onClick={() => onFilterChange('unread')}>No leídas</button>
            <button className={`filter-pill${filter === 'open' ? ' is-selected' : ''}`} type="button" aria-pressed={filter === 'open'} onClick={() => onFilterChange('open')}>Abiertas</button>
          </div>
          <label className="channel-filter">
            <span className="visually-hidden">Canal</span>
            <select value={channel} onChange={event => onChannelChange(event.target.value as Channel | '')}>
              <option value="">Todos los canales</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="telegram">Telegram</option>
            </select>
          </label>
        </div>
      </header>

      <div className="conversation-results" aria-live="polite" aria-busy={loading || loadingMore}>
        {loading && <p className="list-state" role="status">Cargando conversaciones…</p>}
        {!loading && error && (
          <div className="list-state list-state-error" role="alert">
            <p>{error.message}</p>
            <button className="text-button" type="button" onClick={onRetry}>Volver a intentar</button>
          </div>
        )}
        {!loading && !error && conversations.length === 0 && (
          <div className="conversation-empty" role="status">
            <div className="empty-icon-wrap"><Archive aria-hidden="true" size={20} /></div>
            <h2>{search ? 'Sin resultados' : 'Aún no hay conversaciones'}</h2>
            <p>{search ? 'Prueba otro nombre o quita alguno de los filtros.' : 'Las conversaciones archivadas aparecerán aquí cuando llegue actividad de tus canales.'}</p>
          </div>
        )}
        {!loading && !error && conversations.length > 0 && (
          <ul className="conversation-list" ref={listRef} aria-label="Resultados de conversaciones" tabIndex={0}>
            {conversations.map(conversation => {
              const account = accountById.get(conversation.accountId);
              const label = account ? channelLabel[account.channel] : 'Canal';
              const name = conversation.displayName?.trim() || 'Contacto sin nombre';
              return (
                <li key={conversation.id}>
                  <NavLink
                    className={({ isActive }) => `conversation-card${isActive || conversation.id === conversationId ? ' is-active' : ''}`}
                    to={`/${encodeURIComponent(conversation.id)}`}
                    aria-label={`${name}, ${label}${conversation.unreadCount ? `, ${conversation.unreadCount} sin leer` : ''}`}
                  >
                    <div className={`conversation-avatar ${account?.channel === 'telegram' ? 'telegram-avatar' : ''}`} aria-hidden="true">
                      {account?.channel === 'telegram' ? <Send size={17} /> : <MessageCircle size={18} />}
                    </div>
                    <div className="conversation-card-main">
                      <div className="conversation-card-top">
                        <span className="conversation-name">{name}</span>
                        <time className="conversation-time" dateTime={conversation.lastActivityAt || undefined}>{activityLabel(conversation.lastActivityAt)}</time>
                      </div>
                      <div className="conversation-card-bottom">
                        <span className="conversation-meta">{label} <span aria-hidden="true">·</span> {modeLabel(conversation.control.automationMode)}</span>
                        {conversation.unreadCount > 0 && <span className="unread-count" aria-label={`${conversation.unreadCount} sin leer`}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</span>}
                      </div>
                      {conversation.requiresReview && <span className="review-label"><UsersRound aria-hidden="true" size={12} /> Revisión pendiente</span>}
                    </div>
                  </NavLink>
                </li>
              );
            })}
            {hasMore && (
              <li className="conversation-list-sentinel">
                <div ref={loadMoreRef}>
                  {loadingMore ? <span role="status">Cargando conversaciones…</span>
                    : moreError ? (
                      <div className="inline-error list-pagination-error" role="alert">
                        <span>{moreError.message}</span>
                        <button className="text-button" type="button" onClick={onRetryMore}>
                          {expiredListCursor ? 'Actualizar lista' : 'Reintentar'}
                        </button>
                      </div>
                    ) : <button className="text-button" type="button" onClick={onLoadMore}>Cargar más conversaciones</button>}
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
      <footer className="conversation-footer">
        <span>Historial archivado</span>
        <span className="footer-divider" aria-hidden="true">·</span>
        <span className={`live-sync-status is-${streamStatus}`} role="status" aria-live="polite">
          <span className="live-sync-dot" aria-hidden="true" />
          {streamStatus === 'connected' ? 'En vivo' : streamStatus === 'reconnecting' ? 'Reconectando…' : 'Conectando…'}
        </span>
      </footer>
    </section>
  );
}
