import { describe, expect, it } from 'vitest';

import {
  AI_CONFIDENCE_THRESHOLD,
  buildShelfScanPrompt,
  isHighConfidence,
  parseShelfScanResponse,
  type ShelfScanLineInput,
} from './shelf-scan';

const lineSet: ShelfScanLineInput[] = [
  {
    lineId: 'line-1',
    sku: '9780123456789',
    name: 'The Pragmatic Programmer',
    author: 'David Thomas',
    isbn: '9780123456789',
  },
  {
    lineId: 'line-2',
    sku: 'BK-002',
    name: "The Hitchhiker's Guide to the Galaxy",
    author: 'Douglas Adams',
  },
  {
    lineId: 'line-3',
    sku: 'BK-003',
    name: 'Untitled Memoir',
    // intentionally no author/isbn — exercise the optional-field path
  },
];

describe('buildShelfScanPrompt', () => {
  it('includes every line-set SKU in the prompt body', () => {
    const prompt = buildShelfScanPrompt(lineSet);
    for (const l of lineSet) {
      expect(prompt).toContain(l.sku);
    }
  });

  it('omits author + isbn when they are missing', () => {
    const prompt = buildShelfScanPrompt(lineSet);
    // Line 3 has no author — confirm we didn't leak a null/undefined.
    expect(prompt).not.toContain('"author":null');
    expect(prompt).not.toContain('"author":"undefined"');
    expect(prompt).not.toContain('"isbn":null');
  });

  it('does not leak the internal lineId into the model prompt', () => {
    const prompt = buildShelfScanPrompt(lineSet);
    for (const l of lineSet) {
      expect(prompt).not.toContain(l.lineId);
    }
  });

  it('instructs the model to ignore unknown books', () => {
    const prompt = buildShelfScanPrompt(lineSet);
    expect(prompt).toMatch(/ignore them entirely/i);
  });
});

describe('parseShelfScanResponse', () => {
  it('maps SKUs back to lineIds and returns clean results', () => {
    const raw = JSON.stringify({
      results: [
        { sku: 'BK-002', count: 3, confidence: 0.92, notes: 'three on the top shelf' },
        { sku: '9780123456789', count: 1, confidence: 0.78 },
      ],
    });
    const out = parseShelfScanResponse(raw, lineSet);
    expect(out).toEqual([
      {
        lineId: 'line-2',
        sku: 'BK-002',
        count: 3,
        confidence: 0.92,
        notes: 'three on the top shelf',
      },
      {
        lineId: 'line-1',
        sku: '9780123456789',
        count: 1,
        confidence: 0.78,
      },
    ]);
  });

  it('filters out hallucinated SKUs not in the line set', () => {
    const raw = JSON.stringify({
      results: [
        { sku: 'BK-002', count: 1, confidence: 0.9 },
        { sku: 'BK-NOT-REAL', count: 1, confidence: 0.95 },
      ],
    });
    const out = parseShelfScanResponse(raw, lineSet);
    expect(out).toHaveLength(1);
    expect(out[0]!.sku).toBe('BK-002');
  });

  it('clamps confidence to [0, 1]', () => {
    const raw = JSON.stringify({
      results: [
        { sku: 'BK-002', count: 1, confidence: 1.7 },
        { sku: 'BK-003', count: 1, confidence: -0.2 },
      ],
    });
    const out = parseShelfScanResponse(raw, lineSet);
    expect(out[0]!.confidence).toBe(1);
    expect(out[1]!.confidence).toBe(0);
  });

  it('floors non-integer counts and rejects negative counts', () => {
    const raw = JSON.stringify({
      results: [
        { sku: 'BK-002', count: 3.7, confidence: 0.9 },
        { sku: 'BK-003', count: -2, confidence: 0.9 },
      ],
    });
    const out = parseShelfScanResponse(raw, lineSet);
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(3);
  });

  it('returns empty array on malformed JSON', () => {
    expect(parseShelfScanResponse('not valid json {{', lineSet)).toEqual([]);
  });

  it('handles ```json``` fenced output (Gemini fallback path)', () => {
    const raw = '```json\n{"results":[{"sku":"BK-002","count":2,"confidence":0.9}]}\n```';
    const out = parseShelfScanResponse(raw, lineSet);
    expect(out).toHaveLength(1);
    expect(out[0]!.sku).toBe('BK-002');
  });

  it('returns empty array when the model says "nothing detected"', () => {
    const raw = JSON.stringify({ results: [] });
    expect(parseShelfScanResponse(raw, lineSet)).toEqual([]);
  });

  it('truncates excessively long notes to 500 chars (defense against prompt-injection-style payloads)', () => {
    const longNote = 'a'.repeat(2000);
    const raw = JSON.stringify({
      results: [{ sku: 'BK-002', count: 1, confidence: 0.9, notes: longNote }],
    });
    const out = parseShelfScanResponse(raw, lineSet);
    expect(out[0]!.notes!.length).toBe(500);
  });

  it('drops entries with non-string sku', () => {
    const raw = JSON.stringify({
      results: [
        { sku: 42, count: 1, confidence: 0.9 },
        { sku: 'BK-002', count: 1, confidence: 0.9 },
      ],
    });
    const out = parseShelfScanResponse(raw, lineSet);
    expect(out).toHaveLength(1);
  });
});

describe('isHighConfidence', () => {
  it('flips at AI_CONFIDENCE_THRESHOLD', () => {
    expect(isHighConfidence(AI_CONFIDENCE_THRESHOLD)).toBe(true);
    expect(isHighConfidence(AI_CONFIDENCE_THRESHOLD - 0.0001)).toBe(false);
    expect(isHighConfidence(1)).toBe(true);
    expect(isHighConfidence(0)).toBe(false);
  });
});
