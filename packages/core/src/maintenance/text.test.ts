import { describe, expect, it } from 'vitest';

import { sanitizeDescriptionBlock, sanitizeSubjectLine } from './text';

// Built via String.fromCharCode rather than typed escapes so the literal
// control bytes (BEL 0x07, DEL 0x7F) are unambiguous in this source file.
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(0x7f);

describe('sanitizeSubjectLine (collapsing — subjects ONLY)', () => {
  it('strips C0 + DEL and collapses all whitespace including newlines', () => {
    expect(sanitizeSubjectLine('  AC broken\r\nin Room\t204  ')).toBe('AC broken in Room 204');
  });

  it('collapses a run of internal control characters (BEL, DEL) to a single space', () => {
    expect(sanitizeSubjectLine(`a${BEL}${DEL}b`)).toBe('a b');
    expect(sanitizeSubjectLine('   ')).toBe('');
    expect(sanitizeSubjectLine('Normal subject')).toBe('Normal subject');
  });

  it('cannot be used to forge a header-looking second line', () => {
    const forged = 'Subject: real\r\nBcc: attacker@evil.test';
    expect(sanitizeSubjectLine(forged)).not.toMatch(/[\r\n]/);
    expect(sanitizeSubjectLine(forged)).toBe('Subject: real Bcc: attacker@evil.test');
  });
});

describe('sanitizeDescriptionBlock (newline-PRESERVING — audit Q14)', () => {
  it('preserves intentional line breaks', () => {
    expect(sanitizeDescriptionBlock('Line one\nLine two')).toBe('Line one\nLine two');
  });

  it('normalizes CRLF and strips other C0 controls + DEL (brief literal)', () => {
    expect(sanitizeDescriptionBlock(`a\r\nb${BEL}c${DEL}d`)).toBe('a\nbcd');
  });

  it('caps consecutive newlines at two', () => {
    expect(sanitizeDescriptionBlock('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims outer whitespace only', () => {
    expect(sanitizeDescriptionBlock('\n\n  hello\nworld  \n\n')).toBe('hello\nworld');
  });

  it('normalizes a bare CR (old Mac line ending) to a newline too', () => {
    expect(sanitizeDescriptionBlock('a\rb')).toBe('a\nb');
  });

  it('does not collapse a single blank line (exactly two consecutive newlines)', () => {
    expect(sanitizeDescriptionBlock('Paragraph one\n\nParagraph two')).toBe(
      'Paragraph one\n\nParagraph two',
    );
  });

  it('does not collapse ordinary interior spaces, unlike the subject sanitizer', () => {
    expect(sanitizeDescriptionBlock('a   b')).toBe('a   b');
  });

  it('replaces a tab with a single space rather than deleting it (fix wave 1: deleting glued adjacent words together)', () => {
    expect(sanitizeDescriptionBlock('a\tb')).toBe('a b');
    expect(sanitizeDescriptionBlock('plus\ttab')).toBe('plus tab');
  });
});

/**
 * Fix wave 1 (owner §7 gap): the shared schema (packages/core/src/schemas/
 * maintenance.ts) now sanitizes subject/description at INTAKE, but email.ts
 * (below) still calls these same functions again at email-BUILD time —
 * `buildMaintenanceEmailDraft` has no way of knowing whether its input came
 * fresh off the (now-sanitizing) schema or from some other caller, so it
 * keeps sanitizing defensively. These two tests confirm that double call is
 * a no-op: once a value is sanitized, sanitizing it again produces the
 * IDENTICAL string, so a DB row already sanitized at intake goes through
 * email.ts unchanged.
 */
describe('idempotence (Fix wave 1) — sanitizing an already-sanitized value is a no-op', () => {
  it('sanitizeSubjectLine(sanitizeSubjectLine(x)) === sanitizeSubjectLine(x)', () => {
    const inputs = [
      '  AC broken\r\nin Room\t204  ',
      `a${BEL}${DEL}b`,
      'Normal subject',
      'Subject: real\r\nBcc: attacker@evil.test',
      '   ',
    ];
    for (const input of inputs) {
      const once = sanitizeSubjectLine(input);
      const twice = sanitizeSubjectLine(once);
      expect(twice).toBe(once);
    }
  });

  it('sanitizeDescriptionBlock(sanitizeDescriptionBlock(x)) === sanitizeDescriptionBlock(x)', () => {
    const inputs = [
      'Line one\nLine two',
      `a\r\nb${BEL}c${DEL}d`,
      'a\n\n\n\n\nb',
      '\n\n  hello\nworld  \n\n',
      'a\rb',
      'Paragraph one\n\nParagraph two',
      'a   b',
      'a\tb',
      'plus\ttab',
    ];
    for (const input of inputs) {
      const once = sanitizeDescriptionBlock(input);
      const twice = sanitizeDescriptionBlock(once);
      expect(twice).toBe(once);
    }
  });
});
