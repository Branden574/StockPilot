import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: { GEMINI_API_KEY: '', GEMINI_MODEL: 'gemini-2.5-flash', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'claude-haiku-4-5' },
}));

import { verifyAiTitleAgainstGoogleBooks } from './lookup-gemini';

/**
 * Field regression: scanning HMH civics ISBN 9780544917149 (all 4 free
 * sources return zero) made the AI 5th source answer "The Martian" with
 * claimed-high confidence. The reverse-verification must catch exactly
 * this: a FAMOUS title whose real ISBNs (which Google Books knows) don't
 * include the scanned one.
 */
const HMH_CIVICS_ISBN = '9780544917149';

function stubGoogleBooks(payload: unknown, ok = true) {
  const fn = vi.fn(async () => ({
    ok,
    json: async () => payload,
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('verifyAiTitleAgainstGoogleBooks (AI hallucination reverse-check)', () => {
  it("CONTRADICTED: famous title's known editions don't include our ISBN (The Martian case)", async () => {
    stubGoogleBooks({
      items: [
        { volumeInfo: { industryIdentifiers: [{ identifier: '9780553418026' }, { identifier: '0553418025' }] } },
        { volumeInfo: { industryIdentifiers: [{ identifier: '9780804139021' }] } },
      ],
    });
    await expect(
      verifyAiTitleAgainstGoogleBooks(HMH_CIVICS_ISBN, 'The Martian', 'Andy Weir'),
    ).resolves.toBe('contradicted');
  });

  it('CONFIRMED: an edition carries our exact ISBN-13', async () => {
    stubGoogleBooks({
      items: [{ volumeInfo: { industryIdentifiers: [{ identifier: '978-0-544-91714-9' }] } }],
    });
    await expect(
      verifyAiTitleAgainstGoogleBooks(HMH_CIVICS_ISBN, 'HMH Social Studies: Civics', null),
    ).resolves.toBe('confirmed');
  });

  it('CONFIRMED via ISBN-10 variant: edition lists the 10-digit form', async () => {
    // 9780544917149 → ISBN-10 0544917146 (isbnVariants conversion).
    stubGoogleBooks({
      items: [{ volumeInfo: { industryIdentifiers: [{ identifier: '0544917146' }] } }],
    });
    await expect(
      verifyAiTitleAgainstGoogleBooks(HMH_CIVICS_ISBN, 'HMH Social Studies: Civics', null),
    ).resolves.toBe('confirmed');
  });

  it('UNKNOWN: Google Books has never heard of the title (obscure academic book — keep)', async () => {
    stubGoogleBooks({});
    await expect(
      verifyAiTitleAgainstGoogleBooks(HMH_CIVICS_ISBN, 'District 7 Civics Workbook', null),
    ).resolves.toBe('unknown');
  });

  it('UNKNOWN: editions exist but expose no identifiers (cannot disprove)', async () => {
    stubGoogleBooks({ items: [{ volumeInfo: {} }, { volumeInfo: { industryIdentifiers: [] } }] });
    await expect(
      verifyAiTitleAgainstGoogleBooks(HMH_CIVICS_ISBN, 'United States Government', null),
    ).resolves.toBe('unknown');
  });

  it('UNKNOWN on fetch failure (fail open, never break the lookup)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    );
    await expect(
      verifyAiTitleAgainstGoogleBooks(HMH_CIVICS_ISBN, 'Anything', null),
    ).resolves.toBe('unknown');
  });

  it('UNKNOWN on non-OK response', async () => {
    stubGoogleBooks({}, false);
    await expect(
      verifyAiTitleAgainstGoogleBooks(HMH_CIVICS_ISBN, 'Anything', null),
    ).resolves.toBe('unknown');
  });
});
