import { useEffect, useRef } from 'react';

type ElementRef<T extends HTMLElement> = { current: T | null };

interface Options {
  enabled: boolean;
  loading: boolean;
  onLoadMore(): void | Promise<unknown>;
  rootMargin?: string;
}

/** Observe a sentinel inside a scrollable list and request its next page near the end. */
export function useInfiniteScroll<T extends HTMLElement>(rootRef: ElementRef<T>, {
  enabled,
  loading,
  onLoadMore,
  rootMargin = '0px 0px 180px 0px'
}: Options) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  const requestInProgress = useRef(false);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const root = rootRef.current;
    const sentinel = sentinelRef.current;
    if (!enabled || loading || !root || !sentinel || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || requestInProgress.current) return;
      requestInProgress.current = true;
      void Promise.resolve()
        .then(() => onLoadMoreRef.current())
        .catch(() => undefined)
        .finally(() => { requestInProgress.current = false; });
    }, { root, rootMargin, threshold: 0 });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, loading, rootMargin, rootRef]);

  return sentinelRef;
}
