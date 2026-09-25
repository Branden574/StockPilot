/**
 * "Counted offline <time>" for a cycle-count line (Phase 0 S5-C, migration
 * 0369, owner default D7).
 *
 * A count typed while the phone was offline can reach the server hours later.
 * The server measures it against the book AT THE MOMENT IT WAS TAKEN
 * (cycle_count_lines.captured_at) and accepts old captures, so whoever reviews
 * and posts the count must see when that moment was. One builder for the web
 * review row and the phone's count screen, so both say the same thing.
 */

/**
 * How long before its write a line must have been captured to read as an
 * offline count. A phone that is online sends within seconds of the count.
 */
const OFFLINE_CAPTURE_MIN_GAP_MS = 2 * 60 * 1000;

/** The capture instant (ISO) of a line counted offline, or null: an online
 *  record, a line with no capture time, or an unreadable one. With no
 *  counted_at to compare against, any readable capture time counts. */
export function offlineCaptureAt(line: {
  captured_at?: string | null;
  counted_at?: string | null;
}): string | null {
  if (!line.captured_at) return null;
  const captured = Date.parse(line.captured_at);
  if (!Number.isFinite(captured)) return null;
  const counted = line.counted_at ? Date.parse(line.counted_at) : Number.NaN;
  if (Number.isFinite(counted) && counted - captured < OFFLINE_CAPTURE_MIN_GAP_MS) return null;
  return new Date(captured).toISOString();
}

/**
 * The review label for a line counted offline and synced later, e.g.
 * "Counted offline Sep 24, 3:14 PM". Null when offlineCaptureAt is. `timeZone`
 * is the organization's, so a server render, a browser and a phone agree; an
 * unknown zone falls back to the viewer's own.
 */
export function offlineCaptureLabel(
  line: { captured_at?: string | null; counted_at?: string | null },
  timeZone?: string | null,
): string | null {
  const at = offlineCaptureAt(line);
  if (!at) return null;
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  const date = new Date(at);
  let when: string;
  try {
    when = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timeZone ?? undefined }).format(date);
  } catch {
    // An unknown zone name: the viewer's own zone beats no label.
    when = new Intl.DateTimeFormat('en-US', opts).format(date);
  }
  return `Counted offline ${when}`;
}
