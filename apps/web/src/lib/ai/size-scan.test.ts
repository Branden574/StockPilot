import { describe, expect, it } from 'vitest';

import {
  parseSizeScanResponse,
  SIZE_SCAN_MIN_CONFIDENCE,
  SIZE_SCAN_PROMPT,
  SIZE_SCAN_RESPONSE_SCHEMA,
  SIZE_SCAN_SIZES,
  MAX_SIZE_SCAN_STICKERS,
} from './size-scan';

// ---------------------------------------------------------------------------
// These tests cover the PARSER and the invariants of the prompt/schema. They
// cannot tell you whether the scanner reads stickers correctly — only a run
// against real photographs can, and that lives in scripts/size-scan-eval/.
//
// The split is deliberate. Accuracy is a property of the model plus the prompt
// and has to be MEASURED against the corpus; everything below is a property of
// our own code and can be PROVEN here in milliseconds. Conflating the two gives
// you a test suite that is green while the scanner is blind.
// ---------------------------------------------------------------------------

const dot = (size: string, confidence = 1, rawText = size) => ({
  carrier: 'round_dot',
  rawText,
  xCount: (size.match(/X/g) ?? []).length,
  size,
  confidence,
});

const body = (stickers: unknown[], noStickerVisible = false) =>
  JSON.stringify({ stickers, noStickerVisible, notes: '' });

describe('parseSizeScanResponse — what may become a count', () => {
  it('counts round dots and tallies repeats', () => {
    const r = parseSizeScanResponse(body([dot('M'), dot('M'), dot('XXL')]));
    expect(r.counts).toEqual([
      { size: 'M', count: 2 },
      { size: 'XXL', count: 1 },
    ]);
    expect(r.stickers).toHaveLength(3);
  });

  it('DISCARDS a reading the model put on a tag, however confident', () => {
    // The whole reason `carrier` exists. A BELLA+CANVAS neck tag prints a size
    // too, and counting it inflates the tally with a garment that was never
    // stickered. Confidence is not the guard here — the carrier is.
    const r = parseSizeScanResponse(
      body([{ ...dot('M'), carrier: 'printed_tag_or_label' }, dot('L')]),
    );
    expect(r.counts).toEqual([{ size: 'L', count: 1 }]);
    expect(r.discarded).toContainEqual({ rawText: 'M', reason: 'on_a_label' });
  });

  it('DISCARDS a row with no carrier at all rather than assuming it is a dot', () => {
    // An absent carrier means the question was never answered. Defaulting it to
    // "dot" would restore precisely the error the field was added to remove, and
    // would do so silently — the worst of both.
    const r = parseSizeScanResponse(body([{ rawText: 'M', size: 'M', confidence: 1 }]));
    expect(r.counts).toEqual([]);
    expect(r.discarded[0]?.reason).toBe('on_a_label');
  });

  it('drops readings below the confidence floor, and keeps ones exactly on it', () => {
    const r = parseSizeScanResponse(
      body([
        dot('S', SIZE_SCAN_MIN_CONFIDENCE),
        dot('L', SIZE_SCAN_MIN_CONFIDENCE - 0.01),
      ]),
    );
    expect(r.counts).toEqual([{ size: 'S', count: 1 }]);
    expect(r.discarded).toContainEqual({ rawText: 'L', reason: 'low_confidence' });
  });

  it('normalises the numeric spellings onto the nine sizes', () => {
    const r = parseSizeScanResponse(body([dot('2XL'), dot('3X'), dot('4xl')]));
    expect(r.counts).toEqual([
      { size: 'XXL', count: 1 },
      { size: 'XXXL', count: 1 },
      { size: 'XXXXL', count: 1 },
    ]);
  });

  it('refuses a size that is not on the list', () => {
    // "7X" is what an upside-down XL transcribes as. The PROMPT teaches the
    // rotation; the PARSER must not guess at one — inventing XXXXXXXL here
    // would turn a misread into a confident count.
    const r = parseSizeScanResponse(body([dot('7X'), dot('XXXXXXL'), dot('')]));
    expect(r.counts).toEqual([]);
    expect(r.discarded.every((d) => d.reason === 'unreadable')).toBe(true);
  });

  it('reports counts in size order, not in the order the model happened to look', () => {
    // The review sheet reads XS..XXXXXL. Order that follows the model's gaze
    // makes the same photo render differently on two scans of one stack.
    const r = parseSizeScanResponse(body([dot('XXL'), dot('XS'), dot('L')]));
    expect(r.counts.map((c) => c.size)).toEqual(['XS', 'L', 'XXL']);
  });
});

describe('parseSizeScanResponse — hostile and malformed input', () => {
  it('never throws on garbage, and proposes nothing', () => {
    for (const raw of ['', 'not json', '[]', 'null', '{"stickers":"lots"}', '{}']) {
      const r = parseSizeScanResponse(raw);
      expect(r.counts, raw).toEqual([]);
      expect(r.stickers, raw).toEqual([]);
    }
  });

  it('reads JSON that arrived wrapped in a markdown fence', () => {
    // Dead weight on Claude, which returns the object through a forced tool
    // call. Load-bearing on Gemini, which fences often enough that the shelf-scan
    // parser carries the same two lines.
    const r = parseSizeScanResponse('```json\n' + body([dot('M')]) + '\n```');
    expect(r.counts).toEqual([{ size: 'M', count: 1 }]);
  });

  it('caps how many stickers one photo may produce', () => {
    const r = parseSizeScanResponse(body(Array.from({ length: 500 }, () => dot('M'))));
    expect(r.stickers.length).toBe(MAX_SIZE_SCAN_STICKERS);
  });

  it('clamps a confidence outside 0..1 instead of trusting it', () => {
    const r = parseSizeScanResponse(body([dot('M', 42), dot('L', -5)]));
    expect(r.stickers.find((s) => s.size === 'M')?.confidence).toBe(1);
    // -5 clamps to 0, which is below the floor, so L is dropped rather than
    // counted with a nonsense confidence.
    expect(r.counts).toEqual([{ size: 'M', count: 1 }]);
  });

  it('recovers a double-encoded stickers array instead of dropping it', () => {
    // OBSERVED IN PRODUCTION MODELS, not invented: sonnet-5 returned this shape
    // once in 260 calls, through a forced tool schema. Dropping it is safe but
    // loses a good reading, and "the scan found nothing" is the one answer an
    // operator cannot argue with.
    const inner = JSON.stringify([dot('M'), dot('L')]);
    const r = parseSizeScanResponse(
      JSON.stringify({ stickers: inner, noStickerVisible: false, notes: '' }),
    );
    expect(r.counts).toEqual([
      { size: 'M', count: 1 },
      { size: 'L', count: 1 },
    ]);
  });

  it('recovers a double-encoded LONE sticker object', () => {
    // The exact payload observed: one object, not an array, inside the string.
    const inner = JSON.stringify(dot('XS', 1, 'SX'));
    const r = parseSizeScanResponse(
      JSON.stringify({ stickers: inner, noStickerVisible: false, notes: '' }),
    );
    expect(r.counts).toEqual([{ size: 'XS', count: 1 }]);
  });

  it('still proposes nothing when the encoded string is itself garbage', () => {
    const r = parseSizeScanResponse(
      JSON.stringify({ stickers: 'not json at all', noStickerVisible: false, notes: '' }),
    );
    expect(r.counts).toEqual([]);
  });

  it('survives rows that are not objects', () => {
    const r = parseSizeScanResponse(body([null, 'M', 7, dot('S')]));
    expect(r.counts).toEqual([{ size: 'S', count: 1 }]);
  });
});

describe('the prompt and schema hold the properties the accuracy depends on', () => {
  it('declares carrier and rawText BEFORE size, in both order-bearing places', () => {
    // THE CENTRAL INVARIANT OF THIS MODULE. Emitting `size` first lets the model
    // decide before it has committed to what the marking is on or what it says —
    // which is measurably worse (no-sticker recall fell from 100% to 55% in the
    // run where the carrier field was absent). Both the `required` list and
    // `propertyOrdering` are pinned because Claude follows the former and Gemini
    // only follows the latter.
    const item = SIZE_SCAN_RESPONSE_SCHEMA.properties.stickers.items;
    for (const order of [item.required, item.propertyOrdering]) {
      const list = order as readonly string[];
      expect(list.indexOf('carrier')).toBeLessThan(list.indexOf('size'));
      expect(list.indexOf('rawText')).toBeLessThan(list.indexOf('size'));
      expect(list.indexOf('xCount')).toBeLessThan(list.indexOf('size'));
    }
  });

  it('constrains size to exactly the nine database sizes', () => {
    expect(SIZE_SCAN_RESPONSE_SCHEMA.properties.stickers.items.properties.size.enum).toEqual([
      ...SIZE_SCAN_SIZES,
    ]);
  });

  it('teaches the rotation alphabet the corpus actually produced', () => {
    // Each of these was an observed misreading before it was taught, verified by
    // eye against the photograph. Losing one loses the accuracy it bought, and a
    // prompt reword should fail here rather than in the field.
    for (const rule of [/upside down/i, /reverse order/i, /7XX/, /\bSX\b/, /checkmark/i, /zigzag/i]) {
      expect(SIZE_SCAN_PROMPT).toMatch(rule);
    }
  });

  it('tells the model tag text stays tag text even when rotated', () => {
    // The two rules fight: "turn it and read it" is strong enough to promote a
    // neck tag's upside-down M into a sticker unless the exemption is explicit.
    // That exact failure happened at confidence 1.0 before this line existed.
    expect(SIZE_SCAN_PROMPT).toMatch(/ROTATION RULES APPLY ONLY TO round_dot/);
  });

  it('does not contradict its own rotation table', () => {
    // An earlier draft carried BOTH "7X means XL" and "there is no such size as
    // 7X — omit it". The model cannot obey both, and which one wins is not
    // something a reader of the prompt can predict.
    const saysSevenXIsXL = /7X[,\s].*-->\s*XL|7X, TX, X7\s*-->\s*XL/.test(SIZE_SCAN_PROMPT);
    expect(saysSevenXIsXL).toBe(true);
    expect(SIZE_SCAN_PROMPT).not.toMatch(/no such size as 7X/i);
  });

  it('names the tag-vs-dot test, which is the other half of the accuracy', () => {
    expect(SIZE_SCAN_PROMPT).toMatch(/BELLA\+CANVAS/);
    // \s+ not a literal space: the prompt is a wrapped template literal, so a
    // phrase can straddle a newline. Pinning the exact spacing would fail on
    // reflow — brittleness about formatting, not about the guarantee.
    expect(SIZE_SCAN_PROMPT).toMatch(/Legibility\s+is\s+not\s+the\s+test/i);
  });
});
