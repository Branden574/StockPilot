'use client';

import { Loader2 } from 'lucide-react';
import { useLinkStatus } from 'next/link';

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
  if (!pending) return null;
  return (
    <Loader2
      aria-hidden="true"
      className="text-muted-foreground h-3 w-3 shrink-0 animate-spin"
    />
  );
}
