import { vi } from 'vitest';

/**
 * TEST-ONLY. An Intl that behaves the way Hermes on iOS does, built from this
 * runtime's own parts. Measured 2026-09-26 by running the app's own Hermes
 * (hermes-engine 250829098.0.16, the macOS slice of hermesvm: the same Apple
 * Intl code as iOS) through JSI; rentals/emails.test.ts pins the arrays it
 * returned.
 *   - A date alone, or a time alone: every part typed, a narrow no-break
 *     space (U+202F) before AM or PM.
 *   - A date AND a time: joined with " at " ("Sep 23 at 3:00 PM"), and
 *     formatToParts types only the date fields. From the quoted "at" on,
 *     every piece ("3", ":", "00", "PM") comes back as type "literal".
 *   - Literals come back one piece per run of letters or digits, or per
 *     other character (", " is "," then " ").
 * toLocaleString and toLocaleTimeString are that engine's format() too.
 *
 * Shared by the rental times (rentals/emails.test.ts) and the org time
 * formatter (time/org-timezone.test.ts) so both are held to the same engine.
 * The first rentals fix's stand-in kept hour, minute and dayPeriod typed, so
 * its tests passed while the phone still printed the engine's words (re-walk
 * 2026-09-26).
 */
export const REAL_DTF = Intl.DateTimeFormat;

export const NNBSP = '\u202f';

function literalPieces(value: string): Intl.DateTimeFormatPart[] {
  return (value.match(/[A-Za-z0-9]+|[^A-Za-z0-9]/g) ?? []).map((v) => ({
    type: 'literal',
    value: v,
  }));
}

function hermesParts(parts: Intl.DateTimeFormatPart[]): Intl.DateTimeFormatPart[] {
  const spaced = parts.map((p, i) =>
    p.type === 'literal' && parts[i + 1]?.type === 'dayPeriod' ? { ...p, value: NNBSP } : p,
  );
  const hourAt = spaced.findIndex((p) => p.type === 'hour');
  const hasDate = spaced.some((p) => p.type === 'month' || p.type === 'day' || p.type === 'year');
  const split = (ps: Intl.DateTimeFormatPart[]) =>
    ps.flatMap((p) => (p.type === 'literal' ? literalPieces(p.value) : [p]));
  if (hourAt < 0 || !hasDate) return split(spaced);
  // The date fields, then " at " and the time, all of it untyped. The part
  // before the hour is the engine's own date-to-time separator, replaced.
  const time = spaced
    .slice(hourAt)
    .map((p) => p.value)
    .join('');
  return [...split(spaced.slice(0, hourAt - 1)), ...literalPieces(` at ${time}`)];
}

export class HermesLikeDateTimeFormat {
  private readonly real: Intl.DateTimeFormat;
  constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    this.real = new REAL_DTF(locales, options);
  }
  formatToParts(date?: Date | number): Intl.DateTimeFormatPart[] {
    return hermesParts(this.real.formatToParts(date));
  }
  format(date?: Date | number): string {
    // Not through this.formatToParts: an engine without formatToParts still
    // formats.
    return hermesParts(this.real.formatToParts(date))
      .map((p) => p.value)
      .join('');
  }
  resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
    return this.real.resolvedOptions();
  }
}

/** Swaps in the Hermes-like Intl (or another stand-in class) until restoreIntl(). */
export function useHermesLikeIntl(dtf: unknown = HermesLikeDateTimeFormat): void {
  Object.defineProperty(Intl, 'DateTimeFormat', { value: dtf, configurable: true, writable: true });
  const hermesFormat = function (
    this: Date,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new HermesLikeDateTimeFormat(locales as string | string[] | undefined, options).format(
      this,
    );
  };
  vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(hermesFormat);
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(hermesFormat);
}

/** Puts this runtime's own Intl back (call in afterEach). */
export function restoreIntl(): void {
  Object.defineProperty(Intl, 'DateTimeFormat', {
    value: REAL_DTF,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
}
