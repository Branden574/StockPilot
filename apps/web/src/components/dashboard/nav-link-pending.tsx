'use client';

import { Loader2 } from 'lucide-react';
import { useLinkStatus } from 'next/link';
import { useEffect } from 'react';

import { markNavigationFeedback } from '@/lib/perf/marks';

/**
 * Tiny client component rendered as a child of a `<Link>`. Uses
 * `useLinkStatus()` (Next.js 15.3+) to surface the link's in-flight
 * navigation state — flips to `pending: true` synchronously on click
 * and back to `false` once the new route has rendered.
 *
 * Why this exists: Next.js App Router navigations DO NOT change the
 * URL until the server's RSC response begins streaming. On cold-cache
 * first clicks that took up to ~1.2s in production (measured), which
 * the user perceived as a dead click. Showing a spinner inline at
 * click time turns the latency into an honest "loading…" instead of
 * a frozen UI.
 *
 * Renders a small spinner that sits in the link's badge slot — the
 * sidebar item keeps its existing layout, the spinner just appears
 * during the navigation.
 */
export function NavLinkPending() {
  const { pending } = useLinkStatus();
  // Performance mark only (lib/perf/marks.ts): the spinner is click FEEDBACK.
  // Same effect + DOUBLE requestAnimationFrame shape as NavProgressBar (the
  // reasoning lives there): the first callback runs BEFORE the frame that
  // paints the spinner, the second at the start of the frame after it, so the
  // mark lands once the spinner has been on screen. One frame late at worst,
  // never early, and the same convention as the external harness
  // (tests/perf/collector.ts). The two components are timed alike, and
  // whichever gets its painted frame first is the one recorded.
  //
  // BOTH handles are cancelled on cleanup: `pending` can drop between the two
  // frames (a warm route renders at once), and an inner frame left armed would
  // stamp feedback for a spinner that is no longer there.
  useEffect(() => {
    if (!pending) return;
    let inner: number | null = null;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => markNavigationFeedback());
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner !== null) cancelAnimationFrame(inner);
    };
  }, [pending]);
  if (!pending) return null;
  return (
    <Loader2 aria-hidden="true" className="text-muted-foreground h-3 w-3 shrink-0 animate-spin" />
  );
}
