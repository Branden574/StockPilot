/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NATIVE CRATE COLOUR PICKER — the fixed list, and the box it replaced
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The move sheet's crate colour was FREE TEXT while the web put-away dialogs
 * had already been narrowed to the shared CRATE_COLORS registry. Two inputs
 * for one concept, drifting apart.
 *
 * Two things are pinned here, because the change has two halves and only one
 * of them is loadable:
 *
 *   1. THE DECISION — the option list, what each option puts into form state,
 *      and which option a stored value highlights. Pure, so it is tested
 *      directly.
 *
 *   2. THE RENDERING — that move-stock-modal.tsx actually uses the list and no
 *      longer carries a free-text writer. The mobile vitest project is
 *      `environment: 'node'` with `include: ['src/**\/*.test.ts']`, so a .tsx
 *      component cannot be imported at all; it is asserted against its SOURCE,
 *      the same technique rack-shape.inventory-guard.test.ts already uses on
 *      this exact family of fields. A source guard is weaker than a render
 *      test and is not pretending otherwise — it exists so that reverting the
 *      sheet to a text box fails a test instead of passing silently.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CRATE_COLORS, normalizeCrateColorForWrite } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import {
  CRATE_COLOR_NONE,
  CRATE_COLOR_OPTIONS,
  selectedCrateColor,
} from './crate-color-options';
import { newLocationFields, newLocationReady } from './move-stock-form';

describe('CRATE_COLOR_OPTIONS', () => {
  it('is the SHARED registry, not a native re-listing of the colours', () => {
    // The point of the change. If someone ever pastes the ten colours in here,
    // this fails — a second copy of the list is the same divergence the fixed
    // picker was introduced to end.
    expect(CRATE_COLOR_OPTIONS.slice(1)).toEqual(
      CRATE_COLORS.map((c) => ({ value: c.slug, label: c.label, hex: c.hex })),
    );
  });

  it('leads with "No color", and it is a real empty value — not a sentinel', () => {
    expect(CRATE_COLOR_OPTIONS[0]).toEqual({ value: '', label: 'No color', hex: null });
    expect(CRATE_COLOR_NONE).toBe('');
  });

  it('gives every colour a NAME, never a swatch alone', () => {
    for (const opt of CRATE_COLOR_OPTIONS) {
      expect(opt.label.trim().length, JSON.stringify(opt)).toBeGreaterThan(0);
    }
  });

  it('offers only values that are ALREADY the canonical stored form', () => {
    // The whole reason the input was narrowed. `normalizeCrateColorForWrite`
    // canonicalises a colour the registry KNOWS and keeps an unknown one
    // verbatim — correctly, since discarding it would throw away its only
    // spelling. So an unknown colour can only be stopped at the input, and
    // this asserts the input can no longer produce one: every option is a
    // fixed point of the write-side normaliser.
    for (const opt of CRATE_COLOR_OPTIONS) {
      expect(normalizeCrateColorForWrite(opt.value), opt.label).toBe(opt.value || null);
    }
    // What the free-text box could still emit, for contrast.
    expect(normalizeCrateColorForWrite('navy')).toBe('navy');
    expect(CRATE_COLOR_OPTIONS.map((o) => o.value)).not.toContain('navy');
  });
});

describe('a numbered crate with NO colour stays expressible from the phone', () => {
  // Production shape: rack 39-B holds a crate whose number is 1 and which has
  // no colour at all. A fixed list is exactly the change that would quietly
  // make that unreachable, so it is pinned end to end — the option's value,
  // through the payload builder, to a submittable form.
  const noColour = {
    kind: 'crate' as const,
    rackNumber: '39',
    rackRow: 'B',
    crateColor: CRATE_COLOR_NONE,
    crateNumber: '1',
  };

  it('omits crateColor from the payload entirely', () => {
    expect(newLocationFields(noColour)).toEqual({
      crateNumber: '1',
      rackNumber: '39',
      rackRow: 'B',
    });
  });

  it('is still complete enough to submit', () => {
    expect(newLocationReady(noColour)).toBe(true);
  });

  it('sends a chosen colour as its registry slug', () => {
    expect(newLocationFields({ ...noColour, crateColor: 'blue' })).toEqual({
      crateNumber: '1',
      crateColor: 'blue',
      rackNumber: '39',
      rackRow: 'B',
    });
  });
});

describe('selectedCrateColor', () => {
  it('highlights "No color" for blank state', () => {
    expect(selectedCrateColor('')).toBe(CRATE_COLOR_NONE);
    expect(selectedCrateColor('   ')).toBe(CRATE_COLOR_NONE);
    expect(selectedCrateColor(null)).toBe(CRATE_COLOR_NONE);
    expect(selectedCrateColor(undefined)).toBe(CRATE_COLOR_NONE);
  });

  it('highlights a known colour, whatever its case', () => {
    expect(selectedCrateColor('blue')).toBe('blue');
    // Legacy rows spell it this way; the row should light up, not go blank.
    expect(selectedCrateColor('Blue')).toBe('blue');
    expect(selectedCrateColor(' BLUE ')).toBe('blue');
  });

  it('highlights NOTHING for a colour the registry does not know', () => {
    // Deliberately not "No color". A value like this is unreachable while the
    // picker is the only writer of the state, but answering it as "No color"
    // would tell the operator their colour had been dropped when it is still
    // there — and invite them to erase it by confirming a screen that lied.
    expect(selectedCrateColor('navy')).toBeNull();
  });
});

describe('the move sheet renders the list (source guard)', () => {
  // fileURLToPath on import.meta.url, then join — NOT `new URL(rel, base)`.
  // This app compiles against React Native's lib.dom URL, which tsc refuses to
  // pass to node:url's fileURLToPath (their URLSearchParams iterators differ).
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../components/move-stock-modal.tsx'),
    'utf8',
  );

  it('drives the crate colour field off the shared options', () => {
    expect(src).toContain('CRATE_COLOR_OPTIONS');
    expect(src).toContain("from '@/lib/crate-color-options'");
  });

  it('has no free-text writer for the crate colour', () => {
    // The WRITER is the assertion, not the placeholder. A first draft of this
    // test also asserted the old "e.g. Blue" placeholder string was absent —
    // and it failed on the comment in the sheet that names the box it
    // replaced. Policing prose is how a guard teaches people to delete the
    // explanation to get green, so only the code shape is matched.
    expect(
      /onChangeText=\{setCrateColor\}/.test(src),
      'move-stock-modal.tsx types a crate colour straight into state again — free text is what let the phone mint a colour ("navy") that no swatch, filter or label sheet can render.',
    ).toBe(false);
  });
});
