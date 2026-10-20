import { useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Bell, MessageSquareText, Search } from 'lucide-react';
import type { Conversation, Message } from './api';
import { PanelApiError } from './api';

interface Props {
  conversationId?: string;
  conversation?: Conversation;
  detailLoading: boolean;
  detailError: Error | null;
  messages: Message[];
  messagePageCount: number;
  messagesLoading: boolean;
  messagesError: Error | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  readError: Error | null;
  newMessagesCount: number;
  onMessagesSeen(): void;
  onAtLatestChange(atLatest: boolean): void;
  onLoadOlder(): Promise<unknown>;
  onRetryDetail(): void;
  onRetryMessages(): void;
  onRetryRead(): void;
}

const authorNames: Record<Message['authorKind'], string> = {
  customer: 'Cliente',
  ai: 'Asistente',
  operator: 'Equipo',
  external_self: 'Enviado desde el canal',
  system: 'Sistema',
  unknown: 'Autor sin confirmar'
};

const mediaNames = {
  audio: 'Audio',
  image: 'Imagen',
  video: 'Video',
  document: 'Documento',
  unsupported: 'Archivo'
} as const;

function messageBody(content: Message['content']) {
  if (content.type === 'text') return content.text;
  if (content.type === 'oversized') return 'Este mensaje supera el límite de texto visible.';
  if (content.caption) return content.caption;
  if (content.transcript) return content.transcript;
  if (content.type === 'audio' && content.transcriptionStatus === 'pending') return 'Audio recibido · transcripción pendiente';
  if (content.availability === 'failed') return `${mediaNames[content.type]} no disponible`;
  if (content.availability === 'expired') return `${mediaNames[content.type]} vencido`;
  return `${mediaNames[content.type]} recibido`;
}

function formatTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function deliveryLabel(message: Message) {
  if (message.direction !== 'outbound') return '';
  if (message.deliveryStatus === 'failed') return 'No enviado';
  if (message.deliveryStatus === 'delivery_unknown') return 'Entrega sin confirmar';
  if (message.deliveryStatus === 'cancelled') return 'Cancelado';
  return 'Enviado';
}

function ErrorPanel({ error, onRetry, title }: { error: Error; onRetry(): void; title: string }) {
  const expired = error instanceof PanelApiError && (error.code === 'CURSOR_EXPIRED' || error.code === 'DATA_EPOCH_MISMATCH');
  return (
    <div className="thread-message-state" role="alert">
      <h3>{title}</h3>
      <p>{error.message}</p>
      <button className="text-button" type="button" onClick={onRetry}>{expired ? 'Actualizar' : 'Volver a intentar'}</button>
    </div>
  );
}

export function ConversationThread(props: Props) {
  const {
    conversationId, conversation, detailLoading, detailError, messages, messagePageCount,
    messagesLoading, messagesError, hasOlder, loadingOlder, readError, newMessagesCount,
    onMessagesSeen, onAtLatestChange, onLoadOlder, onRetryDetail, onRetryMessages, onRetryRead
  } = props;
  const historyRef = useRef<HTMLDivElement>(null);
  const activeConversationId = useRef(conversationId);
  const previousPageCount = useRef(0);
  const previousMessageCount = useRef(0);
  const olderLoadPending = useRef(false);
  const atLatestRef = useRef(true);
  const previousScroll = useRef({ height: 0, top: 0 });

  function updatePosition() {
    const container = historyRef.current;
    if (!container) return;
    const atLatest = container.scrollHeight - container.scrollTop - container.clientHeight <= 64;
    if (atLatestRef.current !== atLatest) {
      atLatestRef.current = atLatest;
      onAtLatestChange(atLatest);
    }
    if (atLatest && newMessagesCount > 0) onMessagesSeen();
  }

  function jumpToLatest() {
    const container = historyRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    updatePosition();
  }

  useLayoutEffect(() => {
    const container = historyRef.current;
    let loadedOlder = false;
    let firstSnapshot = false;
    if (activeConversationId.current !== conversationId) {
      activeConversationId.current = conversationId;
      previousPageCount.current = 0;
      previousMessageCount.current = 0;
      olderLoadPending.current = false;
      atLatestRef.current = true;
    }
    if (!container) return;

    if (olderLoadPending.current && messagePageCount > previousPageCount.current) {
      container.scrollTop = previousScroll.current.top + container.scrollHeight - previousScroll.current.height;
      olderLoadPending.current = false;
      loadedOlder = true;
    } else if (messagePageCount > 0 && previousPageCount.current === 0) {
      container.scrollTop = container.scrollHeight;
      firstSnapshot = true;
    } else if (olderLoadPending.current && !loadingOlder && messagePageCount === previousPageCount.current) {
      olderLoadPending.current = false;
    }

    if (messages.length > previousMessageCount.current && !loadedOlder && !firstSnapshot && atLatestRef.current) {
      container.scrollTop = container.scrollHeight;
    }
    previousPageCount.current = messagePageCount;
    previousMessageCount.current = messages.length;
    if (firstSnapshot || messages.length > 0) updatePosition();
  }, [conversationId, messagePageCount, messages.length, loadingOlder]);

  function handleHistoryScroll() {
    updatePosition();
  }

  async function loadOlder() {
    const container = historyRef.current;
    if (container) previousScroll.current = { height: container.scrollHeight, top: container.scrollTop };
    olderLoadPending.current = true;
    try { await onLoadOlder(); }
    catch { olderLoadPending.current = false; }
  }

  return (
    <section className={`thread-column${conversationId ? ' is-open' : ''}`} aria-label="Historial del chat">
      <header className="thread-header">
        <div className="thread-contact">
          {conversationId && <Link className="mobile-back-button" to="/" aria-label="Volver a conversaciones"><ArrowLeft aria-hidden="true" size={19} /></Link>}
          <div className="contact-avatar neutral-avatar" aria-hidden="true"><MessageSquareText size={20} /></div>
          <div>
            <h2>{detailLoading ? 'Cargando conversación…' : conversation?.displayName?.trim() || (conversationId ? 'Contacto sin nombre' : 'Selecciona un chat')}</h2>
            <p>{conversationId ? 'Historial archivado' : 'Elige una conversación para ver el historial'}</p>
          </div>
        </div>
        <div className="thread-actions">
          <button className="icon-button" type="button" aria-label="Buscar en el chat" disabled><Search aria-hidden="true" size={19} /></button>
          <button className="icon-button" type="button" aria-label="Notificaciones del chat" disabled><Bell aria-hidden="true" size={19} /></button>
        </div>
      </header>

      {!conversationId && (
        <div className="thread-empty" role="status">
          <div className="thread-empty-orbit"><MessageSquareText aria-hidden="true" size={29} strokeWidth={1.6} /></div>
          <h2>Un espacio para conversar mejor</h2>
          <p>Aquí tendrás el historial y el contexto de cada chat.</p>
          <div className="thread-capabilities" aria-label="Canales compatibles">
            <span><i className="channel-mark whatsapp-mark" aria-hidden="true" /> WhatsApp</span>
            <span><i className="channel-mark telegram-mark" aria-hidden="true" /> Telegram</span>
          </div>
        </div>
      )}

      {conversationId && detailLoading && <div className="thread-message-state" role="status">Cargando conversación…</div>}
      {conversationId && !detailLoading && detailError && <ErrorPanel error={detailError} onRetry={onRetryDetail} title="No se pudo abrir el chat" />}
      {conversationId && !detailLoading && !detailError && conversation && (
        <>
          <div className="message-history" ref={historyRef} onScroll={handleHistoryScroll} aria-busy={messagesLoading || loadingOlder}>
            {newMessagesCount > 0 && (
              <div className="new-messages-banner" role="status">
                <span>{newMessagesCount === 1 ? '1 mensaje nuevo' : `${newMessagesCount} mensajes nuevos`}</span>
                <button className="text-button" type="button" onClick={jumpToLatest}>Ver mensajes recientes</button>
              </div>
            )}
            {readError && (
              <div className="inline-error" role="alert">
                <span>No se pudo actualizar el contador local de no leídos: {readError.message}</span>
                <button className="text-button" type="button" onClick={onRetryRead}>Reintentar</button>
              </div>
            )}
            {hasOlder && messages.length > 0 && (
              <div className="older-messages-control">
                <button className="text-button" type="button" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder ? 'Cargando mensajes…' : 'Cargar mensajes anteriores'}
                </button>
              </div>
            )}
            {messagesError && messages.length > 0 && (
              <div className="inline-error" role="alert">
                <span>{messagesError.message}</span>
                <button className="text-button" type="button" onClick={onRetryMessages}>
                  {messagesError instanceof PanelApiError && (messagesError.code === 'CURSOR_EXPIRED' || messagesError.code === 'DATA_EPOCH_MISMATCH') ? 'Actualizar historial' : 'Reintentar'}
                </button>
              </div>
            )}
            {messagesLoading && messages.length === 0 && <p className="thread-message-state" role="status">Cargando mensajes…</p>}
            {!messagesLoading && messagesError && messages.length === 0 && <ErrorPanel error={messagesError} onRetry={onRetryMessages} title="No se pudo cargar el historial" />}
            {!messagesLoading && !messagesError && messages.length === 0 && (
              <div className="thread-message-state" role="status"><h3>Aún no hay mensajes archivados</h3><p>La cobertura disponible se muestra en la ficha del contacto.</p></div>
            )}
            {messages.length > 0 && (
              <ol className="message-list" role="log" aria-label="Mensajes del chat" aria-live="polite" aria-relevant="additions text">
                {messages.map(message => (
                  <li key={message.id} className={`message-row ${message.direction === 'outbound' ? 'is-outbound' : 'is-inbound'}`}>
                    <article className="message-bubble">
                      <div className="message-author">{authorNames[message.authorKind]}</div>
                      <p>{messageBody(message.content)}</p>
                      <div className="message-metadata">
                        <time dateTime={message.occurredAt}>{formatTime(message.occurredAt)}</time>
                        {deliveryLabel(message) && <span>{deliveryLabel(message)}</span>}
                      </div>
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <footer className="composer-preview" aria-label="Compositor de mensajes">
            <span>Responder desde el chat estará disponible en la fase de control humano.</span>
            <button className="send-preview" type="button" disabled aria-label="Enviar mensaje deshabilitado">↗</button>
          </footer>
        </>
      )}
      {conversationId && !detailLoading && !detailError && !conversation && <div className="thread-message-state" role="status">No se encontró esta conversación.</div>}
    </section>
  );
}
