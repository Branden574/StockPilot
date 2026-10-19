import type { DeltaToken } from './types';

/**
 * The delta tokens the Overview prints beside its figures, computed from a
 * series that runs oldest to newest (today last).
 *
 * Pure, with no server or client import, so the page (the key stats, from the
 * request's series) and the value card's client island (the line it is
 * drawing) say the same thing for the same line. Moved here unchanged from the
 * Overview page.
 */

/**
 * When the first point is at or near zero (a fresh org loading inventory, or
 * floating-point dust from the reverse walk), a percentage explodes into
 * astronomical garbage, so it reads "new" instead. The 1.0 threshold absorbs a
 * near-zero start while "1 unit -> 100 units" still reads as real growth.
 */
const NEAR_ZERO = 1.0;
/** Legitimate huge growth reads as a token, never a 17-digit number. */
const MAX_DISPLAY_PCT = 999;

/** Today against the first point, in percent: "+4.2%", "new", "—", "+999%+". */
export function percentDelta(series: readonly number[]): DeltaToken {
  const head = series[0] ?? 0;
  const tail = series.at(-1) ?? 0;
  if (Math.abs(head) < NEAR_ZERO && Math.abs(tail) < NEAR_ZERO) {
    return { label: '—', direction: 'flat' };
  }
  if (Math.abs(head) < NEAR_ZERO) {
    return { label: 'new', direction: 'up' };
  }
  const pct = ((tail - head) / head) * 100;
  if (Math.abs(pct) < 0.05) return { label: '—', direction: 'flat' };
  if (Math.abs(pct) > MAX_DISPLAY_PCT) {
    return {
      label: `${pct > 0 ? '+' : '−'}${MAX_DISPLAY_PCT}%+`,
      direction: pct > 0 ? 'up' : 'down',
    };
  }
  const rounded = pct.toFixed(1);
  return {
    label: `${pct > 0 ? '+' : ''}${rounded}%`,
    direction: pct > 0 ? 'up' : 'down',
  };
}

/**
 * Today against the first point as a raw count, for a figure where MORE is
 * worse (low / out of stock): the direction is inverted, so a rise reads as
 * "down" (the destructive tone).
 */
export function worseWhenUpDelta(series: readonly number[]): DeltaToken {
  const head = series[0] ?? 0;
  const tail = series.at(-1) ?? 0;
  const diff = tail - head;
  if (diff === 0) return { label: '—', direction: 'flat' };
  return {
    label: `${diff > 0 ? '+' : ''}${diff}`,
    direction: diff > 0 ? 'down' : 'up',
  };
}
