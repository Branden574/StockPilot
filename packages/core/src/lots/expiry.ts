/**
 * Pure lot-expiry + FEFO helpers (Phase 5 — food vertical). No DB, no I/O.
 * The LIGHT model carries no per-lot stock; these helpers only derive expiry
 * dates, classify them into urgency buckets, and order lots earliest-first.
 */

export type ExpiryBucket = 'expired' | 'le7' | 'le30' | 'le90' | 'ok' | 'unknown';

export interface LotExpiryInput {
  /** Explicit captured expiration date (YYYY-MM-DD) or null. */
  expirationDate: string | null;
  /** When the lot was received (ISO timestamp) — fallback anchor for shelf life. */
  receivedAt: string;
}

export interface ItemExpiryConfig {
  /** Per-item shelf life in days, or null when not configured. */
  shelfLifeDays: number | null;
}

/**
 * Effective expiry for a lot: the explicit captured date if present; else
 * receivedAt + shelfLifeDays; else null (unknowable — sorts last in FEFO).
 */
export function computeLotExpiry(lot: LotExpiryInput, item: ItemExpiryConfig): Date | null {
  if (lot.expirationDate) {
    const d = new Date(lot.expirationDate);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (item.shelfLifeDays && item.shelfLifeDays > 0) {
    const base = new Date(lot.receivedAt);
    if (Number.isNaN(base.getTime())) return null;
    return new Date(base.getTime() + item.shelfLifeDays * 24 * 60 * 60 * 1000);
  }
  return null;
}

/** Urgency bucket for an effective expiry relative to `now`. */
export function expiryBucket(expiry: Date | null, now: Date): ExpiryBucket {
  if (!expiry) return 'unknown';
  const ms = expiry.getTime() - now.getTime();
  if (ms <= 0) return 'expired';
  const days = ms / (24 * 60 * 60 * 1000);
  if (days <= 7) return 'le7';
  if (days <= 30) return 'le30';
  if (days <= 90) return 'le90';
  return 'ok';
}

/**
 * FEFO order: ascending by effective expiry, with null/unknown expiry LAST
 * (you can't first-expire what has no date). Pure — returns a new array.
 */
export function sortLotsFefo<T extends { expiry: Date | null }>(lots: readonly T[]): T[] {
  return [...lots].sort((a, b) => {
    if (a.expiry === null && b.expiry === null) return 0;
    if (a.expiry === null) return 1;
    if (b.expiry === null) return -1;
    return a.expiry.getTime() - b.expiry.getTime();
  });
}
