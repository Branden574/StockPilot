import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number, currency = 'USD', locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

export function formatNumber(value: number, locale = 'en-US') {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatRelative(date: Date | string, now: Date = new Date()) {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = (d.getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs || unit === 'second') {
      return rtf.format(Math.round(diff / secs), unit);
    }
  }
  return '';
}

/** Short calendar date, e.g. "Apr 18". Returns "—" for null/invalid input. */
export function formatDateShort(
  date: Date | string | null | undefined,
  locale = 'en-US',
) {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(d);
}

export function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
}

/** 36^3. The sequence wraps here, and no single millisecond mints that many. */
const SKU_SEQ_MODULO = 46_656;
/**
 * Process-local, monotonic. Started at a random offset so two server instances
 * minting in the same millisecond do not march in lockstep from zero.
 */
let skuSequence = Math.floor(Math.random() * SKU_SEQ_MODULO);

/** `n` base36 characters, ALWAYS `n` of them. `Math.random().toString(36)` is
 *  variable-width — `(0.5).toString(36)` is '0.i' — so slicing it is not a
 *  fixed-width draw and silently narrows the space on a slice of calls. */
function randomBase36(n: number): string {
  let out = '';
  while (out.length < n) {
    out += Math.random().toString(36).slice(2);
  }
  return out.slice(0, n).toUpperCase();
}

/**
 * A SKU for an item whose caller supplied none.
 *
 * Shape is unchanged (`PREFIX-STAMP-TAIL`, uppercase base36) — nothing in the
 * codebase parses a SKU, but every row in every org looks like this and the
 * import matcher compares old rows against new ones.
 *
 * COLLISION RESISTANCE (review finding). The tail used to be three random
 * base36 characters, and within one millisecond the stamp is fixed — so the
 * whole space was 46,656 draws, and a 5,000-row import spread over a second was
 * ~1,000 birthday trials against it. Measured: 159 duplicates per 10,000 mints.
 * Every one of those becomes a 23505 on `inventory_items_org_sku_uniq` and
 * surfaces to the user as "A item with that SKU already exists" on a row that
 * was perfectly fine. Six-wide CSV imports make same-millisecond mints the norm
 * rather than the exception, which is what turned a latent flaw into a real one.
 *
 * The sequence is what makes this a guarantee rather than longer odds: two
 * mints in the same millisecond cannot share one until 46,656 have gone by. The
 * four random characters carry the cross-process case, where two instances can
 * hold the same sequence value.
 */
export function generateSku(prefix = 'SP') {
  const stamp = Date.now().toString(36).toUpperCase().slice(-5);
  skuSequence = (skuSequence + 1) % SKU_SEQ_MODULO;
  const seq = skuSequence.toString(36).toUpperCase().padStart(3, '0');
  return `${prefix}-${stamp}-${seq}${randomBase36(4)}`;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function getEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing env: ${name}`);
  }
  return v;
}
