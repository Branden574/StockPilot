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
 */
export function useCatalogThumbnails(url: string | null): Record<string, string> {
  const [thumbUrls, setThumbUrls] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const MAX_RETRIES = 3;

    const load = async (): Promise<boolean> => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) return false;
        const data = (await res.json()) as { urls?: Record<string, string> };
        if (!cancelled && data.urls) setThumbUrls(data.urls);
        return true;
      } catch {
        return false; // placeholders stay; we retry below
      }
    };

    const run = async () => {
      const ok = await load();
      if (ok || cancelled || attempt >= MAX_RETRIES) return;
      const delay = 2000 * 2 ** attempt; // 2s → 4s → 8s
      attempt += 1;
      timer = setTimeout(() => void run(), delay);
    };
    void run();

    // Connectivity returned (phone left a dead zone, laptop woke up):
    // start a fresh attempt cycle. Re-running after a success is harmless —
    // it just re-signs the URLs.
    const onOnline = () => {
      if (cancelled) return;
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

  return thumbUrls;
}
