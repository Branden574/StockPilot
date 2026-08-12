import { describe, expect, it } from 'vitest';

import {
  normalizePoImportDisplayName,
  optionalPoImportDisplayNameSchema,
  poImportDisplayNameError,
  poImportDisplayNameSchema,
  PO_IMPORT_DISPLAY_NAME_MAX,
  stripUnsafeDisplayNameChars,
} from './po-imports';

/**
 * po_imports.display_name (mig 0333) — the ONE authoritative name rule, shared
 * by the upload action, the scan route, the service and the rename flow. Every
 * bound is pinned to a literal, and to the same literal the column CHECK
 * enforces (`length(display_name) between 1 and 160`).
 *
 * Unsafe characters are built with `ch()` rather than pasted in raw: a literal
 * U+202E in a source file visually reverses the rest of the line in most
 * editors and diff viewers, which is precisely the trick this rule refuses. A
 * test that demonstrates the attack should not also fall for it.
 */

/** One character, by codepoint. */
const ch = (codePoint: number) => String.fromCodePoint(codePoint);

const TOO_LONG_MESSAGE = 'Name is too long (160 characters max).';
const UNSAFE_MESSAGE = 'Remove control and text-direction characters from the name.';

/** The exact set profile.ts's sanitizeName strips, enumerated. */
const CONTROL_CODEPOINTS = [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f];
const BIDI_CODEPOINTS = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];

describe('poImportDisplayNameSchema', () => {
  it('pins the ceiling at 160 — the same number the column CHECK uses', () => {
    expect(PO_IMPORT_DISPLAY_NAME_MAX).toBe(160);
  });

  it('accepts an ordinary name and trims it', () => {
    expect(poImportDisplayNameSchema.parse('  August DC4 Book Order  ')).toBe(
      'August DC4 Book Order',
    );
  });

  it("PRESERVES the punctuation real import names use: - _ & ' ( ) # . , /", () => {
    const name = "Follett & Sons - Andrew's re-order (DC4) #12_final v1.2, a/b";
    expect(poImportDisplayNameSchema.parse(name)).toBe(name);
  });

  it('rejects a name that is empty after trimming', () => {
    const r = poImportDisplayNameSchema.safeParse('   ');
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]!.message).toBe(
      'Enter a name for this import.',
    );
  });

  it('accepts exactly 160 characters and rejects 161', () => {
    expect(poImportDisplayNameSchema.parse('y'.repeat(160))).toHaveLength(160);
    const r = poImportDisplayNameSchema.safeParse('y'.repeat(161));
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]!.message).toBe(TOO_LONG_MESSAGE);
  });

  it('measures the length AFTER trimming', () => {
    // 160 real characters padded with spaces is a legal 160-character name...
    expect(poImportDisplayNameSchema.safeParse(` ${'y'.repeat(160)} `).success).toBe(true);
    // ...while 161 real characters is not, however it is padded.
    expect(poImportDisplayNameSchema.safeParse(`  ${'y'.repeat(161)}  `).success).toBe(false);
  });

  it('rejects ASCII control characters (NUL, TAB, LF, CR, ESC, US, DEL)', () => {
    for (const cp of CONTROL_CODEPOINTS) {
      const r = poImportDisplayNameSchema.safeParse(`August${ch(cp)}DC4`);
      expect(r.success).toBe(false);
      expect(r.success === false && r.error.issues[0]!.message).toBe(UNSAFE_MESSAGE);
    }
  });

  it('rejects every Unicode bidi override and isolate (the spoofing half)', () => {
    // U+202A..U+202E and U+2066..U+2069 — a name carrying one of these renders
    // right-to-left and can make one import LOOK like another in a table row.
    for (const cp of BIDI_CODEPOINTS) {
      const r = poImportDisplayNameSchema.safeParse(`August${ch(cp)}DC4`);
      expect(r.success).toBe(false);
      expect(r.success === false && r.error.issues[0]!.message).toBe(UNSAFE_MESSAGE);
    }
  });

  it('is stateless across calls — the character class carries no /g lastIndex', () => {
    // A global regex would alternate false/true/false across these three.
    const spoof = `August${ch(0x202e)}DC4`;
    expect(poImportDisplayNameSchema.safeParse(spoof).success).toBe(false);
    expect(poImportDisplayNameSchema.safeParse(spoof).success).toBe(false);
    expect(poImportDisplayNameSchema.safeParse(spoof).success).toBe(false);
  });
});

describe('optionalPoImportDisplayNameSchema — absent/null/blank all mean "no name"', () => {
  it('maps undefined, null and blank strings to null (old-client compatibility)', () => {
    for (const raw of [undefined, null, '', '   ', `${ch(0x09)}${ch(0x0a)} `]) {
      const r = optionalPoImportDisplayNameSchema.safeParse(raw);
      expect(r.success).toBe(true);
      expect(r.success === true && r.data).toBeNull();
    }
  });

  it('applies the full rules to a name that IS supplied', () => {
    expect(optionalPoImportDisplayNameSchema.parse(' August DC4 ')).toBe('August DC4');
    expect(optionalPoImportDisplayNameSchema.safeParse('x'.repeat(161)).success).toBe(false);
    expect(
      optionalPoImportDisplayNameSchema.safeParse(`August${ch(0x202e)}DC4`).success,
    ).toBe(false);
  });
});

describe('stripUnsafeDisplayNameChars — the SUGGESTION-side counterpart', () => {
  it('removes every control codepoint the rules refuse', () => {
    for (const cp of CONTROL_CODEPOINTS) {
      expect(stripUnsafeDisplayNameChars(`August${ch(cp)}DC4`)).toBe('AugustDC4');
    }
  });

  it('removes every bidi override and isolate the rules refuse', () => {
    for (const cp of BIDI_CODEPOINTS) {
      expect(stripUnsafeDisplayNameChars(`August${ch(cp)}DC4`)).toBe('AugustDC4');
    }
  });

  it('removes ALL occurrences, not just the first', () => {
    expect(stripUnsafeDisplayNameChars(`a${ch(0x202e)}b${ch(0x202e)}c${ch(0x00)}d`)).toBe(
      'abcd',
    );
  });

  it('is stateless across calls — a /g regex reused would skip every other hit', () => {
    const spoof = `August${ch(0x202e)}DC4`;
    expect(stripUnsafeDisplayNameChars(spoof)).toBe('AugustDC4');
    expect(stripUnsafeDisplayNameChars(spoof)).toBe('AugustDC4');
    expect(stripUnsafeDisplayNameChars(spoof)).toBe('AugustDC4');
  });

  it('leaves ordinary text — punctuation, accents, spaces — completely alone', () => {
    const name = "Follett & Sons - Andrew's re-order (DC4) #12_final v1.2, a/b";
    expect(stripUnsafeDisplayNameChars(name)).toBe(name);
    expect(stripUnsafeDisplayNameChars('Août — DC4 ✓')).toBe('Août — DC4 ✓');
  });

  it('produces something the rules ACCEPT (that is the entire contract)', () => {
    expect(stripUnsafeDisplayNameChars(`August${ch(0x202e)}DC4`)).toBe('AugustDC4');
    expect(poImportDisplayNameError('AugustDC4')).toBeNull();
  });

  it('is NOT wired into the typed-name path — typed input is still refused', () => {
    // The strip is for machine-derived suggestions only. If it ever leaked into
    // the schema, this spoof would start passing.
    expect(poImportDisplayNameSchema.safeParse(`August${ch(0x202e)}DC4`).success).toBe(false);
  });
});

describe('normalizePoImportDisplayName', () => {
  it('trims, and returns null when nothing is left', () => {
    expect(normalizePoImportDisplayName('  August DC4  ')).toBe('August DC4');
    expect(normalizePoImportDisplayName('   ')).toBeNull();
    expect(normalizePoImportDisplayName(null)).toBeNull();
    expect(normalizePoImportDisplayName(undefined)).toBeNull();
  });

  it('does NOT launder an EMBEDDED control character into a space', () => {
    // Collapsing whitespace here would turn this into 'a b' and let it pass,
    // defeating the rejection rule outright. It must survive to be refused.
    const embedded = `a${ch(0x0a)}b`;
    expect(normalizePoImportDisplayName(embedded)).toBe(embedded);
    expect(poImportDisplayNameError(embedded)).toBe(UNSAFE_MESSAGE);
  });
});
