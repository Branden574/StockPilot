import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sports variant extraction (Task 13).
 *
 * These drive the REAL `extractPoFromMedia` with a stubbed model response, so
 * the assertions cover the whole post-parse path the scan route uses: JSON
 * round-trip → defensive normalization → the (NEW)+ISBN dedupe. That matters
 * because the normalizer rebuilds every line from a WHITELIST — a field it
 * does not name is silently dropped no matter what the model returned.
 */

const { mockClaudeJson } = vi.hoisted(() => ({ mockClaudeJson: vi.fn() }));

vi.mock('@/lib/ai/claude', () => ({ claudeGenerateJsonString: mockClaudeJson }));
vi.mock('@/lib/ai/provider', () => ({ resolveAiProvider: () => 'claude' }));
vi.mock('@/lib/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_PO_SCAN_MODEL: 'claude-sonnet-5',
    GEMINI_API_KEY: '',
    GEMINI_MODEL: 'gemini-2.0-flash',
  },
}));

import { extractPoFromMedia } from './extract';

const MEDIA = [{ base64: 'AAAA', mimeType: 'image/jpeg' }];

/** Feeds the extractor a raw model payload as a JSON STRING, as the API does. */
function respond(payload: Record<string, unknown>) {
  mockClaudeJson.mockResolvedValue(JSON.stringify(payload));
}

function po(lines: Array<Record<string, unknown>>) {
  return {
    poNumber: 'PO-77',
    vendorName: 'Team Outfitters',
    vendorAddress: '',
    orderDate: '2026-07-27',
    expectedDate: '',
    subtotal: 0,
    tax: 0,
    freight: 0,
    grandTotal: 0,
    overallConfidence: 0.95,
    lines,
  };
}

function baseLine(extra: Record<string, unknown> = {}) {
  return {
    lineNumber: 1,
    description: 'Falcons Home Jersey',
    vendorSku: 'FHJ-2026',
    quantity: 3,
    uom: 'EA',
    unitPrice: 42,
    lineTotal: 126,
    lineType: 'inventory',
    confidence: 0.94,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractPoFromMedia — variant fields survive the normalizer', () => {
  it('carries every variant field through the whitelist rebuild', async () => {
    respond(
      po([
        baseLine({
          size: '10.5',
          sizeSystem: 'us_mens',
          width: '2E',
          colorway: 'Black/White',
          jerseyNumber: '07',
          playerName: 'A. Rosas',
          groupHint: 'Nike Pegasus 41 FD2722',
          mappingConfidence: 0.72,
        }),
      ]),
    );

    const out = await extractPoFromMedia(MEDIA);
    const l = out.lines[0]!;

    expect(l.size).toBe('10.5');
    // The one normalization we DO apply: the size SYSTEM is an enumerator.
    expect(l.sizeSystem).toBe('US_MENS');
    expect(l.width).toBe('2E');
    expect(l.colorway).toBe('Black/White');
    expect(l.jerseyNumber).toBe('07');
    expect(l.playerName).toBe('A. Rosas');
    expect(l.groupHint).toBe('Nike Pegasus 41 FD2722');
    expect(l.mappingConfidence).toBe(0.72);
  });

  it('keeps a leading-zero jersey number as a STRING end to end', async () => {
    respond(
      po([
        baseLine({ lineNumber: 1, jerseyNumber: '07' }),
        baseLine({ lineNumber: 2, jerseyNumber: '00', description: 'Jersey 00' }),
        baseLine({ lineNumber: 3, jerseyNumber: '0', description: 'Jersey 0' }),
      ]),
    );

    const out = await extractPoFromMedia(MEDIA);

    expect(out.lines.map((l) => l.jerseyNumber)).toEqual(['07', '00', '0']);
    for (const l of out.lines) expect(typeof l.jerseyNumber).toBe('string');
  });

  it('never coerces a numeric jerseyNumber into the field (7 is not 07)', async () => {
    // A model that ignores the "as text" instruction must NOT produce a
    // silently-wrong number: the value is dropped, not cast.
    respond(po([baseLine({ jerseyNumber: 7 })]));

    const out = await extractPoFromMedia(MEDIA);

    expect(out.lines[0]!.jerseyNumber).toBe('');
  });

  it('missing stays missing — absent variant fields become empty, never invented', async () => {
    respond(po([baseLine()]));

    const out = await extractPoFromMedia(MEDIA);
    const l = out.lines[0]!;

    expect(l.size).toBe('');
    expect(l.sizeSystem).toBe('');
    expect(l.width).toBe('');
    expect(l.colorway).toBe('');
    expect(l.jerseyNumber).toBe('');
    expect(l.playerName).toBe('');
    expect(l.groupHint).toBe('');
    expect(l.mappingConfidence).toBeNull();
  });

  it('trims whitespace but preserves the printed size characters', async () => {
    respond(po([baseLine({ size: '  XL  ', playerName: '  A. Rosas ' })]));

    const out = await extractPoFromMedia(MEDIA);

    expect(out.lines[0]!.size).toBe('XL');
    expect(out.lines[0]!.playerName).toBe('A. Rosas');
  });

  it('clamps mappingConfidence to 0..1 and nulls a non-numeric one', async () => {
    respond(
      po([
        baseLine({ lineNumber: 1, mappingConfidence: 1.4 }),
        baseLine({ lineNumber: 2, mappingConfidence: -3 }),
        baseLine({ lineNumber: 3, mappingConfidence: 'high' }),
        baseLine({ lineNumber: 4, mappingConfidence: null }),
      ]),
    );

    const out = await extractPoFromMedia(MEDIA);

    expect(out.lines.map((l) => l.mappingConfidence)).toEqual([1, 0, null, null]);
  });

  it('does not regress the (NEW)+ISBN $0 dedupe when variant fields are present', async () => {
    respond(
      po([
        baseLine({
          lineNumber: 1,
          description: 'Persepolis',
          vendorSku: 'N/A',
          unitPrice: 106.5,
          quantity: 10,
        }),
        baseLine({
          lineNumber: 2,
          description: '(NEW)PERSEPOLIS',
          vendorSku: '9780375714573',
          unitPrice: 0,
          lineTotal: 0,
          quantity: 10,
        }),
      ]),
    );

    const out = await extractPoFromMedia(MEDIA);

    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]!.description).toBe('Persepolis');
    expect(out.lines[0]!.vendorSku).toBe('9780375714573');
  });
});

describe('PO extraction prompt — anti-invention discipline', () => {
  it('tells the model never to invent a serial, number, size, quantity, SKU, team or player', async () => {
    respond(po([baseLine()]));
    await extractPoFromMedia(MEDIA);

    const system = (mockClaudeJson.mock.calls[0]![0] as { system: string }).system;
    expect(system).toMatch(/[Nn]ever invent/);
    expect(system).toMatch(/jersey number/i);
    expect(system).toMatch(/missing value must stay missing/i);
    expect(system).toMatch(/mappingConfidence/);
  });

  it('leaves the model enough output budget for the wider line shape', async () => {
    // Eight more keys per line shrinks how many lines fit in one response. A
    // 40-line book PO used to fit in 4096 and must still fit, or it fails as
    // "AI returned non-JSON" on a truncated payload.
    respond(po([baseLine()]));
    await extractPoFromMedia(MEDIA);

    const { maxTokens } = mockClaudeJson.mock.calls[0]![0] as { maxTokens: number };
    expect(maxTokens).toBeGreaterThanOrEqual(8192);
  });

  it('declares every variant field in the schema handed to the model', async () => {
    respond(po([baseLine()]));
    await extractPoFromMedia(MEDIA);

    const schema = (mockClaudeJson.mock.calls[0]![0] as { schema: Record<string, unknown> })
      .schema as {
      properties: { lines: { items: { properties: Record<string, { type: string }> } } };
    };
    const props = schema.properties.lines.items.properties;

    for (const key of [
      'size',
      'sizeSystem',
      'width',
      'colorway',
      'jerseyNumber',
      'playerName',
      'groupHint',
      'mappingConfidence',
    ]) {
      expect(props[key]).toBeDefined();
    }
    // The jersey number MUST be declared as a string, or the model returns 7
    // for "07" before our normalizer ever sees it.
    expect(props.jerseyNumber!.type).toBe('string');
    expect(props.mappingConfidence!.type).toBe('number');
  });
});
