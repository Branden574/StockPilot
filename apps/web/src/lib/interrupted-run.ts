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
 *   (each call rewrites the record and restarts its hour);
 * - finishRun() when the run ends on the page, which removes the record;
 * - leaveRunUnfinished() when a redirect stops it, which keeps the record for
 *   the page the person comes back to;
 * - takeInterruptedRun() on that page, which hands the record over once.
 *
 * A record is handed only to the account that wrote it (the same user in the
 * same organization), only for an hour after its last step (it is there to
 * take the person back to their work after signing in again, which takes
 * minutes), and never while the run is still going in this page (a person who
 * opens the form again while a batch runs on is not interrupted). Every other
 * record it reads is removed unread: another account's, an old one, one it
 * cannot parse.
 *
 * NOTHING IS KEPT ONCE NOBODY CAN NEED IT. A Sage 50 record carries up to 50
 * rows of the import's errors, so the records also go:
 * - when the session in this tab is ended on purpose: every sign-out control
 *   calls purgeInterruptedRuns() before its request leaves (the guard
 *   lib/interrupted-run.sign-out.guard.test.ts holds every one of them to
 *   it), and so does the forced sign-out when this session is revoked
 *   (components/realtime/session-revocation-listener.tsx). A run still going
 *   in this page then writes nothing more. A session that EXPIRES keeps its
 *   record, because that is what the record is for: the redirect to sign-in,
 *   or /auth/session-ended reached from the dashboard's own redirect.
 * - when the signed-in app shell renders for an account
 *   (components/dashboard/dashboard-shell.tsx): sweepInterruptedRuns() removes
 *   every record that is another account's, too old or unreadable, and hands
 *   nothing out. This account's records stay for their own pages to take.
 *
 * sessionStorage belongs to one tab, so nothing here reaches another tab or
 * device. Every read and write tolerates a browser that refuses storage: the
 * run then works as it did without a record, and a purge or a sweep does what
 * the browser lets it. This module imports nothing, so the last-resort error
 * page (app/global-error.tsx), which must not depend on anything that could be
 * what broke, can use it too.
 */

/** Storage key prefix. Versioned so a shape change cannot feed a stale record. */
export const INTERRUPTED_RUN_PREFIX = 'sp:interrupted-run:v1:';

/** How long after its last step a record is still handed out: an hour. */
export const INTERRUPTED_RUN_TTL_MS = 60 * 60 * 1000;

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

/**
 * Kinds of run going on in this page right now, with the account each one
 * records for (a page load clears it).
 */
const liveRuns = new Map<string, RunAccount>();

/**
 * Kinds whose run was going on in this page when it stopped being allowed to
 * keep a record: the session was ended on purpose (purgeInterruptedRuns), or
 * the shell came to render for another account (sweepInterruptedRuns). Such a
 * run writes nothing more. The mark goes when the run ends.
 */
const endedRuns = new Set<string>();

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

/** The keys of every record in this tab, of every kind (none when storage refuses). */
function recordKeys(store: Storage): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(INTERRUPTED_RUN_PREFIX)) keys.push(key);
    }
  } catch {
    /* best effort: the keys listed before the refusal */
  }
  return keys;
}

function sameAccount(a: RunAccount, b: RunAccount): boolean {
  return a.userId === b.userId && a.organizationId === b.organizationId;
}

/**
 * The stored record when `account` may still be handed it: its own, fresh,
 * and readable. Null for any other (another account's, too old, unreadable).
 */
function usableRecord(raw: string, account: RunAccount, now: number): StoredRun | null {
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
    Math.abs(now - record.at) > INTERRUPTED_RUN_TTL_MS
  ) {
    return null;
  }
  return record as StoredRun;
}

/**
 * The run of this `kind` is going on in this page, and this is what it has
 * done so far. Call it once the first save has landed and again before each
 * further Server Action. False when nothing was written: the browser refused
 * the write, or the run may keep no record any more (see endedRuns).
 */
export function recordRun(kind: string, account: RunAccount, payload: unknown): boolean {
  // The session was ended on purpose (or another account is signed in here)
  // while this run went on: it leaves nothing behind.
  if (endedRuns.has(kind)) return false;
  liveRuns.set(kind, { userId: account.userId, organizationId: account.organizationId });
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
  endedRuns.delete(kind);
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
  endedRuns.delete(kind);
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

  const record = usableRecord(raw, account, Date.now());
  return record ? parse(record.payload) : null;
}

/**
 * The session in this tab is being ended on purpose: a sign-out control, or
 * the forced sign-out when this session is revoked. Removes every record in
 * this tab, of every kind and whoever's it is, and a run still going in this
 * page writes nothing more. Call it BEFORE the sign-out request leaves: a
 * sign-out answered with a redirect never returns to the code after it, and a
 * link's page load ends this page. Never throws, so it cannot hold up or break
 * the sign-out.
 */
export function purgeInterruptedRuns(): void {
  for (const kind of liveRuns.keys()) endedRuns.add(kind);
  liveRuns.clear();
  const store = storage();
  if (!store) return;
  for (const key of recordKeys(store)) remove(store, key);
}

/**
 * The signed-in app shell is rendering for `account`. Removes every record in
 * this tab that is not this account's (another user, or the same user in
 * another organization), and every one too old or unreadable to be handed
 * out, without handing anything out: this account's records stay for their
 * own pages to take. A run of another account still going in this page writes
 * nothing more. Never throws.
 */
export function sweepInterruptedRuns(account: RunAccount): void {
  for (const [kind, owner] of liveRuns) {
    if (!sameAccount(owner, account)) {
      liveRuns.delete(kind);
      endedRuns.add(kind);
    }
  }
  const store = storage();
  if (!store) return;
  const now = Date.now();
  for (const key of recordKeys(store)) {
    let raw: string | null;
    try {
      raw = store.getItem(key);
    } catch {
      continue;
    }
    if (raw !== null && usableRecord(raw, account, now) === null) remove(store, key);
  }
}
