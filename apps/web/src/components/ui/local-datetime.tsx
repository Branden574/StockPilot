'use client';

import * as React from 'react';

/**
 * Absolute local date+time ("Jul 15, 2026, 10:28 PM"), rendered CLIENT-side.
 *
 * Server components render in the deployment timezone (UTC on Vercel), so a
 * toLocaleString() computed during SSR shows the wrong wall-clock time for
 * the viewer. This renders nothing on the server and fills in after
 * hydration, so the text is always the viewer's local time.
 *
 * `prefix` is only emitted alongside the text, so a separator ("· ") never
 * dangles during SSR or on an invalid date.
 */
export function LocalDateTime({
  iso,
  prefix,
  className,
}: {
  iso: string;
  prefix?: string;
  className?: string;
}) {
  const [text, setText] = React.useState<string | null>(null);

  React.useEffect(() => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only timezone-correct text must wait for hydration
    setText(
      d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  }, [iso]);

  if (!text) return null;
  return (
    <span className={className}>
      {prefix}
      {text}
    </span>
  );
}
