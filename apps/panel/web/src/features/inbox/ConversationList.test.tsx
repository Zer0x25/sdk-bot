import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Contract } from '@sdk-bot/contracts';
import { ConversationList } from './ConversationList';

type Conversation = Contract<'Conversation'>;
const contactId = '33333333-3333-4333-8333-333333333333';
const conversation: Conversation = {
  id: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  contactId,
  canonicalIdentityId: contactId,
  aggregateVersion: '1',
  control: {
    accessPolicy: 'allowed', automationMode: 'ai', contextVersion: '1', controlVersion: '1',
    handoffReason: null, lifecycle: 'open', ownerId: null, profileKey: null,
    requiresReview: false, reviewReasons: [], status: 'confirmed', takenAt: null
  },
  displayName: 'Ana Pérez',
  historyCoverage: { kind: 'capturing_since', capturingSince: null },
  lastActivityAt: '2026-10-20T12:00:00.000Z',
  requiresReview: false,
  unreadCount: 0
};

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit
  ) {
    MockIntersectionObserver.instances.push(this);
  }

  intersect() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  MockIntersectionObserver.instances = [];
});

describe('ConversationList', () => {
  it('loads the next conversation page when its own list approaches the end', async () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    const onLoadMore = vi.fn();

    render(<MemoryRouter><ConversationList
      conversationId={conversation.id}
      conversations={[conversation]}
      accounts={[]}
      loading={false}
      error={null}
      moreError={null}
      hasMore
      loadingMore={false}
      filter="all"
      channel=""
      search=""
      onFilterChange={vi.fn()}
      onChannelChange={vi.fn()}
      onSearchChange={vi.fn()}
      onLoadMore={onLoadMore}
      onRetryMore={vi.fn()}
      onRetry={vi.fn()}
      streamStatus="connected"
    /></MemoryRouter>);

    const list = screen.getByRole('list', { name: 'Resultados de conversaciones' });
    await waitFor(() => expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0));
    const observer = MockIntersectionObserver.instances.at(-1)!;
    expect(observer.options?.root).toBe(list);
    expect(observer.observe).toHaveBeenCalled();

    observer.intersect();
    observer.intersect();
    await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(1));
  });
});
