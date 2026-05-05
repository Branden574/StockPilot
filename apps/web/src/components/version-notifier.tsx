'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

/**
 * window.location.reload() is a *soft* reload — the browser may serve
 * the page (and any same-URL JS bundles) from its HTTP cache, which is
 * why "Reload" sometimes appears to do nothing after a deploy. Force a
 * fresh request by clearing the Cache Storage we control + appending a
 * cache-busting query param so the HTML, RSC payload, and any chunks
 * referenced by the new HTML are all refetched.
 */
function forceReload(): void {
  // Best-effort: drop any service-worker / Cache Storage entries we may
  // have populated. Doesn't fail if Cache Storage is unavailable.
  try {
    if (typeof caches !== 'undefined') {
      void caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
    }
  } catch {
    // ignore
  }
  const url = new URL(window.location.href);
  url.searchParams.set('_v', Date.now().toString(36));
  window.location.replace(url.toString());
}

/**
 * Polls /api/version frequently and on a few user-driven signals to
 * detect a deployment that's newer than the bundle the user currently
 * has loaded. Shows one persistent toast with a Reload action; once
 * shown, won't re-prompt for the same build id.
 *
 * Triggers a check:
 *   - on mount (establishes the baseline)
 *   - every `pollMs` (default 30s — the previous 5-min interval was
 *     too lazy to feel "instant" right after a deploy)
 *   - whenever the tab regains visibility (back from another tab)
 *   - whenever the window regains focus (back from another app)
 *   - whenever the browser comes back online
 *   - whenever the Next.js client-side route changes (cheap signal —
 *     the user just did something, perfect moment to check)
 */
export function VersionNotifier({
  pollMs = 30 * 1000,
}: {
  pollMs?: number;
}) {
  const pathname = usePathname();
  const initialBuildRef = React.useRef<string | null>(null);
  const lastShownBuildRef = React.useRef<string | null>(null);
  const toastIdRef = React.useRef<string | number | null>(null);
  const lastCheckedRef = React.useRef<number>(0);

  const check = React.useCallback(async () => {
    // Light dedupe so the various event listeners + interval don't
    // pile up redundant fetches when several fire in quick succession.
    const now = Date.now();
    if (now - lastCheckedRef.current < 1500) return;
    lastCheckedRef.current = now;

    try {
      const res = await fetch('/api/version', { cache: 'no-store' });
      if (!res.ok) return;
      const { build } = (await res.json()) as { build?: string };
      if (!build) return;

      // First successful fetch establishes the baseline — that's the
      // version the user is running right now.
      if (initialBuildRef.current === null) {
        initialBuildRef.current = build;
        return;
      }

      // No change → nothing to do.
      if (build === initialBuildRef.current) return;

      // Already prompted for this exact build → don't re-toast.
      if (build === lastShownBuildRef.current) return;
      lastShownBuildRef.current = build;

      // Dismiss any prior toast so we don't stack them.
      if (toastIdRef.current !== null) toast.dismiss(toastIdRef.current);

      toastIdRef.current = toast('A new version of StockPilot is live', {
        description: 'Reload to pick up the latest changes.',
        duration: Infinity,
        action: {
          label: 'Reload',
          onClick: forceReload,
        },
      });
    } catch {
      // Offline / transient — try again next interval.
    }
  }, []);

  React.useEffect(() => {
    void check();
    const interval = window.setInterval(check, pollMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const onFocus = () => void check();
    const onOnline = () => void check();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [check, pollMs]);

  // Check on every client-side navigation. The user just did something
  // — that's a perfect moment to re-check. Cheap: same /api/version
  // endpoint, dedupe above prevents thrash.
  React.useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return null;
}
