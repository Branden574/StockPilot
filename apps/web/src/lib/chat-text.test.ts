import { describe, expect, it } from 'vitest';

import { CHAT_FIELD_MAX, chatBlock, chatCode, chatField } from './chat-text';

const BIDI_OVERRIDE = '\u202E';
const ZERO_WIDTH_SPACE = '\u200B';
const ZERO_WIDTH_JOINER = '\u200D';
const GRAVE_LETTER = '\u02CB';

describe('chatField: one card field, on one line, capped, then escaped', () => {
  it('Slack: ampersands and angle brackets become entities', () => {
    expect(chatField('Bolts & Nuts <10mm>', 'slack')).toBe('Bolts &amp; Nuts &lt;10mm&gt;');
    expect(chatField('Size <10> & <https://example.com|Open>', 'slack')).toBe(
      'Size &lt;10&gt; &amp; &lt;https://example.com|Open&gt;',
    );
  });

  it('Slack: an entity that was typed is escaped once more, never read as one', () => {
    expect(chatField('A &amp; B', 'slack')).toBe('A &amp;amp; B');
  });

  it('Teams: the three entities, then a backslash before a backslash and square brackets only', () => {
    expect(chatField('Widget (blue) [B-1] sk_live_abc1 #10 *bold* ~x~ `y`', 'teams')).toBe(
      'Widget (blue) \\[B-1\\] sk_live_abc1 #10 *bold* ~x~ `y`',
    );
    expect(
      chatField('[Open](https://example.com) <a href="https://example.com">x</a>', 'teams'),
    ).toBe('\\[Open\\](https://example.com) &lt;a href="https://example.com"&gt;x&lt;/a&gt;');
  });

  it('Teams: a typed backslash is escaped in the same pass, so it cannot cancel an added one', () => {
    expect(chatField('\\[Open](https://example.com)', 'teams')).toBe(
      '\\\\\\[Open\\](https://example.com)',
    );
  });

  it('plain: nothing is escaped', () => {
    expect(chatField('Bolts & Nuts <10mm> [B-1]', 'plain')).toBe('Bolts & Nuts <10mm> [B-1]');
  });

  it('formatting characters are left as typed in both channels', () => {
    for (const channel of ['slack', 'teams'] as const) {
      expect(chatField('*a* _b_ ~c~ `d` #e', channel)).toBe('*a* _b_ ~c~ `d` #e');
    }
  });

  it('puts the text on one line: line breaks, tabs and control characters become one space', () => {
    expect(chatField('Late\nsecond line', 'slack')).toBe('Late second line');
    expect(chatField(' a\r\n\tb \u0007 c\u2028d\u0085e ', 'slack')).toBe('a b c d e');
  });

  it('removes zero-width and direction controls, and keeps the joiner emoji need', () => {
    expect(chatField(`abc${BIDI_OVERRIDE}def`, 'slack')).toBe('abcdef');
    expect(chatField(`a${ZERO_WIDTH_SPACE}b\u2060c\uFEFFd\u2066e\u2069f`, 'teams')).toBe('abcdef');
    expect(chatField(`a${ZERO_WIDTH_JOINER}b`, 'slack')).toBe(`a${ZERO_WIDTH_JOINER}b`);
  });

  it('gives an empty string when nothing is left to show', () => {
    expect(chatField(`${BIDI_OVERRIDE}${ZERO_WIDTH_SPACE} \n`, 'slack')).toBe('');
    expect(chatField('', 'teams')).toBe('');
  });

  it('caps before it escapes: 300 characters and an ellipsis, never a cut entity', () => {
    expect(CHAT_FIELD_MAX).toBe(300);
    const out = chatField('<'.repeat(1000), 'slack');
    expect(out).toBe(`${'&lt;'.repeat(300)}…`);
    expect(chatField('x'.repeat(300), 'slack')).toBe('x'.repeat(300));
    expect(chatField('x'.repeat(301), 'slack')).toBe(`${'x'.repeat(300)}…`);
    expect(chatField('abcdef', 'plain', 3)).toBe('abc…');
  });

  it('counts code points, so a character outside the basic plane is never split', () => {
    const face = '\u{1F600}';
    const out = chatField(`${'x'.repeat(299)}${face}${face}`, 'slack');
    expect(out).toBe(`${'x'.repeat(299)}${face}…`);
    expect(Array.from(out)).toHaveLength(301);
  });
});

describe('chatBlock: a message of several lines, kept whole', () => {
  it('keeps line breaks, tabs and leading spaces, and turns other line endings into \\n', () => {
    expect(chatBlock('one\r\n  two\rthree\n\tfour', 'slack')).toBe('one\n  two\nthree\n\tfour');
  });

  it('does not collapse or cut a long text', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `  line ${i}: ${'x'.repeat(115)}`);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(5000);
    expect(chatBlock(text, 'slack')).toBe(text);
    expect(chatBlock(text, 'teams')).toBe(text);
  });

  it('replaces backticks, so the message cannot pair with the code that follows it', () => {
    expect(chatBlock('a ``` b ` c', 'slack')).toBe(
      `a ${GRAVE_LETTER.repeat(3)} b ${GRAVE_LETTER} c`,
    );
    expect(chatBlock('a ` b', 'teams')).toBe(`a ${GRAVE_LETTER} b`);
  });

  it('escapes for the channel and removes what cannot be seen', () => {
    expect(chatBlock(`a <b> & c${BIDI_OVERRIDE}\u0000d`, 'slack')).toBe('a &lt;b&gt; &amp; c d');
    expect(chatBlock('see [x](https://example.com)', 'teams')).toBe(
      'see \\[x\\](https://example.com)',
    );
    expect(chatBlock('a <b> & [c]', 'plain')).toBe('a <b> & [c]');
  });
});

describe('chatCode: text inside a code span or fence', () => {
  it('turns every backtick into a look-alike letter, so the text cannot end the code', () => {
    expect(chatCode('a ``` b ` c', 'slack')).toBe(
      `a ${GRAVE_LETTER.repeat(3)} b ${GRAVE_LETTER} c`,
    );
    expect(chatCode('a ``` b', 'teams')).not.toContain('`');
  });

  it('Slack gets the entities; Teams gets neither an entity nor a backslash', () => {
    expect(chatCode('at <anonymous> & [redacted]', 'slack')).toBe(
      'at &lt;anonymous&gt; &amp; [redacted]',
    );
    expect(chatCode('at <anonymous> & node_modules/.pnpm/x_y/[redacted]\\z', 'teams')).toBe(
      'at <anonymous> & node_modules/.pnpm/x_y/[redacted]\\z',
    );
  });

  it('keeps a stack’s lines', () => {
    expect(chatCode('Error: x\r\n    at a (b.ts:1:1)\n    at c', 'slack')).toBe(
      'Error: x\n    at a (b.ts:1:1)\n    at c',
    );
  });
});
