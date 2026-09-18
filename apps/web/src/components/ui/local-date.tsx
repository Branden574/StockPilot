'use client';

import * as React from 'react';

/**
 * A calendar DATE in the viewer's own locale and time zone ("Sep 18, 2026"),
 * rendered client-side. The date-only sibling of LocalDateTime.
 *
 * Two traps this exists for:
 *   - a server component formats in the deployment's zone (UTC on Vercel), so
 *     an evening release shows as the next day to anyone west of Greenwich;
 *   - LocalDateTime always prints a time, and a release has a day, not a minute.
 *
 * `iso` must be a full instant ('2026-09-18T17:00:00Z'). A bare date parses as
 * UTC midnight and lands on the previous day for a US viewer, which is why the
 * release schema refuses one.
 *
 * Until hydration it renders `fallback`, which should be the same date formatted
 * in UTC (lib/utc-date-label.ts, callable from server components), so the space is held and the text is present for no-JS and crawlers.
 * <time dateTime> carries the exact instant for assistive technology.
 */
export function LocalDate({
  iso,
  fallback,
  className,
}: {
  iso: string;
  fallback?: string;
  className?: string;
}) {
  const [text, setText] = React.useState<string | null>(null);

  React.useEffect(() => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only timezone-correct text must wait for hydration
    setText(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
  }, [iso]);

  const shown = text ?? fallback ?? null;
  if (!shown) return null;
  return (
    <time dateTime={iso} className={className}>
      {shown}
    </time>
  );
}
