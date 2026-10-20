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
  getMessages,
  PanelApiError,
  markConversationRead,
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
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [channel, setChannel] = useState<Channel | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
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
        messages={messages}
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
              queryFn: () => getMessages(conversationId),
              staleTime: 0
            }).catch(() => undefined);
          }
        }}
        onRetryRead={sendReadCursor}
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
