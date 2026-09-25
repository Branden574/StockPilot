import * as React from 'react';

/**
 * UNCONFIRMED STOCK — which items' on-hand totals the phone cannot vouch for,
 * because an adjustment it sent may still be committing on the server.
 *
 * ═══ WHY A READ IS NOT ENOUGH TO CLEAR IT ═══
 *
 * An adjustment is UNCONFIRMED when the phone never heard the answer: a
 * dropped connection, api()'s 20 s timeout, or a 5xx (item-adjust.ts). The
 * write may have committed, may never commit, or may STILL BE RUNNING: the
 * server keeps going after the phone stops waiting. The item screen used to
 * re-read the item at once and treat that read as the confirmed total, so a
 * read that beat a slow write to the database repainted the pre-write number
 * as current and cleared the label. The write then landed and the number on
 * screen was stale, with nothing saying so.
 *
 * So the label stays until one of two things is true:
 *
 *   1. A read shows the total this write would produce (the server total the
 *      operator saw when they sent it, plus the delta). The write landed.
 *   2. A read STARTED after the write can no longer land. Whatever that read
 *      says is current, because nothing still in flight can change it.
 *
 * ═══ WHERE THE BOUND COMES FROM ═══
 *
 * UNCONFIRMED_SETTLE_MS is measured from the moment the phone SENT the
 * request. The adjust route pins `maxDuration = 30` (apps/web/src/app/api/v1/
 * items/[id]/adjust/route.ts); without that pin it inherits the project's
 * 300 s Fluid-compute default. The RPC it runs is bounded by the
 * authenticated role's 8 s statement_timeout (pg_roles, read 2026-09-22), and
 * production logs show 1-8 s stalls at the Supabase gateway on 3-5% of calls
 * (2026-09-22). 30 + 8 + 8 = 46 s, plus the trip to Vercel and PostgREST's
 * connection-pool wait. 90 s leaves room for all of it; the only cost of a
 * longer bound is a label that stays up longer on a write that never landed.
 *
 * ═══ ONE STORE FOR THE APP, KEYED BY ITEM ═══
 *
 * The fact belongs to the ITEM, not the screen that sent the write: leave the
 * item screen and come back, or adjust on the scan tab and open the item, and
 * the doubt must travel with it. Module state lives as long as the JS runtime.
 *
 * Known limit, stated rather than hidden: rule 1 compares totals, so a
 * concurrent adjustment by someone else that happens to produce the same
 * total clears the label early. Proving the write itself would need a
 * stock_movements read per check; the brief was no extra reads.
 */

/** How long after SENDING an adjustment it can still commit. See header. */
export const UNCONFIRMED_SETTLE_MS = 90_000;

export interface UnconfirmedStock {
  /**
   * The on-hand total that proves the outstanding write landed. Null once no
   * single total can: a second write was sent while this one was outstanding,
   * or the write is known to have committed but its total was not returned.
   */
  expectedTotal: number | null;
  /** Epoch ms after which nothing outstanding can still commit. */
  settlesAt: number;
  /**
   * True while `settlesAt` is still ahead. Drives the wording only ("may still
   * be saving" vs "refresh to check"): a label that says "may still be
   * saving" three minutes later is its own small lie.
   */
  mayStillLand: boolean;
}

// ─── Pure transitions (unit-tested; the store below only sequences them) ───

/** A write whose outcome is unknown, on top of whatever was outstanding. */
export function addOutstanding(
  prev: UnconfirmedStock | null,
  next: { expectedTotal: number | null; settlesAt: number; now: number },
): UnconfirmedStock {
  // Two writes in doubt: neither "base + delta" identifies the pair (one may
  // land and the other not), so only the later bound can clear the label.
  const settlesAt = prev ? Math.max(prev.settlesAt, next.settlesAt) : next.settlesAt;
  return {
    expectedTotal: prev ? null : next.expectedTotal,
    settlesAt,
    mayStillLand: settlesAt > next.now,
  };
}

/**
 * The server CONFIRMED a later write while an earlier one is still in doubt.
 * Its total is right now, but the earlier write may still land on top of it,
 * and the earlier "base + delta" no longer describes any total we could see.
 */
export function afterConfirmedWrite(prev: UnconfirmedStock | null): UnconfirmedStock | null {
  if (!prev || prev.expectedTotal === null) return prev;
  return { ...prev, expectedTotal: null };
}

/**
 * A server read of the item's on-hand total. Clears the doubt when the read
 * shows the write (rule 1) or began after nothing could still land (rule 2).
 * `startedAt` is when the read was SENT: a read sent before the bound can have
 * been answered before a late write committed, however late it returns.
 */
export function afterRead(
  prev: UnconfirmedStock | null,
  read: { total: number; startedAt: number },
): UnconfirmedStock | null {
  if (!prev) return null;
  if (read.startedAt >= prev.settlesAt) return null;
  if (prev.expectedTotal !== null && read.total === prev.expectedTotal) return null;
  return prev;
}

/** The bound has passed: nothing can still land, a fresh read will settle it. */
export function afterBound(prev: UnconfirmedStock | null, now: number): UnconfirmedStock | null {
  if (!prev || !prev.mayStillLand || prev.settlesAt > now) return prev;
  return { ...prev, mayStillLand: false };
}

// ─── The store ──────────────────────────────────────────────────────────────

let entries: ReadonlyMap<string, UnconfirmedStock> = new Map();
const listeners = new Set<() => void>();
const boundTimers = new Map<string, ReturnType<typeof setTimeout>>();
const boundListeners = new Map<string, Set<() => void>>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function put(itemId: string, next: UnconfirmedStock | null): void {
  const prev = entries.get(itemId) ?? null;
  if (prev === next) return;
  const copy = new Map(entries);
  if (next) copy.set(itemId, next);
  else copy.delete(itemId);
  entries = copy;
  scheduleBound(itemId, next);
  for (const l of listeners) l();
}

/**
 * One timer per item, at its bound. When it fires the label changes wording
 * and every screen showing the item re-reads it once (onBoundPassed): that
 * read starts after the bound, so it settles the doubt. This is the only read
 * the doubt adds, and only an unconfirmed adjustment ever creates one.
 */
function scheduleBound(itemId: string, entry: UnconfirmedStock | null): void {
  const existing = boundTimers.get(itemId);
  if (existing !== undefined) {
    clearTimeout(existing);
    boundTimers.delete(itemId);
  }
  if (!entry || !entry.mayStillLand) return;
  // +250 ms so the read the timer triggers is unambiguously sent after the
  // bound, whatever the timer's own jitter.
  const delay = Math.max(0, entry.settlesAt - Date.now()) + 250;
  boundTimers.set(
    itemId,
    setTimeout(() => {
      boundTimers.delete(itemId);
      put(itemId, afterBound(entries.get(itemId) ?? null, Date.now()));
      for (const cb of boundListeners.get(itemId) ?? []) cb();
    }, delay),
  );
}

export const unconfirmedStock = {
  get(itemId: string): UnconfirmedStock | null {
    return entries.get(itemId) ?? null;
  },
  /** The request was sent at `sentAt` and no answer came back. */
  markUnconfirmed(
    itemId: string,
    write: { shownTotal: number; delta: number; sentAt: number },
  ): void {
    put(
      itemId,
      addOutstanding(entries.get(itemId) ?? null, {
        expectedTotal: write.shownTotal + write.delta,
        settlesAt: write.sentAt + UNCONFIRMED_SETTLE_MS,
        now: Date.now(),
      }),
    );
  },
  /**
   * The write committed (2xx) but the answer carried no total, so the one on
   * screen is known to be old. Any read sent after `answeredAt` settles it.
   */
  markCommittedWithoutTotal(itemId: string, answeredAt: number): void {
    put(
      itemId,
      addOutstanding(entries.get(itemId) ?? null, {
        expectedTotal: null,
        settlesAt: answeredAt,
        now: answeredAt,
      }),
    );
  },
  /** The write committed and its total is on screen. */
  markConfirmed(itemId: string): void {
    put(itemId, afterConfirmedWrite(entries.get(itemId) ?? null));
  },
  /** Every server read of the item's total reports here. */
  recordRead(itemId: string, total: number, startedAt: number): void {
    put(itemId, afterRead(entries.get(itemId) ?? null, { total, startedAt }));
  },
  /**
   * Call as a read of the item is SENT; call what it returns with the total
   * the read came back with. The send time is what the read is judged on (a
   * read sent before a slow write committed shows the old total however late
   * it returns), so it is taken here rather than trusted to each caller.
   */
  beginRead(itemId: string): (total: number) => void {
    const startedAt = Date.now();
    return (total) => unconfirmedStock.recordRead(itemId, total, startedAt);
  },
  /** Called when `itemId`'s bound passes. Returns the unsubscribe. */
  onBoundPassed(itemId: string, cb: () => void): () => void {
    let set = boundListeners.get(itemId);
    if (!set) {
      set = new Set();
      boundListeners.set(itemId, set);
    }
    set.add(cb);
    return () => {
      const s = boundListeners.get(itemId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) boundListeners.delete(itemId);
    };
  },
  /** Tests only: forget everything, including pending timers. */
  resetForTests(): void {
    for (const t of boundTimers.values()) clearTimeout(t);
    boundTimers.clear();
    boundListeners.clear();
    entries = new Map();
    for (const l of listeners) l();
  },
};

/** The doubt over one item's on-hand total, or null when there is none. */
export function useUnconfirmedStock(itemId: string | null | undefined): UnconfirmedStock | null {
  const getSnapshot = React.useCallback(
    () => (itemId ? (entries.get(itemId) ?? null) : null),
    [itemId],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
