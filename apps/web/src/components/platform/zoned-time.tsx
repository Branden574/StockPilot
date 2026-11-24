import { zoneLongWords } from '@stockpilot/core';

import { formatMomentInZone } from '@/lib/platform/dates';
import { formatExactUtc } from '@/lib/platform/last-active';

/**
 * A time on the console's security pages, in the viewer's zone (the one they
 * chose, else the browser's on the client and UTC on the server), with its
 * exact instant in UTC beside it: in a `title` for the pointer, and in words
 * for a screen reader, so the precise instant is never lost. A time already
 * in UTC says nothing twice.
 *
 * No hooks and no browser state: the same string on the server and in the
 * browser for the same props, so a page rendered on the server hydrates
 * without a mismatch.
 */

type Instant = string | number;

/** "23 Nov 2026, 21:58 UTC" for each instant, joined by "to". */
export function exactUtcOf(at: Instant | readonly Instant[]): string | null {
  const all = (Array.isArray(at) ? at : [at]) as readonly Instant[];
  const words = all.map((a) =>
    formatExactUtc(
      typeof a === 'number' ? (Number.isFinite(a) ? new Date(a).toISOString() : null) : a,
    ),
  );
  if (words.some((w) => w === null)) return null;
  return words.join(' to ');
}

/** A short time ("13:58 PST", "20 Nov 2026, 02:15 PST"), its exact UTC in the title and for screen readers. */
export function ZonedTime({
  at,
  shown,
  className,
}: {
  at: Instant;
  shown: string;
  className?: string;
}) {
  const utc = exactUtcOf(at);
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return (
    <time
      dateTime={Number.isFinite(ms) ? new Date(ms).toISOString() : undefined}
      title={utc ?? undefined}
      className={className}
      data-utc={utc ?? undefined}
    >
      {shown}
      {utc && !shown.endsWith(' UTC') ? <span className="sr-only"> ({utc})</span> : null}
    </time>
  );
}

/** A sentence that names one or two times: the exact UTC of each in the title, and after it for screen readers. */
export function ZonedWords({
  at,
  text,
}: {
  at: Instant | readonly Instant[] | null;
  text: string;
}) {
  const utc = at === null ? null : exactUtcOf(at);
  if (!utc) return <>{text}</>;
  return (
    <span title={utc} data-utc={utc}>
      {text}
      {/* Words already in UTC say nothing twice. */}
      {/\bUTC\b/.test(text) ? null : <span className="sr-only"> In UTC: {utc}.</span>}
    </span>
  );
}

/**
 * A moment in a table the console renders on the server ("20 Nov 2026, 02:15
 * PST", the console's own spelling, formatMomentInZone): in the viewer's
 * chosen zone, else UTC (the server knows no browser). "—" for no instant.
 */
export function ConsoleMoment({
  at,
  timeZone,
}: {
  at: string | null | undefined;
  timeZone: string | null;
}) {
  if (!at || !Number.isFinite(Date.parse(at))) return <>—</>;
  return <ZonedTime at={at} shown={formatMomentInZone(at, timeZone ?? 'UTC')} />;
}

/** A table head's note on which zone its times are in: "In Pacific Standard Time (America/Los_Angeles)." */
export function consoleZoneNote(timeZone: string | null, at: number = Date.now()): string {
  return `In ${zoneLongWords(at, timeZone ?? 'UTC')}.`;
}
