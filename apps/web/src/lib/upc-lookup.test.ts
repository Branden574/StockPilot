import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  parseUpcitemdbResponse,
  shouldUseAiDescription,
  buildAiDescriptionPrompt,
  lookupUpc,
  type UpcEnrichment,
} from './upc-lookup';

describe('parseUpcitemdbResponse', () => {
  it('extracts the first item from a populated response', () => {
    const raw = {
      items: [
        {
          title: 'Beats Solo 3 Wireless Headphones',
          description: 'On-ear wireless headphones with 40-hr battery.',
          brand: 'Beats',
          model: 'MX432LL/A',
          images: ['https://images.example.com/beats.jpg'],
        },
      ],
    };
    const out = parseUpcitemdbResponse(raw);
    expect(out).toEqual({
      name: 'Beats Solo 3 Wireless Headphones',
      description: 'On-ear wireless headphones with 40-hr battery.',
      brand: 'Beats',
      modelNumber: 'MX432LL/A',
      imageUrl: 'https://images.example.com/beats.jpg',
    });
  });

  it('returns null when items array is empty', () => {
    expect(parseUpcitemdbResponse({ items: [] })).toBeNull();
  });

  it('returns null when items key is missing', () => {
    expect(parseUpcitemdbResponse({})).toBeNull();
  });

  it('coerces blank fields to null but keeps title (name) intact', () => {
    const raw = {
      items: [
        {
          title: 'Some Product',
          description: '',
          brand: '',
          model: '',
          images: [],
        },
      ],
    };
    const out = parseUpcitemdbResponse(raw);
    expect(out).toEqual({
      name: 'Some Product',
      description: null,
      brand: null,
      modelNumber: null,
      imageUrl: null,
    });
  });

  it('returns null when the title is missing — a hit without a name is useless', () => {
    const raw = { items: [{ title: '', brand: 'Foo' }] };
    expect(parseUpcitemdbResponse(raw)).toBeNull();
  });
});

describe('shouldUseAiDescription', () => {
  it('returns true when name+brand exist but description is null', () => {
    expect(
      shouldUseAiDescription({
        name: 'Beats Solo 3',
        brand: 'Beats',
        description: null,
        modelNumber: 'MX432LL/A',
        imageUrl: null,
      }),
    ).toBe(true);
  });

  it('returns true when description is whitespace-only', () => {
    expect(
      shouldUseAiDescription({
        name: 'X',
        brand: 'Y',
        description: '   ',
        modelNumber: null,
        imageUrl: null,
      }),
    ).toBe(true);
  });

  it('returns false when description is present and non-trivial', () => {
    expect(
      shouldUseAiDescription({
        name: 'X',
        brand: 'Y',
        description: 'A real description.',
        modelNumber: null,
        imageUrl: null,
      }),
    ).toBe(false);
  });

  it('returns false when name is missing — nothing to describe', () => {
    expect(
      shouldUseAiDescription({
        name: '',
        brand: 'Y',
        description: null,
        modelNumber: null,
        imageUrl: null,
      }),
    ).toBe(false);
  });
});

describe('buildAiDescriptionPrompt', () => {
  it('quotes the name and brand verbatim and asks for a 2-sentence write-up', () => {
    const p = buildAiDescriptionPrompt('Beats Solo 3', 'Beats');
    expect(p).toContain("'Beats Solo 3'");
    expect(p).toContain('Beats');
    expect(p).toMatch(/2.?sentence/i);
  });

  it('handles a missing brand cleanly', () => {
    const p = buildAiDescriptionPrompt('Mystery Box', null);
    expect(p).toContain("'Mystery Box'");
    // Should not say "by null"
    expect(p).not.toMatch(/by null/i);
  });

  it('never asks the model for a model number or brand', () => {
    const p = buildAiDescriptionPrompt('Foo', 'Bar');
    expect(p).toMatch(/do not invent|do not guess|never invent/i);
  });
});

describe('lookupUpc — integration of the chain', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns upcitemdb data when the upstream returns a populated item', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            title: 'AAA Batteries 4-pack',
            description: 'Alkaline batteries.',
            brand: 'Duracell',
            model: null,
            images: ['https://img.example.com/aaa.jpg'],
          },
        ],
      }),
    } as Response);

    const out = await lookupUpc('012345678905', { enableAiFallback: false });
    expect(out.source).toBe('upcitemdb');
    expect(out.enrichment?.name).toBe('AAA Batteries 4-pack');
    expect(out.enrichment?.description).toBe('Alkaline batteries.');
  });

  it('returns not_found when upcitemdb returns no items and AI fallback is off', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    } as Response);

    const out = await lookupUpc('000000000000', { enableAiFallback: false });
    expect(out.source).toBe('not_found');
    expect(out.enrichment).toBeNull();
  });

  it('handles 429 rate-limit by falling through to not_found (no AI here, no fallback)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ message: 'rate limited' }),
    } as Response);

    const out = await lookupUpc('012345678905', { enableAiFallback: false });
    expect(out.source).toBe('not_found');
  });

  it('handles network failure as not_found (graceful)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network down'),
    );

    const out = await lookupUpc('012345678905', { enableAiFallback: false });
    expect(out.source).toBe('not_found');
  });

  it('uses AI to fill description when upcitemdb returns name+brand but no description', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            title: 'Beats Solo 3',
            description: null,
            brand: 'Beats',
            model: 'MX432LL/A',
            images: [],
          },
        ],
      }),
    } as Response);

    const fakeAi = vi
      .fn<(name: string, brand: string | null) => Promise<string>>()
      .mockResolvedValue('Wireless on-ear headphones designed for daily use.');

    const out = await lookupUpc('012345678905', {
      enableAiFallback: true,
      describeWithAi: fakeAi,
    });

    expect(out.source).toBe('ai-fallback');
    expect(out.enrichment?.name).toBe('Beats Solo 3');
    expect(out.enrichment?.description).toBe(
      'Wireless on-ear headphones designed for daily use.',
    );
    expect(out.enrichment?.modelNumber).toBe('MX432LL/A');
    expect(fakeAi).toHaveBeenCalledOnce();
  });

  it('skips AI fallback when upcitemdb returns nothing — no name = nothing to describe', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    } as Response);

    const fakeAi = vi.fn();
    const out = await lookupUpc('012345678905', {
      enableAiFallback: true,
      describeWithAi: fakeAi,
    });

    expect(out.source).toBe('not_found');
    expect(fakeAi).not.toHaveBeenCalled();
  });

  it('rejects malformed/empty UPC inputs at the boundary', async () => {
    await expect(lookupUpc('', {})).rejects.toThrow();
    await expect(lookupUpc('   ', {})).rejects.toThrow();
  });
});

// Type-check ergonomics — make sure the public shape is what callers expect.
describe('UpcEnrichment type shape', () => {
  it('compiles with all-null optional fields', () => {
    const e: UpcEnrichment = {
      name: 'X',
      description: null,
      brand: null,
      modelNumber: null,
      imageUrl: null,
    };
    expect(e.name).toBe('X');
  });
});
