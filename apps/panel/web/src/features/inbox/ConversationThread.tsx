import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Bell, Bot, MessageSquareText, Search, SendHorizontal, Sparkles, UserRound } from 'lucide-react';
import type { Account, Actor, Conversation, ConversationAssistanceResponse, Message, MessageSearchHit,
  OutboundReconciliationItem, PendingResumeResponse } from './api';
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
  messageSearchInput: string;
  messageSearchTerm: string;
  messageSearchHits: MessageSearchHit[];
  messageSearchLoading: boolean;
  messageSearchError: Error | null;
  messageSearchHasMore: boolean;
  messageSearchLoadingMore: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  readError: Error | null;
  newMessagesCount: number;
  onMessagesSeen(): void;
  onAtLatestChange(atLatest: boolean): void;
  onLoadOlder(): Promise<unknown>;
  onFocusAssistanceReference(messageId: string): Promise<void>;
  onRetryDetail(): void;
  onRetryMessages(): void;
  onMessageSearchInputChange(value: string): void;
  onLoadMoreMessageSearch(): Promise<unknown>;
  onRetryMessageSearch(): void;
  onRetryRead(): void;
  actor?: Actor;
  account?: Account;
  canTakeover: boolean;
  canRelease: boolean;
  canResolve: boolean;
  canReopen: boolean;
  canSend: boolean;
  canAssist: boolean;
  assistance?: ConversationAssistanceResponse;
  assistanceLoading: boolean;
  assistanceError: Error | null;
  onPrepareAssistance(): void;
  onUseAssistedDraft(text: string): void;
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
  canReconcile: boolean;
  reconciliationOpen: boolean;
  outboundReconciliations: OutboundReconciliationItem[];
  reconciliationLoading: boolean;
  reconciliationError: Error | null;
  reconcilingIntentId: string | null;
  reconciliationHasMore: boolean;
  onOpenReconciliations(): void;
  onCloseReconciliations(): void;
  onLoadMoreReconciliations(): void;
  onReconcileOutbound(item: OutboundReconciliationItem, decision: 'accepted' | 'rejected', note: string, providerMessageId?: string): void;
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

function formatSearchTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'short', timeStyle: 'short' }).format(date);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [reconciliationDrafts, setReconciliationDrafts] = useState<Record<string, { note: string; providerMessageId: string }>>({});
  const {
    conversationId, conversation, detailLoading, detailError, messages, messagePageCount,
    messagesLoading, messagesError, messageSearchInput, messageSearchTerm, messageSearchHits,
    messageSearchLoading, messageSearchError, messageSearchHasMore, messageSearchLoadingMore,
    hasOlder, loadingOlder, readError, newMessagesCount,
    onMessagesSeen, onAtLatestChange, onLoadOlder, onRetryDetail, onRetryMessages, onRetryRead,
    onMessageSearchInputChange, onLoadMoreMessageSearch, onRetryMessageSearch,
    actor, account, canTakeover, canRelease, canResolve, canReopen, canSend, canAssist, assistance,
    assistanceLoading, assistanceError, onPrepareAssistance, onUseAssistedDraft, controlBusy, controlError,
    controlNotice, releaseOptionsOpen, pendingResume, pendingResumeLoading, pendingResumeError, selectedPendingIds,
    onTakeover, onRelease, onOpenPendingResume, onTogglePendingResume, onReleaseFutureOnly,
    onReleaseSelectedPending, onCancelReleaseOptions, onResolve, onReopen, draft, onDraftChange, sendBusy, sendError,
    uncertainSend, onSubmitMessage, onRetryUncertainSend, onRestoreUncertainDraft, canReconcile, reconciliationOpen,
    outboundReconciliations, reconciliationLoading, reconciliationError, reconcilingIntentId, reconciliationHasMore,
    onOpenReconciliations, onCloseReconciliations, onLoadMoreReconciliations, onReconcileOutbound
  } = props;
  const historyRef = useRef<HTMLDivElement>(null);
  const activeConversationId = useRef(conversationId);
  const previousPageCount = useRef(0);
  const previousMessageCount = useRef(0);
  const olderLoadPending = useRef(false);
  const atLatestRef = useRef(true);
  const previousScroll = useRef({ height: 0, top: 0 });
  const messageById = new Map(messages.map(message => [message.id, message]));

  useEffect(() => {
    setSearchOpen(false);
    onMessageSearchInputChange('');
  }, [conversationId, onMessageSearchInputChange]);

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

  function reconciliationDraft(item: OutboundReconciliationItem) {
    return reconciliationDrafts[item.id] ?? { note: '', providerMessageId: '' };
  }

  function updateReconciliationDraft(itemId: string, field: 'note' | 'providerMessageId', value: string) {
    setReconciliationDrafts(previous => ({ ...previous,
      [itemId]: { note: previous[itemId]?.note ?? '', providerMessageId: previous[itemId]?.providerMessageId ?? '', [field]: value }
    }));
  }

  function matchingArchivedMessages(item: OutboundReconciliationItem) {
    const sentAfter = item.sendingAt ? Date.parse(item.sendingAt) : Date.parse(item.createdAt);
    return messages.filter(message => message.direction === 'outbound' && message.authorKind === 'external_self'
      && message.content.type === 'text' && message.content.text === item.text && Boolean(message.providerMessageId)
      && Date.parse(message.ingestedAt) >= sentAfter);
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
          <button className={`icon-button${searchOpen ? ' is-active' : ''}`} type="button" aria-label="Buscar en el chat"
            aria-expanded={searchOpen} disabled={!conversationId} onClick={() => {
              setSearchOpen(open => {
                if (open) onMessageSearchInputChange('');
                return !open;
              });
            }}><Search aria-hidden="true" size={19} /></button>
          <button className="icon-button" type="button" aria-label="Notificaciones del chat" disabled><Bell aria-hidden="true" size={19} /></button>
        </div>
      </header>

      {conversationId && searchOpen && (
        <section className="thread-search-panel" role="search" aria-label="Buscar mensajes de esta conversación">
          <label className="thread-search-field" htmlFor="thread-message-search">
            <Search aria-hidden="true" size={16} />
            <input id="thread-message-search" type="search" maxLength={256} value={messageSearchInput}
              placeholder="Buscar palabras en este chat" onChange={event => onMessageSearchInputChange(event.target.value)} />
            {messageSearchInput && <button className="text-button" type="button" onClick={() => onMessageSearchInputChange('')}>Limpiar</button>}
          </label>
          {messageSearchInput.trim().length > 0 && messageSearchInput.trim() !== messageSearchTerm && (
            <p className="thread-search-hint" role="status">Preparando búsqueda…</p>
          )}
          {messageSearchTerm && messageSearchInput.trim() === messageSearchTerm && (
            <>
              {messageSearchLoading && <p className="thread-search-hint" role="status">Buscando mensajes…</p>}
              {messageSearchError && <ErrorPanel error={messageSearchError} onRetry={onRetryMessageSearch} title="No se pudo buscar" />}
              {!messageSearchLoading && !messageSearchError && messageSearchHits.length === 0 && (
                <p className="thread-search-hint" role="status">No hay mensajes que coincidan.</p>
              )}
              {messageSearchHits.length > 0 && (
                <ul className="thread-search-results" aria-label="Coincidencias">
                  {messageSearchHits.map(hit => (
                    <li key={hit.message.id}>
                      <span className="thread-search-meta">{authorNames[hit.message.authorKind]} · {formatSearchTime(hit.message.occurredAt)}</span>
                      <p>{hit.snippet}</p>
                    </li>
                  ))}
                </ul>
              )}
              {messageSearchHasMore && (
                <button className="text-button thread-search-more" type="button" disabled={messageSearchLoadingMore}
                  onClick={() => { void onLoadMoreMessageSearch(); }}>
                  {messageSearchLoadingMore ? 'Cargando…' : 'Cargar más resultados'}
                </button>
              )}
            </>
          )}
        </section>
      )}

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
              {canAssist && (
                <button className="thread-control-button" type="button" onClick={onPrepareAssistance}
                  disabled={assistanceLoading || messagesLoading || messages.length === 0}>
                  <Sparkles aria-hidden="true" size={15} />
                  {assistanceLoading ? 'Preparando…' : 'Preparar resumen y borrador'}
                </button>
              )}
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
          {canAssist && <p className="assistant-disclosure">Al preparar la asistencia, el contexto reciente se enviará al Brain y proveedor configurados. Si hace falta, el Gateway buscará hasta cinco fragmentos anteriores de este mismo hilo. El resumen y el borrador no se guardan ni se envían al canal.</p>}
          {assistanceError && <div className="thread-inline-error" role="alert">{assistanceError.message}</div>}
          {assistance && (
            <section className="conversation-assistance-panel" aria-label="Resumen y borrador de asistencia">
              <div className="assistance-heading">
                <h3>Resumen del hilo</h3>
              </div>
              <ol className="assistance-summary-list">
                {assistance.summaryPoints.map((point, index) => (
                  <li key={`${index}-${point.references[0]?.messageId}`}>
                    <p>{point.text}</p>
                    <div className="assistance-citations" aria-label="Referencias del resumen">
                      {point.references.map(reference => (
                        <button key={reference.messageId} className="assistance-citation" type="button"
                          onClick={() => { void props.onFocusAssistanceReference(reference.messageId); }}
                          title={`Mensaje ${reference.messageId}`}>
                          {authorNames[reference.authorKind]} · {formatSearchTime(reference.occurredAt)}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              <div className="assistance-draft">
                <h4>Borrador de respuesta</h4>
                <p>{assistance.draft}</p>
                <div className="assistance-citations" aria-label="Referencias del borrador">
                  {assistance.draftReferences.map(reference => (
                    <button key={reference.messageId} className="assistance-citation" type="button"
                      onClick={() => { void props.onFocusAssistanceReference(reference.messageId); }}
                      title={`Mensaje ${reference.messageId}`}>
                      {authorNames[reference.authorKind]} · {formatSearchTime(reference.occurredAt)}
                    </button>
                  ))}
                </div>
                <button className="thread-control-button is-primary" type="button" onClick={() => onUseAssistedDraft(assistance.draft)}>
                  Usar borrador en el compositor
                </button>
              </div>
            </section>
          )}
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
                    <div className="release-policy-warning" role="alert">
                      <p>Hay {pendingResume.uncertainOutboundCount} salida(s) de IA o del operador sin confirmar. No se habilita el procesamiento de entradas pendientes hasta revisar esas entregas.</p>
                      {actor?.capabilities.includes('conversations:read') && (
                        <button className="text-button" type="button" onClick={onOpenReconciliations}>
                          Revisar entregas inciertas
                        </button>
                      )}
                    </div>
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
          {outboundReconciliations.length > 0 && !reconciliationOpen && (
            <div className="composer-uncertain" role="alert">
              <span>Hay {outboundReconciliations.length} salida(s) sin confirmar. Revisa el resultado antes de repetir el mismo mensaje.</span>
              <button className="text-button" type="button" onClick={onOpenReconciliations}>Revisar entregas</button>
            </div>
          )}
          {reconciliationOpen && (
            <section className="outbound-reconciliation-panel" aria-label="Conciliar entregas inciertas">
              <header>
                <h3>Entregas que requieren revisión</h3>
                <button className="text-button" type="button" onClick={onCloseReconciliations}>Cerrar</button>
              </header>
              <p>La decisión queda auditada y no envía mensajes. Para marcar una salida como aceptada, confirma su ID remoto; para rechazarla, deja una nota con la evidencia revisada.</p>
              {reconciliationLoading && <p role="status">Cargando entregas inciertas…</p>}
              {reconciliationError && <div className="thread-inline-error" role="alert">{reconciliationError.message}</div>}
              {!reconciliationLoading && !reconciliationError && outboundReconciliations.length === 0 && (
                <p role="status">No quedan entregas inciertas en esta conversación.</p>
              )}
              <ul className="outbound-reconciliation-list">
                {outboundReconciliations.map(item => {
                  const value = reconciliationDraft(item);
                  const archivedCandidates = matchingArchivedMessages(item);
                  const busy = reconcilingIntentId === item.id;
                  const note = value.note.trim();
                  const providerMessageId = value.providerMessageId.trim();
                  return (
                    <li key={item.id}>
                      <p><strong>{item.source === 'ai' ? 'Salida de IA' : 'Salida del operador'}</strong> · {formatSearchTime(item.sendingAt ?? item.createdAt)}</p>
                      {item.text === null
                        ? <p>El contenido venció por retención. Verifica el canal y registra la decisión con una nota.</p>
                        : <blockquote>{item.text}</blockquote>}
                      {item.errorCode && <small>Código registrado: {item.errorCode}</small>}
                      <label>
                        ID remoto archivado
                        <select aria-label={`ID remoto archivado para ${item.id}`} value={providerMessageId}
                          onChange={event => updateReconciliationDraft(item.id, 'providerMessageId', event.target.value)} disabled={!canReconcile || busy}>
                          <option value="">Selecciona si el mensaje aparece en el historial</option>
                          {archivedCandidates.map(message => <option key={message.id} value={message.providerMessageId!}>
                            {message.providerMessageId} · {formatSearchTime(message.ingestedAt)}
                          </option>)}
                        </select>
                      </label>
                      <label>
                        ID remoto (si el eco aún no está cargado)
                        <input aria-label={`ID remoto manual para ${item.id}`} value={value.providerMessageId}
                          onChange={event => updateReconciliationDraft(item.id, 'providerMessageId', event.target.value)}
                          maxLength={256} disabled={!canReconcile || busy} />
                      </label>
                      <label>
                        Nota de revisión
                        <textarea aria-label={`Nota de revisión para ${item.id}`} value={value.note}
                          onChange={event => updateReconciliationDraft(item.id, 'note', event.target.value)}
                          maxLength={500} disabled={!canReconcile || busy} />
                      </label>
                      {!canReconcile && <small>Tu sesión puede revisar esta lista, pero no tiene permiso para registrar la decisión.</small>}
                      <div className="release-policy-actions">
                        <button className="thread-control-button is-primary" type="button" disabled={!canReconcile || busy || !note || !providerMessageId}
                          onClick={() => onReconcileOutbound(item, 'accepted', value.note, providerMessageId)}>
                          {busy ? 'Guardando…' : 'Registrar como aceptada'}
                        </button>
                        <button className="thread-control-button" type="button" disabled={!canReconcile || busy || !note}
                          onClick={() => onReconcileOutbound(item, 'rejected', value.note)}>
                          Registrar como no enviada
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {reconciliationHasMore && <button className="text-button" type="button" onClick={onLoadMoreReconciliations} disabled={reconciliationLoading}>
                Cargar más entregas
              </button>}
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
                    <article id={`thread-message-${message.id}`} className="message-bubble" tabIndex={-1}>
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
                {uncertainSend.state === 'delivery_unknown' && uncertainSameDraft && actor?.capabilities.includes('conversations:read') && (
                  <button className="text-button" type="button" onClick={onOpenReconciliations}>Conciliar antes de enviar otra vez</button>
                )}
                {uncertainSend.state === 'delivery_unknown' && !uncertainSameDraft && actor?.capabilities.includes('conversations:read') && (
                  <>
                    <button className="text-button" type="button" onClick={onOpenReconciliations}>Conciliar antes de enviar otra vez</button>
                    <button className="text-button" type="button" onClick={onRestoreUncertainDraft}>Restaurar borrador pendiente</button>
                  </>
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
