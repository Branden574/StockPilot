'use client';

import * as React from 'react';
import { toast } from 'sonner';

/**
 * Polls /api/version periodically (and when the tab regains focus) to
 * detect a deployment that's newer than the bundle the user currently
 * has loaded. Shows one persistent toast with a Reload action — once
 * shown, won't re-prompt for the same build id.
 */
export function VersionNotifier({
  pollMs = 5 * 60 * 1000,
}: {
  pollMs?: number;
}) {
  const initialBuildRef = React.useRef<string | null>(null);
  const lastShownBuildRef = React.useRef<string | null>(null);
  const toastIdRef = React.useRef<string | number | null>(null);

  const check = React.useCallback(async () => {
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

      toastIdRef.current = toast(
        'A new version of StockPilot is live',
        {
          description: 'Reload to pick up the latest changes.',
          duration: Infinity,
          action: {
            label: 'Reload',
            onClick: () => {
              window.location.reload();
            },
          },
        },
      );
    } catch {
      // Offline / transient — try again next interval.
    }
  }, []);

  React.useEffect(() => {
    void check();
    const interval = window.setInterval(check, pollMs);
    const onFocus = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [check, pollMs]);

  return null;
}
