/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CRATE COLOUR CHOICES the native move sheet offers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The sheet's colour box used to be FREE TEXT (placeholder "e.g. Blue") while
 * the two web put-away dialogs had already been narrowed to a Select over the
 * shared CRATE_COLORS registry. Two inputs for one concept, drifting apart, is
 * the shape that produced this area's label collisions — and the web half had
 * already been fixed, so the phone was the remaining wide end.
 *
 * ═══ WHAT THE FREE-TEXT BOX COULD STILL DO ═══
 *
 * Not mixed case. That was closed earlier this week from both directions: the
 * comparison path is case-insensitive (`getCrateColor`) because mixed-case
 * colours already exist in production, and every writer canonicalises a KNOWN
 * colour through `normalizeCrateColorForWrite`, so a native "Blue" already
 * lands in the column as "blue".
 *
 * What free text could still do is mint a colour the registry has never heard
 * of. "navy" is kept VERBATIM by `normalizeCrateColorForWrite` — correctly, as
 * discarding it would throw away the only spelling anyone has of it — and then
 * renders with no swatch, filters as a colour of its own, and reads as unknown
 * to every label sheet. Narrowing the INPUT is what closes that, and it can
 * only be closed at the input: by the time a value reaches the writer, keeping
 * it is the right call.
 *
 * ═══ WHAT THIS FILE IS NOT ═══
 *
 * It is not a copy of the colour list. The colours come from @stockpilot/core;
 * a second listing native-side would be the same divergence with extra steps,
 * which is the whole reason this file exists.
 *
 * It is also not a migration. Nothing here rewrites a colour already stored.
 * The only thing that changes is what NEW input can be.
 *
 * It lives in src/lib rather than beside the sheet because the mobile vitest
 * project is `environment: 'node'` with `include: ['src/**\/*.test.ts']` — a
 * .tsx component cannot be loaded, so the DECISION lives here where it can be
 * tested and the sheet is left with only the rendering.
 */
import { CRATE_COLORS, getCrateColor } from '@stockpilot/core';

/**
 * The form-state value for "no colour chosen": the empty string — exactly what
 * the free-text box held when it was left blank, and what `newLocationFields`
 * already drops from the payload.
 *
 * Deliberately NOT web's `'__none__'`. That sentinel exists only because Radix
 * forbids an empty Select value; a native pressable has no such rule, so the
 * option can carry the real value and no call site has to un-sentinel it
 * before submitting.
 */
export const CRATE_COLOR_NONE = '';

export interface CrateColorOption {
  /** Written straight into form state. '' for "No color". */
  value: string;
  /**
   * ALWAYS rendered. A COLOR IS NEVER THE ONLY SIGNAL — the same rule the web
   * crate controls carry: a swatch on its own is unreadable to a colour-blind
   * picker and invisible to a screen reader, so the name is the information
   * and the swatch is an accelerator for people who can use it.
   */
  label: string;
  /** Decorative swatch fill; null for "No color", which gets no swatch. */
  hex: string | null;
}

/**
 * "No color" FIRST, then the registry in its own order.
 *
 * "No color" is not a courtesy. Production holds crates identified by their
 * NUMBER alone (rack 39-B, crate number 1), and staff routinely number a crate
 * before they know which coloured bin it ends up in. A picker that forced a
 * colour would make a real, shipped shape unexpressible from the phone — the
 * failure mode a fixed list invites if nobody names the empty case.
 */
export const CRATE_COLOR_OPTIONS: readonly CrateColorOption[] = [
  { value: CRATE_COLOR_NONE, label: 'No color', hex: null },
  ...CRATE_COLORS.map((c) => ({ value: c.slug, label: c.label, hex: c.hex })),
];

/**
 * Which option a given form value highlights.
 *
 * Case-insensitive through the shared lookup, so a legacy "Blue" highlights
 * Blue rather than nothing.
 *
 * Returns null — nothing highlighted — for a non-empty value the registry does
 * not know. That is unreachable while this picker is the only writer of the
 * state, and it is still answered honestly: showing "navy" as "No color" would
 * tell the operator their colour had been dropped when it is still there, and
 * would invite them to erase it by confirming a screen that had already lied.
 */
export function selectedCrateColor(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (raw.length === 0) return CRATE_COLOR_NONE;
  return getCrateColor(raw)?.slug ?? null;
}
