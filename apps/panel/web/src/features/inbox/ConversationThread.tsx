import { useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Bell, Bot, MessageSquareText, Search, SendHorizontal, UserRound } from 'lucide-react';
import type { Account, Actor, Conversation, Message, PendingResumeResponse } from './api';
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
  actor?: Actor;
  account?: Account;
  canTakeover: boolean;
  canRelease: boolean;
  canResolve: boolean;
  canReopen: boolean;
  canSend: boolean;
  controlBusy: boolean;
  controlError: Error | null;
  controlNotice: string | null;
  releaseOptionsOpen: boolean;
  pendingResume?: PendingResumeResponse;
  pendingResumeLoading: boolean;
  pendingResumeError: Error | null;
  selectedPendingIds: string[];
  onTakeover(): void;
  onRelease(): void;
  onOpenPendingResume(): void;
  onTogglePendingResume(messageId: string): void;
  onReleaseFutureOnly(): void;
  onReleaseSelectedPending(): void;
  onCancelReleaseOptions(): void;
  onResolve(): void;
  onReopen(): void;
  draft: string;
  onDraftChange(value: string): void;
  sendBusy: boolean;
  sendError: Error | null;
  uncertainSend: { text: string; clientMessageId: string; state: 'in_progress' | 'delivery_unknown' } | null;
  onSubmitMessage(): void;
  onRetryUncertainSend(): void;
  onRestoreUncertainDraft(): void;
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
  if (message.deliveryStatus === 'queued') return 'En cola';
  if (message.deliveryStatus === 'sending') return 'Enviando';
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
    onMessagesSeen, onAtLatestChange, onLoadOlder, onRetryDetail, onRetryMessages, onRetryRead,
    actor, account, canTakeover, canRelease, canResolve, canReopen, canSend, controlBusy, controlError,
    controlNotice, releaseOptionsOpen, pendingResume, pendingResumeLoading, pendingResumeError, selectedPendingIds,
    onTakeover, onRelease, onOpenPendingResume, onTogglePendingResume, onReleaseFutureOnly,
    onReleaseSelectedPending, onCancelReleaseOptions, onResolve, onReopen, draft, onDraftChange, sendBusy, sendError,
    uncertainSend, onSubmitMessage, onRetryUncertainSend, onRestoreUncertainDraft
  } = props;
  const historyRef = useRef<HTMLDivElement>(null);
  const activeConversationId = useRef(conversationId);
  const previousPageCount = useRef(0);
  const previousMessageCount = useRef(0);
  const olderLoadPending = useRef(false);
  const atLatestRef = useRef(true);
  const previousScroll = useRef({ height: 0, top: 0 });
  const messageById = new Map(messages.map(message => [message.id, message]));

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

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmitMessage();
    }
  }

  const control = conversation?.control;
  const controlLabel = control?.status === 'taking_control' ? 'Tomando control…'
    : control?.automationMode === 'human' ? (control.ownerId && actor?.id === control.ownerId ? 'Atención humana · a tu cargo' : 'Atención humana')
      : control?.automationMode === 'ai' ? 'Atención IA' : 'Atención pausada';
  const uncertainSameDraft = Boolean(uncertainSend && draft.trim() === uncertainSend.text);
  const composerEnabled = Boolean(canSend && !sendBusy && draft.trim() && !uncertainSend);
  const composerStatus = !account ? 'No se encontró la cuenta del canal.'
    : account.status !== 'connected' ? 'El canal está desconectado; el borrador queda en el panel.'
      : !account.capabilities.reply ? 'Este canal no permite responder desde el panel.'
        : control?.status === 'taking_control' ? 'La toma de control todavía no está confirmada.'
          : control?.automationMode !== 'human' ? 'Toma el control para responder desde aquí.'
            : control?.lifecycle !== 'open' ? 'Reabre la conversación para responder.'
              : control?.ownerId && actor?.id !== control.ownerId && !actor?.capabilities.includes('control:override')
                ? 'La conversación pertenece a otro operador.'
                  : control?.requiresReview || conversation?.requiresReview ? 'La identidad requiere revisión antes de responder.'
                    : !actor?.capabilities.includes('messages:send') ? 'Tu cuenta no tiene permiso para enviar mensajes.' : null;

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
          <div className="thread-control-toolbar">
            <div className="thread-control-state" role="status">
              {control?.automationMode === 'human' ? <UserRound aria-hidden="true" size={15} /> : <Bot aria-hidden="true" size={15} />}
              <span>{controlLabel}</span>
            </div>
            <div className="thread-control-buttons">
              {control?.status === 'taking_control' && <span className="control-pending" role="status">Tomando control…</span>}
              {canTakeover && control?.automationMode !== 'human' && (
                <button className="thread-control-button is-primary" type="button" onClick={onTakeover} disabled={controlBusy}>
                  {controlBusy ? 'Tomando control…' : 'Tomar control'}
                </button>
              )}
              {canRelease && (
                <button className="thread-control-button" type="button" onClick={onRelease} disabled={controlBusy}>
                  {controlBusy ? 'Guardando…' : 'Devolver a IA'}
                </button>
              )}
              {canResolve && <button className="thread-control-button" type="button" onClick={onResolve} disabled={controlBusy}>Resolver</button>}
              {canReopen && <button className="thread-control-button" type="button" onClick={onReopen} disabled={controlBusy}>Reabrir</button>}
            </div>
          </div>
          {controlNotice && <div className="thread-inline-status" role="status">{controlNotice}</div>}
          {controlError && <div className="thread-inline-error" role="alert">{controlError.message}</div>}
          {releaseOptionsOpen && (
            <section className="release-policy-panel" aria-label="Elegir cómo devolver el control a la IA">
              <h3>Devolver el control a la IA</h3>
              <p>Elige si la IA atenderá solo mensajes nuevos o si procesará entradas recientes que todavía no tienen respuesta confirmada.</p>
              <div className="release-policy-actions">
                <button className="thread-control-button" type="button" onClick={onReleaseFutureOnly} disabled={controlBusy}>
                  Solo mensajes futuros
                </button>
                <button className="thread-control-button" type="button" onClick={onOpenPendingResume} disabled={controlBusy}>
                  Revisar entradas pendientes
                </button>
                <button className="text-button" type="button" onClick={onCancelReleaseOptions} disabled={controlBusy}>Cancelar</button>
              </div>
              {pendingResumeLoading && <p role="status">Buscando entradas verificables…</p>}
              {pendingResumeError && <div className="thread-inline-error" role="alert">{pendingResumeError.message}</div>}
              {pendingResume && (
                <>
                  {pendingResume.uncertainOutboundCount > 0 && (
                    <p className="release-policy-warning" role="alert">
                      Hay {pendingResume.uncertainOutboundCount} salida(s) de IA o del operador sin confirmar. No se habilita el reenvío de entradas pendientes hasta revisar esas entregas.
                    </p>
                  )}
                  {pendingResume.automationMayBeBlocked && (
                    <p className="release-policy-warning" role="status">
                      La política de acceso, la revisión de identidad o la pausa global puede impedir que la IA responda.
                    </p>
                  )}
                  <p className="release-policy-summary">
                    {pendingResume.candidateCount === 0
                      ? 'No hay entradas pendientes verificables para seleccionar.'
                      : `${pendingResume.candidateCount} entrada(s) elegible(s); elige cuáles procesar.`}
                    {pendingResume.truncated ? ' Se muestran las primeras 100.' : ''}
                  </p>
                  {(pendingResume.excludedPendingDispatchCount > 0 || pendingResume.excludedUnprocessableCount > 0) && (
                    <p className="release-policy-summary">
                      Se excluyen {pendingResume.excludedPendingDispatchCount} entrada(s) cuyo despacho sigue pendiente y {pendingResume.excludedUnprocessableCount} sin contenido procesable.
                    </p>
                  )}
                  <ul className="pending-resume-list">
                    {pendingResume.candidates.map(candidate => (
                      <li key={candidate.messageId}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedPendingIds.includes(candidate.messageId)}
                            disabled={controlBusy || pendingResume.uncertainOutboundCount > 0}
                            onChange={() => onTogglePendingResume(candidate.messageId)}
                          />
                          <span>
                            <code>{candidate.messageId}</code>
                            <small>Entrada {candidate.inboundSeq} · {formatTime(candidate.occurredAt)} · {candidate.contentType}</small>
                            <span>{candidate.preview || 'Sin texto de vista previa'}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {pendingResume.candidateCount > 0 && (
                    <button className="thread-control-button is-primary" type="button"
                      onClick={onReleaseSelectedPending}
                      disabled={controlBusy || !selectedPendingIds.length || pendingResume.uncertainOutboundCount > 0}>
                      Procesar {selectedPendingIds.length} seleccionada(s) y devolver a IA
                    </button>
                  )}
                  <p className="release-policy-summary">Las entradas antiguas no seleccionadas permanecen en el historial y no se reproducen automáticamente.</p>
                </>
              )}
            </section>
          )}
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
                {messages.map(message => {
                  const quoted = message.replyToId ? messageById.get(message.replyToId) : undefined;
                  return (
                  <li key={message.id} className={`message-row ${message.direction === 'outbound' ? 'is-outbound' : 'is-inbound'}`}>
                    <article className="message-bubble">
                      <div className="message-author">{authorNames[message.authorKind]}</div>
                      {(message.replyToId || message.replyPreview) && (
                        <blockquote className="message-quote" aria-label="Mensaje citado">
                          {quoted
                            ? quoted.deletedAt ? 'Mensaje eliminado' : messageBody(quoted.content)
                            : message.replyPreview || 'Mensaje citado no disponible'}
                        </blockquote>
                      )}
                      <p>{message.deletedAt ? 'Mensaje eliminado en el canal' : messageBody(message.content)}</p>
                      {!message.deletedAt && message.content.type !== 'text' && message.content.type !== 'oversized' && message.content.attachmentId && (
                        <a className="message-attachment-download"
                          href={`/api/v1/attachments/${encodeURIComponent(message.content.attachmentId)}`}>
                          Descargar {mediaNames[message.content.type]}
                        </a>
                      )}
                      <div className="message-metadata">
                        <time dateTime={message.occurredAt}>{formatTime(message.occurredAt)}</time>
                        {message.editedAt && <span>Editado</span>}
                        {deliveryLabel(message) && <span>{deliveryLabel(message)}</span>}
                      </div>
                    </article>
                  </li>
                  );
                })}
              </ol>
            )}
          </div>
          <footer className="composer-preview" aria-label="Compositor de mensajes">
            <form className="composer-form" onSubmit={event => { event.preventDefault(); onSubmitMessage(); }}>
              <textarea
                aria-label="Escribir mensaje"
                placeholder={composerStatus || 'Escribe una respuesta…'}
                value={draft}
                onChange={event => onDraftChange(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                maxLength={4096}
                disabled={!canSend || sendBusy}
                rows={2}
              />
              <button className="send-preview" type="submit" disabled={!composerEnabled} aria-label="Enviar mensaje">
                <SendHorizontal aria-hidden="true" size={17} />
              </button>
            </form>
            {sendBusy && <span className="composer-state" role="status">Guardando y enviando…</span>}
            {!canSend && !sendBusy && <span className="composer-state">{composerStatus}</span>}
            {sendError && <span className="composer-error" role="alert">{sendError.message}</span>}
            {uncertainSend && (
              <div className="composer-uncertain" role="alert">
                <span>{uncertainSend.state === 'in_progress'
                  ? 'El envío sigue en curso. Consulta el mismo intento para evitar crear otro mensaje.'
                  : 'Entrega sin confirmar. Revisa el chat; volver a enviar puede crear un duplicado.'}</span>
                {uncertainSend.state === 'in_progress' && (
                  <button className="text-button" type="button" onClick={onRetryUncertainSend}>Consultar estado</button>
                )}
                {uncertainSend.state === 'delivery_unknown' && uncertainSameDraft && (
                  <button className="text-button" type="button" onClick={onRetryUncertainSend}>Reintentar de todos modos</button>
                )}
                {uncertainSend.state === 'delivery_unknown' && !uncertainSameDraft && (
                  <button className="text-button" type="button" onClick={onRestoreUncertainDraft}>Restaurar borrador pendiente</button>
                )}
              </div>
            )}
          </footer>
        </>
      )}
      {conversationId && !detailLoading && !detailError && !conversation && <div className="thread-message-state" role="status">No se encontró esta conversación.</div>}
    </section>
  );
}
