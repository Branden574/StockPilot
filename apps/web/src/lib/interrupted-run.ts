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
 * - beginRun() as the run starts, BEFORE its first save is sent. It writes
 *   nothing, but from then on the run is going in this page, so a sign-out (or
 *   the app shell coming to render for another account) while that first save
 *   is on its way can stop it from keeping anything (see below);
 * - recordRun() once the first save has landed and before each further action
 *   (each call rewrites the record and restarts its hour);
 * - finishRun() when the run ends on the page, which removes its record (never
 *   one that another run of its kind wrote since);
 * - leaveRunUnfinished() when a redirect (or anything else thrown) stops it,
 *   which keeps the record for the page the person comes back to;
 * - takeInterruptedRun() on that page, which hands the record over once.
 *
 * A record is handed only to the account that wrote it (the same user in the
 * same organization), only for an hour after its last step (it is there to
 * take the person back to their work after signing in again, which takes
 * minutes), and never while a run of its kind is still going in this page (a
 * person who opens the form again while a batch runs on is not interrupted).
 * Every other record it reads is removed unread: another account's, an old
 * one, one it cannot parse.
 *
 * NOTHING IS KEPT ONCE NOBODY CAN NEED IT. A Sage 50 record carries up to 50
 * rows of the import's errors, so the records also go:
 * - when the session in this tab is ended on purpose: every sign-out control
 *   calls purgeInterruptedRuns() before its request leaves (the guard
 *   lib/interrupted-run.sign-out.guard.test.ts holds every one of them to
 *   it), and so does the forced sign-out when this session is revoked
 *   (components/realtime/session-revocation-listener.tsx). A run going in
 *   this page then writes nothing more, even one whose first save is still on
 *   its way. A session that EXPIRES keeps its record, because that is what the
 *   record is for: the redirect to sign-in, or /auth/session-ended reached
 *   from the dashboard's own redirect.
 * - when the signed-in app shell renders for an account
 *   (components/dashboard/dashboard-shell.tsx): sweepInterruptedRuns() removes
 *   every record that is another account's, too old or unreadable, and hands
 *   nothing out. This account's records stay for their own pages to take. A
 *   run of another account going in this page writes nothing more.
 * - an hour after the run's last step, on whichever page of the app the tab
 *   shows: expireInterruptedRuns() runs whenever the app loads in the tab
 *   (components/auth/interrupted-run-expiry.tsx, in the root layout) and
 *   removes every record over an hour old or unreadable, whoever's it is; and
 *   while the app stays loaded (on the sign-in page the redirect left the tab
 *   on, say), a timer removes each record at its hour. A tab that has left the
 *   app for another site runs none of this until it comes back; closing it
 *   ends its sessionStorage.
 *
 * sessionStorage belongs to one tab, so nothing here reaches another tab or
 * device. Every read and write tolerates a browser that refuses storage: the
 * run then works as it did without a record, and a purge, a sweep or an expiry
 * does what the browser lets it. This module imports nothing, so the
 * last-resort error page (app/global-error.tsx), which must not depend on
 * anything that could be what broke, can use it too.
 */

/** Storage key prefix. Versioned so a shape change cannot feed a stale record. */
export const INTERRUPTED_RUN_PREFIX = 'sp:interrupted-run:v1:';

/**
 * How long after its last step a record is still handed out, and then kept in
 * the tab at all: an hour.
 */
export const INTERRUPTED_RUN_TTL_MS = 60 * 60 * 1000;

/** Whose run it is: a record is handed only to the account that wrote it. */
export interface RunAccount {
  userId: string;
  organizationId: string;
}

/** A run going on in this page, from beginRun() until it ends. */
export interface RunHandle {
  readonly kind: string;
}

interface Run extends RunHandle {
  readonly account: RunAccount;
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
 * The runs going on in this page that may still keep a record (a page load
 * clears it). A run leaves it when it ends, and also when it stops being
 * allowed to keep a record: the session was ended on purpose
 * (purgeInterruptedRuns), or the shell came to render for another account
 * (sweepInterruptedRuns). A run that left it writes nothing more, whatever
 * other runs of its kind do.
 */
const goingRuns = new Set<Run>();

/**
 * For each kind, the run that wrote the record stored now, while this page
 * holds it (a page load clears it). A run that ends on the page removes the
 * stored record only when it wrote it: never the record of another run of its
 * kind that wrote since (the New procedure form opened again while the first
 * batch runs on), nor a record this page did not write.
 */
const writers = new Map<string, Run>();

/** The timer that removes the next record to reach its hour while this page stays open. */
let expiry: { timer: ReturnType<typeof setTimeout>; due: number } | null = null;

/** How long after a record's hour its timer fires, so the record is past it when checked. */
const EXPIRY_SLACK_MS = 1000;

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

/** A stored record whose shape is readable, whoever's it is; null for any other. */
function readable(raw: string): StoredRun | null {
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
    typeof record.userId !== 'string' ||
    typeof record.organizationId !== 'string' ||
    typeof record.at !== 'number' ||
    !Number.isFinite(record.at)
  ) {
    return null;
  }
  return record as StoredRun;
}

function withinHour(record: StoredRun, now: number): boolean {
  return Math.abs(now - record.at) <= INTERRUPTED_RUN_TTL_MS;
}

/**
 * The stored record when `account` may still be handed it: its own, fresh,
 * and readable. Null for any other (another account's, too old, unreadable).
 */
function usableRecord(raw: string, account: RunAccount, now: number): StoredRun | null {
  const record = readable(raw);
  if (
    record === null ||
    record.userId !== account.userId ||
    record.organizationId !== account.organizationId ||
    !withinHour(record, now)
  ) {
    return null;
  }
  return record;
}

/** Cancels the timer, if any: nothing is left to remove at its hour, or a new one follows. */
function stopExpiry(): void {
  if (expiry === null) return;
  clearTimeout(expiry.timer);
  expiry = null;
}

/** Makes sure a timer runs expireInterruptedRuns() once the record due at `due` is past its hour. */
function armExpiry(due: number): void {
  if (expiry !== null && expiry.due <= due) return;
  if (expiry !== null) clearTimeout(expiry.timer);
  const delay = Math.max(0, due - Date.now()) + EXPIRY_SLACK_MS;
  expiry = { due, timer: setTimeout(expireInterruptedRuns, delay) };
}

/**
 * A run of this `kind` is starting in this page for `account`: call it BEFORE
 * the run's first save is sent. It writes nothing. From now until the run ends
 * (finishRun or leaveRunUnfinished), it is going in this page: a purge, or a
 * sweep for another account, stops it from keeping any record, even before its
 * first one. Never throws.
 */
export function beginRun(kind: string, account: RunAccount): RunHandle {
  const run: Run = {
    kind,
    account: { userId: account.userId, organizationId: account.organizationId },
  };
  goingRuns.add(run);
  return run;
}

/**
 * The run is still going, and this is what it has done so far. Call it once
 * the first save has landed and again before each further Server Action. False
 * when nothing was written: the browser refused the write, or the run may keep
 * no record any more (it was stopped by a purge or a sweep, or it has ended).
 */
export function recordRun(run: RunHandle, payload: unknown): boolean {
  const going = run as Run;
  if (!goingRuns.has(going)) return false;
  const store = storage();
  if (!store) return false;
  const record: StoredRun = {
    v: 1,
    userId: going.account.userId,
    organizationId: going.account.organizationId,
    at: Date.now(),
    payload,
  };
  try {
    store.setItem(INTERRUPTED_RUN_PREFIX + going.kind, JSON.stringify(record));
  } catch {
    return false;
  }
  writers.set(going.kind, going);
  armExpiry(record.at + INTERRUPTED_RUN_TTL_MS);
  return true;
}

/**
 * The run ended on the page, which showed its outcome: its record goes. A run
 * that was stopped (its record went with the purge or the sweep), recorded
 * nothing, or whose record another run of its kind has written over since,
 * leaves what is stored to the run that wrote it.
 */
export function finishRun(run: RunHandle): void {
  const going = run as Run;
  if (!goingRuns.delete(going) || writers.get(going.kind) !== going) return;
  writers.delete(going.kind);
  const store = storage();
  if (store) remove(store, INTERRUPTED_RUN_PREFIX + going.kind);
}

/**
 * A redirect (or anything else thrown) stopped the run before it ended on the
 * page (the browser is on its way to sign-in). The run is over here, and its
 * record stays for the page the person comes back to.
 */
export function leaveRunUnfinished(run: RunHandle): void {
  goingRuns.delete(run as Run);
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
  for (const going of goingRuns) if (going.kind === kind) return null;
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
  writers.delete(kind);

  const record = usableRecord(raw, account, Date.now());
  return record ? parse(record.payload) : null;
}

/**
 * The session in this tab is being ended on purpose: a sign-out control, or
 * the forced sign-out when this session is revoked. Removes every record in
 * this tab, of every kind and whoever's it is, and every run going in this
 * page writes nothing more, even one whose first save is still on its way.
 * Call it BEFORE the sign-out request leaves: a sign-out answered with a
 * redirect never returns to the code after it, and a page load ends this page.
 * Never throws, so it cannot hold up or break the sign-out.
 */
export function purgeInterruptedRuns(): void {
  goingRuns.clear();
  writers.clear();
  stopExpiry();
  const store = storage();
  if (!store) return;
  for (const key of recordKeys(store)) remove(store, key);
}

/**
 * The signed-in app shell is rendering for `account`. Removes every record in
 * this tab that is not this account's (another user, or the same user in
 * another organization), and every one too old or unreadable to be handed
 * out, without handing anything out: this account's records stay for their
 * own pages to take. A run of another account going in this page writes
 * nothing more, even one whose first save is still on its way. Never throws.
 */
export function sweepInterruptedRuns(account: RunAccount): void {
  for (const going of goingRuns) {
    if (!sameAccount(going.account, account)) goingRuns.delete(going);
  }
  for (const [kind, writer] of writers) {
    if (!sameAccount(writer.account, account)) writers.delete(kind);
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

/**
 * The app has loaded in this tab (components/auth/interrupted-run-expiry runs
 * it then), or the timer it set is due. Removes every record over an hour old,
 * or unreadable, whoever's it is, and hands nothing out: a fresh record stays
 * for its account's page, as on the sign-in page an expired session left the
 * tab on. Then, while the app stays loaded, removes each remaining record at
 * its hour. Never throws.
 */
export function expireInterruptedRuns(): void {
  stopExpiry();
  const store = storage();
  if (!store) return;
  const now = Date.now();
  let next = Infinity;
  for (const key of recordKeys(store)) {
    let raw: string | null;
    try {
      raw = store.getItem(key);
    } catch {
      continue;
    }
    if (raw === null) continue;
    const record = readable(raw);
    if (record === null || !withinHour(record, now)) remove(store, key);
    else next = Math.min(next, record.at + INTERRUPTED_RUN_TTL_MS);
  }
  if (next !== Infinity) armExpiry(next);
}
