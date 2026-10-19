'use client';

import { useHydrated } from '@/lib/use-hydrated';
import { formatRelative } from '@/lib/utils';

/**
 * An audit row's time: "3 minutes ago" with the exact moment in the tooltip.
 *
 * The tooltip used to be printed by the server page with toLocaleString(), so
 * it showed the server's zone (UTC on Vercel), unlabelled: an evening event in
 * Los Angeles read as the next morning. It is now the viewer's own clock,
 * printed once the page has hydrated (useHydrated), so no server text can
 * disagree with it. The relative words stay right to within a minute, so they
 * carry suppressHydrationWarning, as the other relative times do.
 */
export function AuditTime({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  return (
    <time
      dateTime={iso}
      title={hydrated ? new Date(iso).toLocaleString() : undefined}
      suppressHydrationWarning
    >
      {formatRelative(iso)}
    </time>
  );
}
