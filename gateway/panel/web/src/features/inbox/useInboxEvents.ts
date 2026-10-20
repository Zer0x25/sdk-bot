import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getMessages, type MessagesResponse, type PageCursor } from './api';

const EVENT_TYPES = [
  'conversation.updated',
  'message.created',
  'message.updated',
  'operation.updated',
  'policy.updated',
  'control.changed',
  'channel.updated',
  'resync.required'
] as const;

type EventName = typeof EVENT_TYPES[number];
export type StreamStatus = 'connecting' | 'connected' | 'reconnecting';

interface ConversationEvent {
  type: EventName;
  data: Record<string, unknown>;
}

function parseEvent(data: string): ConversationEvent | null {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const event = value as { type?: unknown; data?: unknown };
  if (typeof event.type !== 'string' || !EVENT_TYPES.includes(event.type as EventName)) return null;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return null;
  return { type: event.type as EventName, data: event.data as Record<string, unknown> };
}

async function getLiveMessages(
  queryClient: ReturnType<typeof useQueryClient>,
  conversationId: string,
  signal?: AbortSignal
): Promise<MessagesResponse> {
  const history = queryClient.getQueryData<{ pages?: MessagesResponse[] }>(['inbox', 'messages', conversationId]);
  const cachedLatestIds = new Set(history?.pages?.[0]?.items.map(message => message.id) ?? []);
  const pages: MessagesResponse[] = [];
  const visitedCursors = new Set<PageCursor>();
  let cursor: PageCursor | undefined;

  while (true) {
    const page = await getMessages(conversationId, { cursor }, signal);
    pages.push(page);
    if (cachedLatestIds.size === 0 || page.items.some(message => cachedLatestIds.has(message.id)) || !page.nextCursor) break;
    if (visitedCursors.has(page.nextCursor)) {
      throw new Error('No se pudo completar la actualización del historial.');
    }
    visitedCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  const items = [...new Map(pages.flatMap(page => page.items).map(message => [message.id, message] as const)).values()];
  return { ...pages[0], items };
}

export function useInboxEvents(conversationId?: string) {
  const queryClient = useQueryClient();
  const conversationRef = useRef(conversationId);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [newMessageCount, setNewMessageCount] = useState(0);

  useEffect(() => {
    conversationRef.current = conversationId;
    setNewMessageCount(0);
  }, [conversationId]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setStatus('reconnecting');
      return;
    }
    const source = new EventSource('/api/v1/events');
    let opened = false;
    let refreshTimer: number | undefined;
    let listDirty = false;
    let accountsDirty = false;
    const dirtyConversations = new Set<string>();
    const dirtyMessages = new Set<string>();
    const refreshingMessages = new Set<string>();
    const processedEventIds = new Set<string>();
    const processedMessageIds = new Set<string>();

    function flushInvalidations() {
      refreshTimer = undefined;
      if (listDirty) void queryClient.invalidateQueries({ queryKey: ['inbox', 'conversations'] });
      if (accountsDirty) void queryClient.invalidateQueries({ queryKey: ['inbox', 'accounts'] });
      for (const id of dirtyConversations) {
        void queryClient.invalidateQueries({ queryKey: ['inbox', 'conversation', id] });
      }
      for (const id of [...dirtyMessages]) {
        if (refreshingMessages.has(id)) continue;
        dirtyMessages.delete(id);
        refreshingMessages.add(id);
        void queryClient.fetchQuery({
          queryKey: ['inbox', 'live-messages', id],
          queryFn: ({ signal }) => getLiveMessages(queryClient, id, signal),
          staleTime: 0
        }).catch(() => undefined).finally(() => {
          refreshingMessages.delete(id);
          if (dirtyMessages.size > 0) scheduleFlush();
        });
      }
      listDirty = false;
      accountsDirty = false;
      dirtyConversations.clear();
    }

    function scheduleFlush() {
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(flushInvalidations, 120);
    }

    function handleDomainEvent(rawEvent: Event) {
      const messageEvent = rawEvent as MessageEvent<string>;
      const eventId = messageEvent.lastEventId;
      if (eventId && processedEventIds.has(eventId)) return;
      if (eventId) {
        processedEventIds.add(eventId);
        if (processedEventIds.size > 1000) processedEventIds.delete(processedEventIds.values().next().value as string);
      }
      const event = parseEvent(messageEvent.data);
      if (!event) return;

      if (event.type === 'resync.required') {
        if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
        listDirty = false;
        accountsDirty = false;
        dirtyConversations.clear();
        dirtyMessages.clear();
        processedMessageIds.clear();
        setNewMessageCount(0);
        // A new epoch or expired cursor invalidates every cached snapshot and page cursor.
        void queryClient.resetQueries({ queryKey: ['inbox'] }).then(() => {
          const selectedId = conversationRef.current;
          if (selectedId) {
            return queryClient.fetchQuery({
              queryKey: ['inbox', 'live-messages', selectedId],
              queryFn: ({ signal }) => getLiveMessages(queryClient, selectedId, signal),
              staleTime: 0
            }).catch(() => undefined);
          }
          return undefined;
        });
        return;
      }

      const id = event.data.conversationId;
      if (event.type === 'channel.updated') accountsDirty = true;
      listDirty = true;
      if (typeof id === 'string') {
        dirtyConversations.add(id);
        const messageChanged = event.type === 'message.created' || event.type === 'message.updated';
        if (messageChanged) {
          void queryClient.invalidateQueries({ queryKey: ['inbox', 'messages', id], refetchType: 'none' });
        }
        if (id === conversationRef.current && messageChanged) {
          dirtyMessages.add(id);
          if (event.type === 'message.created' && typeof event.data.messageId === 'string'
            && !processedMessageIds.has(event.data.messageId)) {
            processedMessageIds.add(event.data.messageId);
            if (processedMessageIds.size > 1000) processedMessageIds.delete(processedMessageIds.values().next().value as string);
            setNewMessageCount(count => count + 1);
          }
        }
      }
      scheduleFlush();
    }

    for (const type of EVENT_TYPES) source.addEventListener(type, handleDomainEvent);
    source.onopen = () => {
      setStatus('connected');
      if (!opened) {
        opened = true;
        // Open the stream before refreshing the snapshot so its checkpoint closes the gap.
        void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      }
    };
    source.onerror = () => setStatus('reconnecting');

    return () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      for (const type of EVENT_TYPES) source.removeEventListener(type, handleDomainEvent);
      source.close();
    };
  }, [queryClient]);

  return {
    status,
    newMessageCount,
    clearNewMessages: () => setNewMessageCount(0)
  };
}
