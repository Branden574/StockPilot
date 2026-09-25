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
 * So a write in doubt stays until one of two things is true OF THAT WRITE:
 *
 *   1. Its own confirmation: a read shows the total this write would produce
 *      (the server total the operator saw when they sent it, plus the delta),
 *      and no other write of the item is in doubt or in flight.
 *   2. Its own expiry: a read STARTED after this write can no longer land.
 *      Whatever that read says cannot be changed by this write any more.
 *
 * ═══ ONE ENTRY PER WRITE, NOT ONE PER ITEM ═══
 *
 * An earlier draft of this store (2026-09-22, never merged) held a single doubt
 * per item, and a second adjustment sent while the first was unconfirmed only
 * switched off rule 1 when its ANSWER arrived. While it was in flight, a read
 * showing "first write's base + delta" cleared the first write's label,
 * although that total may have been the SECOND write landing (base + its
 * delta) with the first still running. The first then landed on top, and the
 * total on screen was stale with no label.
 *
 * Each write is now its own entry, created when it is SENT (phase 'sending')
 * and ended only by its own answer, its own confirmation or its own expiry:
 *
 *   • While any other write of the item exists, in flight or in doubt, rule 1
 *     cannot clear a write: no single total identifies which of them landed.
 *   • A write that may have moved the stock (answered 2xx, or no answer at
 *     all) switches rule 1 off for every OTHER write for good: their "base +
 *     delta" no longer describes any total the phone could see.
 *   • A write the server REFUSED wrote nothing, so it leaves the others' rule
 *     1 as it found it.
 *   • A write sent while another was outstanding never gets a rule 1 of its
 *     own: the total on screen when it was sent was not a settled base.
 *
 * A write in flight never labels the number by itself (every tap is briefly
 * in flight; its answer repaints the total); only unconfirmed writes, and
 * writes that committed without returning a total, do.
 *
 * ═══ WHERE THE BOUND COMES FROM ═══
 *
 * UNCONFIRMED_SETTLE_MS is measured from the moment api() HANDED THE REQUEST
 * TO fetch (item-adjust.ts takes it from api()'s onSend hook). Not from the
 * tap: api() first awaits the session, and a token refresh there can take
 * seconds, so a window started at the tap could end while the request had
 * only just left. The adjust route pins `maxDuration = 30` (apps/web/src/app/
 * api/v1/items/[id]/adjust/route.ts); without that pin it inherits the
 * project's 300 s Fluid-compute default. The RPC it runs is bounded by the
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

/** How long after the request is handed to fetch it can still commit. See header. */
export const UNCONFIRMED_SETTLE_MS = 90_000;

/** One adjustment of one item, from the moment it is sent until it settles. */
export interface PendingWrite {
  /**
   * 'sending': sent, no answer yet. Its answer always comes (api() has its own
   *   timeout), so only the answer ends it; a read cannot.
   * 'unconfirmed': no answer came. It may have landed or may still land.
   * 'committed': a 2xx without the total, so the total on screen predates it.
   */
  phase: 'sending' | 'unconfirmed' | 'committed';
  /** The on-hand total that proves THIS write landed, or null when none can. */
  expectedTotal: number | null;
  /** Epoch ms after which this write can no longer commit. Null while sending. */
  settlesAt: number | null;
  /** True while `settlesAt` is still ahead. Drives the wording only. */
  mayStillLand: boolean;
}

/** An item's writes, keyed by a per-app write id. */
export type ItemWrites = ReadonlyMap<number, PendingWrite>;

/** How the server answered one write (item-adjust.ts decides which). */
export type WriteAnswer =
  | { kind: 'refused' }
  | { kind: 'confirmed' }
  | { kind: 'committedWithoutTotal'; answeredAt: number }
  | { kind: 'unconfirmed'; settlesAt: number; now: number };

/** What a screen shows: the item's doubt as a whole, or null when there is none. */
export interface UnconfirmedStock {
  /**
   * The on-hand total that proves the outstanding write landed. Null once no
   * single total can: more than one write is outstanding, or the write is
   * known to have committed but its total was not returned.
   */
  expectedTotal: number | null;
  /** Epoch ms after which nothing outstanding can still commit. */
  settlesAt: number;
  /**
   * True while a write in doubt can still land. Drives the wording only ("may
   * still be saving" vs "refresh to check"): a label that says "may still be
   * saving" three minutes later is its own small lie.
   */
  mayStillLand: boolean;
}

// ─── Pure transitions (unit-tested; the store below only sequences them) ───

/**
 * A write was sent. `expectedTotal` is the total on screen plus its delta, or
 * null when the sender saw no total (a queued adjustment the outbox drain
 * sends: no read can prove it, so only its bound ends it).
 */
export function startWrite(
  writes: ItemWrites,
  id: number,
  sent: { expectedTotal: number | null },
): ItemWrites {
  const next = new Map(writes);
  next.set(id, {
    phase: 'sending',
    // With another write outstanding, the total on screen is not the base
    // this delta lands on, so no total can prove this one.
    expectedTotal: writes.size === 0 ? sent.expectedTotal : null,
    settlesAt: null,
    mayStillLand: true,
  });
  return next;
}

/** The answer (or the lack of one) to write `id`. */
export function answerWrite(writes: ItemWrites, id: number, answer: WriteAnswer): ItemWrites {
  const own = writes.get(id);
  if (!own) return writes;
  const next = new Map(writes);
  if (answer.kind === 'refused') {
    // Nothing was written, so the others' base + delta still holds.
    next.delete(id);
    return next;
  }
  // This write may have moved the stock: no other write's base + delta
  // describes a total the phone could see any more.
  for (const [otherId, w] of writes) {
    if (otherId !== id && w.expectedTotal !== null) {
      next.set(otherId, { ...w, expectedTotal: null });
    }
  }
  if (answer.kind === 'confirmed') {
    next.delete(id);
  } else if (answer.kind === 'committedWithoutTotal') {
    next.set(id, {
      phase: 'committed',
      expectedTotal: null,
      settlesAt: answer.answeredAt,
      mayStillLand: false,
    });
  } else {
    next.set(id, {
      phase: 'unconfirmed',
      expectedTotal: own.expectedTotal,
      settlesAt: answer.settlesAt,
      mayStillLand: answer.settlesAt > answer.now,
    });
  }
  return next;
}

/**
 * A server read of the item's on-hand total. Ends each write it proves (rule
 * 1, only while that write is the item's only one) or that it began after
 * (rule 2). `startedAt` is when the read was SENT: a read sent before a
 * write's bound can have been answered before that write committed, however
 * late it returns. A write in flight is left to its own answer.
 */
export function readWrites(
  writes: ItemWrites,
  read: { total: number; startedAt: number },
): ItemWrites {
  let next: Map<number, PendingWrite> | null = null;
  for (const [id, w] of writes) {
    if (w.phase === 'sending') continue;
    const expired = w.settlesAt !== null && read.startedAt >= w.settlesAt;
    const proved = writes.size === 1 && w.expectedTotal !== null && read.total === w.expectedTotal;
    if (expired || proved) {
      next ??= new Map(writes);
      next.delete(id);
    }
  }
  return next ?? writes;
}

/** Bounds have passed: those writes can no longer land (wording only). */
export function boundWrites(writes: ItemWrites, now: number): ItemWrites {
  let next: Map<number, PendingWrite> | null = null;
  for (const [id, w] of writes) {
    if (w.phase === 'unconfirmed' && w.mayStillLand && w.settlesAt !== null && w.settlesAt <= now) {
      next ??= new Map(writes);
      next.set(id, { ...w, mayStillLand: false });
    }
  }
  return next ?? writes;
}

/** The label a screen shows for an item's writes, or null for none. */
export function summarize(writes: ItemWrites): UnconfirmedStock | null {
  let labelled = 0;
  let settlesAt = 0;
  let mayStillLand = false;
  let lone: PendingWrite | null = null;
  for (const w of writes.values()) {
    lone = w;
    if (w.phase === 'sending' || w.settlesAt === null) continue;
    labelled++;
    settlesAt = Math.max(settlesAt, w.settlesAt);
    mayStillLand ||= w.mayStillLand;
  }
  if (labelled === 0) return null;
  return {
    expectedTotal: writes.size === 1 ? (lone?.expectedTotal ?? null) : null,
    settlesAt,
    mayStillLand,
  };
}

// ─── The store ──────────────────────────────────────────────────────────────

interface ItemEntry {
  writes: ItemWrites;
  /** Cached so useSyncExternalStore sees one reference until it changes. */
  summary: UnconfirmedStock | null;
}

const NO_WRITES: ItemWrites = new Map();
let entries: ReadonlyMap<string, ItemEntry> = new Map();
let nextWriteId = 1;
const listeners = new Set<() => void>();
const boundTimers = new Map<string, ReturnType<typeof setTimeout>>();
const boundListeners = new Map<string, Set<() => void>>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function writesOf(itemId: string): ItemWrites {
  return entries.get(itemId)?.writes ?? NO_WRITES;
}

function sameSummary(a: UnconfirmedStock | null, b: UnconfirmedStock | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.expectedTotal === b.expectedTotal &&
    a.settlesAt === b.settlesAt &&
    a.mayStillLand === b.mayStillLand
  );
}

function put(itemId: string, next: ItemWrites): void {
  const prev = entries.get(itemId);
  if ((prev?.writes ?? NO_WRITES) === next) return;
  const copy = new Map(entries);
  const summary = summarize(next);
  const prevSummary = prev?.summary ?? null;
  if (next.size === 0) copy.delete(itemId);
  else {
    // A write going out or a doubt that did not change keeps the reference,
    // so screens re-render only when the label does.
    copy.set(itemId, {
      writes: next,
      summary: sameSummary(prevSummary, summary) ? prevSummary : summary,
    });
  }
  entries = copy;
  scheduleBound(itemId, next);
  for (const l of listeners) l();
}

/**
 * One timer per item, at the earliest bound still ahead. When it fires the
 * writes past their bound change wording and every screen showing the item
 * re-reads it once (onBoundPassed): that read starts after those bounds, so it
 * ends those writes. These are the only reads the doubt adds, and only an
 * unconfirmed adjustment ever creates one.
 */
function scheduleBound(itemId: string, writes: ItemWrites): void {
  const existing = boundTimers.get(itemId);
  if (existing !== undefined) {
    clearTimeout(existing);
    boundTimers.delete(itemId);
  }
  let earliest: number | null = null;
  for (const w of writes.values()) {
    if (w.phase !== 'unconfirmed' || !w.mayStillLand || w.settlesAt === null) continue;
    earliest = earliest === null ? w.settlesAt : Math.min(earliest, w.settlesAt);
  }
  if (earliest === null) return;
  // +250 ms so the read the timer triggers is unambiguously sent after the
  // bound, whatever the timer's own jitter.
  const delay = Math.max(0, earliest - Date.now()) + 250;
  boundTimers.set(
    itemId,
    setTimeout(() => {
      boundTimers.delete(itemId);
      put(itemId, boundWrites(writesOf(itemId), Date.now()));
      for (const cb of boundListeners.get(itemId) ?? []) cb();
    }, delay),
  );
}

/** What the sender reports about ONE write. Each call after the first is ignored. */
export interface WriteHandle {
  /** The server refused it (4xx): nothing was written. */
  refused(): void;
  /** Written, and the total it returned is the one on screen. */
  confirmed(): void;
  /** Written (2xx) without a total: any read sent after `answeredAt` settles it. */
  committedWithoutTotal(answeredAt: number): void;
  /**
   * No answer. `sentAt` is when the request was handed to fetch, or any later
   * moment when that is unknown: a later start only keeps the label longer.
   */
  unconfirmed(sentAt: number): void;
}

export const unconfirmedStock = {
  /** The item's doubt as the screens show it, or null when there is none. */
  get(itemId: string): UnconfirmedStock | null {
    return entries.get(itemId)?.summary ?? null;
  },
  /** Every write of the item not yet settled, in flight ones included. */
  writes(itemId: string): ItemWrites {
    return writesOf(itemId);
  },
  /**
   * Call as an adjustment is about to be sent, with the total on screen and
   * the delta; report its answer on the handle. Registered BEFORE the request
   * leaves, so a read that returns while it is in flight cannot be taken as
   * proof of another write.
   */
  beginWrite(itemId: string, sent: { shownTotal: number; delta: number }): WriteHandle {
    const id = nextWriteId++;
    put(itemId, startWrite(writesOf(itemId), id, { expectedTotal: sent.shownTotal + sent.delta }));
    let answered = false;
    const answer = (a: WriteAnswer) => {
      if (answered) return;
      answered = true;
      put(itemId, answerWrite(writesOf(itemId), id, a));
    };
    return {
      refused: () => answer({ kind: 'refused' }),
      confirmed: () => answer({ kind: 'confirmed' }),
      committedWithoutTotal: (answeredAt) => answer({ kind: 'committedWithoutTotal', answeredAt }),
      unconfirmed: (sentAt) =>
        answer({ kind: 'unconfirmed', settlesAt: sentAt + UNCONFIRMED_SETTLE_MS, now: Date.now() }),
    };
  },
  /**
   * An adjustment the OUTBOX DRAIN sent got no answer (sync.ts; the row is
   * parked "Not confirmed", adjust-outbox.ts). The drain saw no total, so no
   * read can prove the write: the item stays labelled until a read sent after
   * `sentAt` + UNCONFIRMED_SETTLE_MS. Without this, the item screen re-read
   * the item the moment the row left the outbox and showed a total the write
   * could still change, with no label, next to the instruction to check it.
   */
  recordUnconfirmed(itemId: string, sentAt: number): void {
    const id = nextWriteId++;
    const started = startWrite(writesOf(itemId), id, { expectedTotal: null });
    put(
      itemId,
      answerWrite(started, id, {
        kind: 'unconfirmed',
        settlesAt: sentAt + UNCONFIRMED_SETTLE_MS,
        now: Date.now(),
      }),
    );
  },
  /** Every server read of the item's total reports here. */
  recordRead(itemId: string, total: number, startedAt: number): void {
    put(itemId, readWrites(writesOf(itemId), { total, startedAt }));
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
  /** Called when one of `itemId`'s bounds passes. Returns the unsubscribe. */
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
    () => (itemId ? (entries.get(itemId)?.summary ?? null) : null),
    [itemId],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
