/**
 * Terminally rejected offline work — the vocabulary and the retention policy.
 *
 * A rejected row in `pending_actions` is a write the operator believed they had
 * saved and which will never be sent. Today there is exactly one producer: work
 * that was queued on this device when the account was confirmed disabled
 * (queue.ts's `rejectAllPending` / `markRejected`).
 *
 * The rows are deliberately kept — `wipeForSignOut` spares them (db.ts) — but
 * keeping is only half a promise. Until this module they were invisible: no
 * screen read them, no counter counted them, and nothing ever deleted them, so
 * on a shared warehouse device they accumulated for the life of the install
 * carrying one user's payloads past the next user's sign-in.
 *
 * PURE on purpose. queue.ts (expo-sqlite) and the settings screen (react-native)
 * cannot be loaded in this vitest environment, so the two decisions worth
 * pinning — what a row is CALLED and when it is old enough to drop — live here.
 */

/** How long a rejected row stays on the device before it is pruned. */
export const REJECTED_RETENTION_DAYS = 30;
export const REJECTED_RETENTION_MS = REJECTED_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on how many rejected rows are kept, newest first.
 *
 * Age alone is not enough: one eviction on a device with a long offline stint
 * can park thousands of rows at once, and all of them share a timestamp. The
 * cap keeps that bounded; the list surface shows the newest anyway.
 */
export const REJECTED_KEEP_MAX = 200;

/** Rows last touched before this instant are prunable. */
export function rejectedPruneCutoff(now: number): number {
  return now - REJECTED_RETENTION_MS;
}

/**
 * The queue's `kind` column is a developer word (`receive_po_line`). An
 * operator being told what became of their work must read their own vocabulary,
 * so the map is exhaustive over PendingActionKind and degrades readably for a
 * kind written by a newer OTA bundle than the one rendering it.
 */
const KIND_LABELS: Record<string, string> = {
  adjust_stock: 'Stock adjustment',
  receive_po_line: 'PO receipt',
  record_count: 'Cycle count entry',
  create_book: 'New book',
  distribute_bundle: 'Bundle distribution',
  upload_image: 'Photo upload',
  size_count_event: 'Size count tally',
};

export function pendingActionLabel(kind: string): string {
  const known = KIND_LABELS[kind];
  if (known) return known;
  const words = kind.replace(/[_-]+/g, ' ').trim();
  if (!words) return 'Queued change';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Recency, not a timestamp. "3 days ago" is what tells an operator whether this
 * is the work they are currently looking for; an ISO date only helps once the
 * relative form has stopped meaning anything.
 *
 * Elapsed-time based rather than calendar based: a warehouse device crosses
 * timezones and its clock is not authoritative, and a clock that has moved
 * BACKWARDS must read as "Today" rather than claiming the future.
 */
export function rejectedWhen(at: number, now: number): string {
  const elapsed = now - at;
  if (elapsed < DAY_MS) return 'Today';
  if (elapsed < 2 * DAY_MS) return 'Yesterday';
  const days = Math.floor(elapsed / DAY_MS);
  if (days <= REJECTED_RETENTION_DAYS) return `${days} days ago`;
  return new Date(at).toISOString().slice(0, 10);
}
