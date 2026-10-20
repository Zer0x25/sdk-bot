import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ConversationDetails } from './ConversationDetails';
import { ConversationList, type InboxFilter } from './ConversationList';
import { ConversationThread } from './ConversationThread';
import { useInboxEvents } from './useInboxEvents';
import {
  getAccounts,
  getConversation,
  getConversations,
  getOperation,
  getSession,
  markConversationRead,
  PanelApiError,
  releaseConversation,
  sendConversationMessage,
  takeoverConversation,
  updateConversationLifecycle,
  type ControlResponse,
  getMessages,
  type Message,
  type Channel,
  type PageCursor
} from './api';

function asError(value: unknown) {
  return value instanceof Error ? value : new Error('No se pudo cargar el contenido.');
}

export function InboxPage() {
  const { conversationId } = useParams();
  const queryClient = useQueryClient();
  const live = useInboxEvents(conversationId);
  const readAttempt = useRef<string | null>(null);
  const activeConversationId = useRef(conversationId);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [channel, setChannel] = useState<Channel | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([]);
  const [uncertainSends, setUncertainSends] = useState<Array<{
    conversationId: string; text: string; clientMessageId: string; state: 'in_progress' | 'delivery_unknown';
  }>>([]);
  const [pendingTakeoverId, setPendingTakeoverId] = useState<string | null>(null);
  const [controlNotice, setControlNotice] = useState<string | null>(null);

  const sessionQuery = useQuery({
    queryKey: ['inbox', 'session'],
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000
  });

  const pendingTakeoverQuery = useQuery({
    queryKey: ['inbox', 'operation', pendingTakeoverId],
    queryFn: ({ signal }) => getOperation(pendingTakeoverId!, signal),
    enabled: Boolean(pendingTakeoverId),
    refetchInterval: query => !query.state.data || query.state.data.status === 'taking_control' ? 1000 : false
  });

  useEffect(() => {
    activeConversationId.current = conversationId;
    setIsAtLatest(true);
    readAttempt.current = null;
  }, [conversationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const filters = useMemo(() => ({
    search: search || undefined,
    unreadOnly: filter === 'unread' || undefined,
    lifecycle: filter === 'open' ? 'open' as const : undefined,
    channel: channel || undefined
  }), [search, filter, channel]);

  const accountsQuery = useQuery({
    queryKey: ['inbox', 'accounts'],
    queryFn: ({ signal }) => getAccounts(signal),
    staleTime: 30_000
  });

  const conversationsQuery = useInfiniteQuery({
    queryKey: ['inbox', 'conversations', filters],
    initialPageParam: undefined as PageCursor | undefined,
    queryFn: ({ pageParam, signal }) => getConversations({ ...filters, cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 5_000
  });

  const conversationQuery = useQuery({
    queryKey: ['inbox', 'conversation', conversationId],
    queryFn: ({ signal }) => getConversation(conversationId!, signal),
    enabled: Boolean(conversationId),
    staleTime: 5_000
  });

  const messagesQuery = useInfiniteQuery({
    queryKey: ['inbox', 'messages', conversationId],
    initialPageParam: undefined as PageCursor | undefined,
    queryFn: ({ pageParam, signal }) => getMessages(conversationId!, { cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: Boolean(conversationId),
    staleTime: 5_000
  });

  const conversations = conversationsQuery.data?.pages.flatMap(page => page.items) ?? [];
  const messagePages = messagesQuery.data?.pages ?? [];
  const liveMessagesQuery = useQuery({
    queryKey: ['inbox', 'live-messages', conversationId],
    queryFn: ({ signal }) => getMessages(conversationId!, {}, signal),
    enabled: false
  });
  // Live refreshes only fetch the newest page; older paged history stays cached.
  const archivedMessages = [...messagePages].reverse().flatMap(page => page.items);
  const messages = [...new Map([...archivedMessages, ...(liveMessagesQuery.data?.items ?? [])]
    .map(message => [message.id, message] as const)).values()]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  const confirmedClientMessageIds = new Set(messages.map(message => message.clientMessageId).filter((id): id is string => Boolean(id)));
  const visibleOptimisticMessages = optimisticMessages.filter(message => message.conversationId === conversationId
    && !confirmedClientMessageIds.has(message.clientMessageId || ''));
  const visibleMessages = [...messages, ...visibleOptimisticMessages]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  const selectedConversation = conversationQuery.data?.conversation;
  const accounts = accountsQuery.data?.items ?? [];
  const selectedAccount = accounts.find(account => account.id === selectedConversation?.accountId);
  const conversationError = conversationQuery.isError ? asError(conversationQuery.error) : null;
  const messageError = messagesQuery.isError
    ? asError(messagesQuery.error)
    : liveMessagesQuery.isError ? asError(liveMessagesQuery.error) : null;
  const listError = !conversationsQuery.data && conversationsQuery.isError
    ? asError(conversationsQuery.error)
    : null;
  const moreError = conversationsQuery.isFetchNextPageError ? asError(conversationsQuery.error) : null;
  const latestInboundSeq = messages.reduce<string | null>((latest, message) => {
    if (message.direction !== 'inbound' || !message.inboundSeq) return latest;
    return latest === null || BigInt(message.inboundSeq) > BigInt(latest) ? message.inboundSeq : latest;
  }, null);

  useEffect(() => {
    if (!conversationId) {
      setPendingTakeoverId(null);
      setControlNotice(null);
      return;
    }
    setDraft('');
    setPendingTakeoverId(null);
    setControlNotice(null);
  }, [conversationId]);

  useEffect(() => {
    const operation = pendingTakeoverQuery.data;
    if (!operation || operation.id !== pendingTakeoverId) return;
    if (operation.status === 'completed') {
      setPendingTakeoverId(null);
      setControlNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'conversation', operation.conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'conversations'] });
    } else if (operation.status === 'failed') {
      setPendingTakeoverId(null);
      setControlNotice('No se pudo completar la toma de control. Actualiza la conversación.');
    }
  }, [pendingTakeoverId, pendingTakeoverQuery.data, queryClient]);

  useEffect(() => {
    if (selectedConversation?.control.status !== 'taking_control') setControlNotice(null);
  }, [selectedConversation?.control.status]);

  const readMutation = useMutation({
    mutationFn: (input: { conversationId: string; throughInboundSeq: string }) => markConversationRead(input.conversationId, input.throughInboundSeq),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'conversation', input.conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'conversations'] });
    },
    onError: (_error, input) => {
      const key = `${input.conversationId}:${input.throughInboundSeq}`;
      if (readAttempt.current === key) readAttempt.current = null;
    }
  });

  function sendReadCursor() {
    if (!conversationId || !latestInboundSeq) return;
    const key = `${conversationId}:${latestInboundSeq}`;
    readAttempt.current = key;
    readMutation.mutate({ conversationId, throughInboundSeq: latestInboundSeq });
  }

  useEffect(() => {
    if (!conversationId || !selectedConversation || selectedConversation.unreadCount === 0
      || !latestInboundSeq || messagesQuery.isLoading || !isAtLatest) return;
    const key = `${conversationId}:${latestInboundSeq}`;
    if (readAttempt.current === key) return;
    sendReadCursor();
  }, [conversationId, selectedConversation?.unreadCount, latestInboundSeq, messagesQuery.isLoading, isAtLatest]);

  const readError = readMutation.isError && readMutation.variables?.conversationId === conversationId
    ? asError(readMutation.error)
    : null;

  const controlMutation = useMutation<ControlResponse, Error, {
    action: 'takeover' | 'release' | 'resolve' | 'reopen'; conversationId: string; expectedVersion: string; overrideOwner: boolean;
  }>({
    mutationFn: async input => {
      if (input.action === 'takeover') return takeoverConversation(input.conversationId, input.expectedVersion, input.overrideOwner);
      if (input.action === 'release') return releaseConversation(input.conversationId, input.expectedVersion, input.overrideOwner);
      return updateConversationLifecycle(input.conversationId, input.expectedVersion, input.action === 'resolve' ? 'resolved' : 'open');
    },
    onSuccess: async result => {
      setControlNotice(null);
      if ('operation' in result) {
        setPendingTakeoverId(result.operation.id);
        setControlNotice('La toma de control está esperando que terminen los envíos anteriores.');
      } else {
        const changedConversationId = result.conversation.id;
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['inbox', 'conversation', changedConversationId] }),
          queryClient.invalidateQueries({ queryKey: ['inbox', 'conversations'] })
        ]);
      }
    }
  });

  function runControlAction(action: 'takeover' | 'release' | 'resolve' | 'reopen') {
    if (!conversationId || !selectedConversation) return;
    controlMutation.reset();
    controlMutation.mutate({ action, conversationId, expectedVersion: selectedConversation.control.controlVersion,
      overrideOwner: Boolean((action === 'takeover' || action === 'release')
        && selectedConversation.control.ownerId
        && selectedConversation.control.ownerId !== sessionQuery.data?.actor.id
        && sessionQuery.data?.actor.capabilities.includes('control:override')) });
  }

  const sendMutation = useMutation<Awaited<ReturnType<typeof sendConversationMessage>>, Error,
    { conversationId: string; text: string; clientMessageId: string; expectedVersion: string; handledThroughInboundSeq?: string }>({
    mutationFn: variables => sendConversationMessage(variables.conversationId, {
      expectedVersion: variables.expectedVersion,
      clientMessageId: variables.clientMessageId,
      text: variables.text,
      ...(variables.handledThroughInboundSeq ? { handledThroughInboundSeq: variables.handledThroughInboundSeq } : {})
    }),
    onMutate: variables => {
      const occurredAt = new Date().toISOString();
      const optimistic: Message = {
        id: variables.clientMessageId,
        conversationId: variables.conversationId,
        providerMessageId: null,
        clientMessageId: variables.clientMessageId,
        inboundSeq: null,
        direction: 'outbound',
        authorKind: 'operator',
        actorId: sessionQuery.data?.actor.id ?? null,
        content: { type: 'text', text: variables.text },
        occurredAt,
        ingestedAt: occurredAt,
        deliveryStatus: 'sending',
        replyToId: null,
        source: 'panel',
        deduplicationQuality: 'unknown'
      };
      setOptimisticMessages(previous => [...previous.filter(message => message.clientMessageId !== variables.clientMessageId), optimistic]);
    },
    onSuccess: (_result, variables) => {
      if (activeConversationId.current === variables.conversationId) setDraft(current => current === variables.text ? '' : current);
      setUncertainSends(previous => previous.filter(item => item.clientMessageId !== variables.clientMessageId
        || item.conversationId !== variables.conversationId));
      setOptimisticMessages(previous => previous.map(message => message.clientMessageId === variables.clientMessageId
        ? { ...message, deliveryStatus: 'sent' } : message));
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox', 'conversation', variables.conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['inbox', 'conversations'] }),
        queryClient.fetchQuery({
          queryKey: ['inbox', 'live-messages', variables.conversationId],
          queryFn: () => getMessages(variables.conversationId, {}),
          staleTime: 0
        })
      ]).catch(() => undefined);
    },
    onError: (error, variables) => {
      const inProgress = error instanceof PanelApiError && error.code === 'OUTBOUND_IN_PROGRESS';
      const deliveryUnknown = error instanceof PanelApiError
        && (error.code === 'OUTBOUND_DELIVERY_UNKNOWN' || error.status === 0 || error.status >= 500);
      if (inProgress || deliveryUnknown) {
        const state = inProgress ? 'in_progress' : 'delivery_unknown';
        setUncertainSends(previous => [...previous.filter(item => item.clientMessageId !== variables.clientMessageId
          || item.conversationId !== variables.conversationId), {
          conversationId: variables.conversationId,
          text: variables.text,
          clientMessageId: variables.clientMessageId,
          state
        }]);
        setOptimisticMessages(previous => previous.map(message => message.clientMessageId === variables.clientMessageId
          ? { ...message, deliveryStatus: inProgress ? 'sending' : 'delivery_unknown' } : message));
      } else {
        setUncertainSends(previous => previous.filter(item => item.clientMessageId !== variables.clientMessageId
          || item.conversationId !== variables.conversationId));
        setOptimisticMessages(previous => previous.filter(message => message.clientMessageId !== variables.clientMessageId));
      }
    }
  });

  useEffect(() => {
    if (!messages.length) return;
    const confirmed = new Set(messages.map(message => message.clientMessageId).filter((id): id is string => Boolean(id)));
    if (!confirmed.size) return;
    setOptimisticMessages(previous => {
      const next = previous.filter(message => !message.clientMessageId || !confirmed.has(message.clientMessageId));
      return next.length === previous.length ? previous : next;
    });
    const delivered = uncertainSends.filter(item => item.conversationId === conversationId && confirmed.has(item.clientMessageId));
    if (!delivered.length) return;
    setUncertainSends(previous => previous.filter(item => item.conversationId !== conversationId || !confirmed.has(item.clientMessageId)));
    if (delivered.some(item => item.text === draft)) setDraft('');
  }, [messages, conversationId, uncertainSends, draft]);

  function submitMessage(text = draft, clientMessageId: string = crypto.randomUUID(), retryConfirmed = false) {
    if (!conversationId || !selectedConversation || !text.trim()
      || sendMutation.isPending && sendMutation.variables?.conversationId === conversationId) return;
    if (uncertainSends.some(item => item.conversationId === conversationId) && !retryConfirmed) return;
    setControlNotice(null);
    sendMutation.mutate({
      conversationId,
      text,
      clientMessageId,
      expectedVersion: selectedConversation.control.controlVersion,
      ...(latestInboundSeq && isAtLatest ? { handledThroughInboundSeq: latestInboundSeq } : {})
    });
  }

  function retryUncertainSend() {
    const uncertainSend = uncertainSends.find(item => item.conversationId === conversationId);
    if (!uncertainSend) return;
    if (uncertainSend.state === 'in_progress') {
      submitMessage(uncertainSend.text, uncertainSend.clientMessageId, true);
      return;
    }
    if (!window.confirm('El proveedor pudo haber enviado el mensaje. Reintentar puede enviar un duplicado. ¿Quieres crear un nuevo envío?')) return;
    setUncertainSends(previous => previous.filter(item => item.clientMessageId !== uncertainSend.clientMessageId
      || item.conversationId !== uncertainSend.conversationId));
    submitMessage(uncertainSend.text, crypto.randomUUID(), true);
  }

  const actor = sessionQuery.data?.actor;
  const control = selectedConversation?.control;
  const canOverrideOwner = Boolean(control?.ownerId && actor && actor.id !== control.ownerId
    && actor.capabilities.includes('control:override'));
  const ownerCanAct = Boolean(!control?.ownerId || actor?.id === control.ownerId || canOverrideOwner);
  const controlConfirmed = control?.status === 'confirmed';
  const currentControlBusy = controlMutation.isPending && controlMutation.variables?.conversationId === conversationId;
  const currentControlError = controlMutation.isError && controlMutation.variables?.conversationId === conversationId
    ? asError(controlMutation.error) : null;
  const canTakeover = Boolean(actor?.capabilities.includes('control:write') && controlConfirmed
    && control?.lifecycle === 'open' && control?.accessPolicy !== 'ignored'
    && !selectedConversation?.requiresReview && ownerCanAct && !currentControlBusy);
  const canRelease = Boolean(actor?.capabilities.includes('control:write') && controlConfirmed
    && control?.automationMode === 'human' && ownerCanAct && !currentControlBusy);
  const canResolve = Boolean(actor?.capabilities.includes('conversations:write') && controlConfirmed
    && control?.lifecycle === 'open' && !currentControlBusy);
  const canReopen = Boolean(actor?.capabilities.includes('conversations:write') && controlConfirmed
    && control?.lifecycle === 'resolved' && !currentControlBusy);
  const canSend = Boolean(actor?.capabilities.includes('messages:send') && selectedAccount?.capabilities.reply
    && selectedAccount.status === 'connected' && controlConfirmed && control?.automationMode === 'human'
    && control.lifecycle === 'open' && !selectedConversation?.requiresReview && ownerCanAct);
  const currentUncertainSend = uncertainSends.find(item => item.conversationId === conversationId) ?? null;
  const currentSendPending = sendMutation.isPending && sendMutation.variables?.conversationId === conversationId;
  const sendError = sendMutation.isError && sendMutation.variables?.conversationId === conversationId && !currentUncertainSend
    ? asError(sendMutation.error) : null;

  return (
    <div className={`inbox-layout${conversationId ? ' has-selected-chat' : ''}`}>
      <ConversationList
        conversationId={conversationId}
        conversations={conversations}
        accounts={accounts}
        loading={conversationsQuery.isLoading}
        error={listError}
        moreError={moreError}
        hasMore={Boolean(conversationsQuery.hasNextPage)}
        loadingMore={conversationsQuery.isFetchingNextPage}
        filter={filter}
        channel={channel}
        search={searchInput}
        onFilterChange={setFilter}
        onChannelChange={setChannel}
        onSearchChange={setSearchInput}
        onLoadMore={() => { void conversationsQuery.fetchNextPage(); }}
        onRetry={() => { void conversationsQuery.refetch(); }}
        onRetryMore={() => {
          if (moreError instanceof PanelApiError && (moreError.code === 'CURSOR_EXPIRED' || moreError.code === 'DATA_EPOCH_MISMATCH')) {
            void conversationsQuery.refetch();
          } else {
            void conversationsQuery.fetchNextPage();
          }
        }}
        streamStatus={live.status}
      />
      <ConversationThread
        conversationId={conversationId}
        conversation={selectedConversation}
        detailLoading={Boolean(conversationId) && conversationQuery.isLoading}
        detailError={conversationError}
        messages={visibleMessages}
        messagePageCount={messagePages.length}
        messagesLoading={Boolean(conversationId) && messagesQuery.isLoading}
        messagesError={messageError}
        hasOlder={Boolean(messagesQuery.hasNextPage)}
        loadingOlder={messagesQuery.isFetchingNextPage}
        readError={readError}
        newMessagesCount={live.newMessageCount}
        onMessagesSeen={live.clearNewMessages}
        onAtLatestChange={setIsAtLatest}
        onLoadOlder={() => messagesQuery.fetchNextPage()}
        onRetryDetail={() => { void conversationQuery.refetch(); }}
        onRetryMessages={() => {
          void messagesQuery.refetch();
          if (conversationId) {
            void queryClient.fetchQuery({
              queryKey: ['inbox', 'live-messages', conversationId],
              queryFn: () => getMessages(conversationId, {}),
              staleTime: 0
            }).catch(() => undefined);
          }
        }}
        onRetryRead={sendReadCursor}
        actor={actor}
        account={selectedAccount}
        canTakeover={canTakeover}
        canRelease={canRelease}
        canResolve={canResolve}
        canReopen={canReopen}
        canSend={canSend}
        controlBusy={currentControlBusy || Boolean(pendingTakeoverId)}
        controlError={currentControlError}
        controlNotice={controlNotice}
        onTakeover={() => runControlAction('takeover')}
        onRelease={() => runControlAction('release')}
        onResolve={() => runControlAction('resolve')}
        onReopen={() => runControlAction('reopen')}
        draft={draft}
        onDraftChange={setDraft}
        sendBusy={currentSendPending}
        sendError={sendError}
        uncertainSend={currentUncertainSend}
        onSubmitMessage={() => submitMessage()}
        onRetryUncertainSend={retryUncertainSend}
        onRestoreUncertainDraft={() => { if (currentUncertainSend) setDraft(currentUncertainSend.text); }}
      />
      <ConversationDetails
        conversation={selectedConversation}
        account={selectedAccount}
        selected={Boolean(conversationId)}
        loading={Boolean(conversationId) && conversationQuery.isLoading}
      />
    </div>
  );
}
