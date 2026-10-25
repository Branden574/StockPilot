/**
 * A RECORD OF A RUN THAT A PAGE LOAD CAN CUT SHORT.
 *
 * Some web flows save something and then keep sending Server Actions: the New
 * procedure form creates the procedure and then uploads each staged video,
 * and the Sage 50 wizard imports in chunks. What the run has done so far lives
 * in the page's memory. When the session ends partway through, the next action
 * is answered with a redirect to sign-in (lib/supabase/middleware.ts, or a
 * rethrown redirect() from the server), and the browser loads
 * /signin?redirect=<the page the action was sent from>. The page unloads, and
 * that memory with it: after signing in, the person is back on the same page
 * with no word of what was already saved. A reload or a closed tab partway
 * through loses it the same way.
 *
 * So such a run keeps a small record in this tab's sessionStorage:
 * - recordRun() once the first save has landed and before each further action
 *   (each call rewrites the record and restarts its day);
 * - finishRun() when the run ends on the page, which removes the record;
 * - leaveRunUnfinished() when a redirect stops it, which keeps the record for
 *   the page the person comes back to;
 * - takeInterruptedRun() on that page, which hands the record over once.
 *
 * A record is handed only to the account that wrote it (the same user in the
 * same organization), only for a day after its last step, and never while the
 * run is still going in this page (a person who opens the form again while a
 * batch runs on is not interrupted). Every other record it reads is removed
 * unread: another account's, an old one, one it cannot parse. sessionStorage
 * belongs to one tab, so nothing here reaches another tab or device, and every
 * read and write tolerates a browser that refuses storage: the run then works
 * as it did without a record.
 */

/** Storage key prefix. Versioned so a shape change cannot feed a stale record. */
export const INTERRUPTED_RUN_PREFIX = 'sp:interrupted-run:v1:';

/** How long after its last step a record is still handed out. */
export const INTERRUPTED_RUN_TTL_MS = 24 * 60 * 60 * 1000;

/** Whose run it is: a record is handed only to the account that wrote it. */
export interface RunAccount {
  userId: string;
  organizationId: string;
}

interface StoredRun {
  v: 1;
  userId: string;
  organizationId: string;
  /** Date.now() at the run's last step. */
  at: number;
  payload: unknown;
}

/** Kinds of run going on in this page right now (a page load clears it). */
const liveRuns = new Set<string>();

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Reading sessionStorage itself throws when site data is blocked.
    return null;
  }
}

function remove(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* best effort */
  }
}

/**
 * The run of this `kind` is going on in this page, and this is what it has
 * done so far. Call it once the first save has landed and again before each
 * further Server Action. False when the browser refused the write.
 */
export function recordRun(kind: string, account: RunAccount, payload: unknown): boolean {
  liveRuns.add(kind);
  const store = storage();
  if (!store) return false;
  const record: StoredRun = {
    v: 1,
    userId: account.userId,
    organizationId: account.organizationId,
    at: Date.now(),
    payload,
  };
  try {
    store.setItem(INTERRUPTED_RUN_PREFIX + kind, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** The run ended on the page, which showed its outcome: forget it. */
export function finishRun(kind: string): void {
  liveRuns.delete(kind);
  const store = storage();
  if (store) remove(store, INTERRUPTED_RUN_PREFIX + kind);
}

/**
 * A redirect stopped the run before it ended on the page (the browser is on its
 * way to sign-in). The run is over here, and its record stays for the page the
 * person comes back to.
 */
export function leaveRunUnfinished(kind: string): void {
  liveRuns.delete(kind);
}

/**
 * The record a run of this `kind` left when a page load cut it short, for
 * `account`, or null. Handed out once: whatever is read is removed. `parse`
 * checks the payload's shape and answers null for one it cannot use.
 */
export function takeInterruptedRun<T>(
  kind: string,
  account: RunAccount,
  parse: (payload: unknown) => T | null,
): T | null {
  // Still going in this page: nothing was cut short.
  if (liveRuns.has(kind)) return null;
  const store = storage();
  if (!store) return null;
  const key = INTERRUPTED_RUN_PREFIX + kind;
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  remove(store, key);

  let record: Partial<StoredRun> | null;
  try {
    record = JSON.parse(raw) as Partial<StoredRun> | null;
  } catch {
    return null;
  }
  if (
    record === null ||
    typeof record !== 'object' ||
    record.v !== 1 ||
    record.userId !== account.userId ||
    record.organizationId !== account.organizationId ||
    typeof record.at !== 'number' ||
    !Number.isFinite(record.at) ||
    Math.abs(Date.now() - record.at) > INTERRUPTED_RUN_TTL_MS
  ) {
    return null;
  }
  return parse(record.payload);
}
