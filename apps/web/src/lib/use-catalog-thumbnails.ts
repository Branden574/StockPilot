import * as React from 'react';

/**
 * Deferred catalog-thumbnail loader shared by the staff order picker, the
 * public order portal, and the rental create form.
 *
 * The picker pages render instantly with placeholders and fetch signed
 * thumbnail URLs after first paint. The old inline effects were ONE-SHOT with
 * a silent catch — a single 429/timeout meant an entire ordering session with
 * no product photos and no recovery short of a hard reload. This hook retries
 * with backoff (2s/4s/8s) and re-fires when connectivity returns, so a blip
 * costs seconds, not the session.
 *
 * PAGES (B32). The public order page's route answers at most 500 items per
 * request, with the URL of the next page in `next`
 * (components/orders/public-v2/photo-pages.ts), so the hook reads every page
 * in turn: an item past the 500th still gets its photo, blur and description.
 * A failed page keeps the pages already read and is retried on its own; back
 * online, the read starts again at the page it stopped at. A route that
 * answers one page with no `next` (the staff rental form's) reads as before.
 */

export interface CatalogPages {
  /** Image URL per item id. */
  urls: Record<string, string>;
  /** Blur placeholder per item id (the public pages send them). */
  lqip: Record<string, string>;
  /** Public description per item id (the public pages send them). */
  descriptions: Record<string, string>;
}

const NO_PAGES: CatalogPages = { urls: {}, lqip: {}, descriptions: {} };

/** Retries per page after its first attempt: 2s, 4s, 8s. */
const MAX_RETRIES = 3;

/** The most pages one catalog is read in, whatever the answers say. The
 *  public catalog takes at most 4 (photo-pages.ts PUBLIC_PHOTO_PAGES). */
const MAX_PAGES = 20;

type PageAnswer = Partial<CatalogPages> & { next?: unknown };

/** A next page is followed only when it is a path on this site. */
function followable(next: unknown): string | null {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

export function useCatalogPages(url: string | null): CatalogPages {
  const [pages, setPages] = React.useState<CatalogPages>(NO_PAGES);

  React.useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let attempt = 0;
    /** The page to read next; null once the last one is read. */
    let pending: string | null = url;
    const read = new Set<string>();
    /** Pages read: the cap holds whatever the answers name. */
    let pagesRead = 0;

    const load = async (pageUrl: string): Promise<PageAnswer | null> => {
      try {
        const res = await fetch(pageUrl, { credentials: 'same-origin' });
        if (!res.ok) return null;
        return (await res.json()) as PageAnswer;
      } catch {
        return null; // placeholders stay; we retry below
      }
    };

    const run = async () => {
      if (running) return;
      running = true;
      try {
        while (pending !== null && !cancelled) {
          const pageUrl: string = pending;
          const data = await load(pageUrl);
          if (cancelled) return;
          if (!data) {
            if (attempt >= MAX_RETRIES) return; // stopped; back online starts it again
            const delay = 2000 * 2 ** attempt; // 2s → 4s → 8s
            attempt += 1;
            timer = setTimeout(() => {
              timer = null;
              void run();
            }, delay);
            return;
          }
          // The first page of a URL replaces what an earlier URL loaded; the
          // pages after it add to it.
          const first = pagesRead === 0;
          read.add(pageUrl);
          pagesRead += 1;
          attempt = 0;
          setPages((prev) => {
            const base = first ? NO_PAGES : prev;
            return {
              urls: { ...base.urls, ...data.urls },
              lqip: { ...base.lqip, ...data.lqip },
              descriptions: { ...base.descriptions, ...data.descriptions },
            };
          });
          const next = followable(data.next);
          pending = next !== null && !read.has(next) && pagesRead < MAX_PAGES ? next : null;
        }
      } finally {
        running = false;
      }
    };
    void run();

    // Connectivity returned (phone left a dead zone, laptop woke up): start a
    // fresh attempt cycle at the page that stopped. Nothing to do once every
    // page is read.
    const onOnline = () => {
      if (cancelled || pending === null || running) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      attempt = 0;
      void run();
    };
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [url]);

  return pages;
}

/** The photo map alone: the staff rental form's photos (one page). */
export function useCatalogThumbnails(url: string | null): Record<string, string> {
  return useCatalogPages(url).urls;
}
