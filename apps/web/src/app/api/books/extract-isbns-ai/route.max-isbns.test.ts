import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { claudeGenerateJsonString } from '@/lib/ai/claude';
import { withApiContext } from '@/lib/auth/api-context';
import { lookupIsbn } from '@/lib/books/lookup';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeSupabaseStub } from '@/test/supabase-mock';
import { syntheticIsbn13s } from '@/test/synthetic-isbns';

import { POST } from './route';

/**
 * The extraction's `maxIsbns` field (docket B76). The web AI Assistant can
 * send at most 50 ISBNs from a file (the assistant previews and imports at
 * most that many per call), and it now sends that number with the file. A
 * list past it is refused by the panel whatever the AI adds, so the route
 * skips the AI work that could only make the list longer:
 *
 *   - a text file (CSV, TXT, Word, Excel) whose regex hits already pass it is
 *     answered without the model call;
 *   - when the ISBNs kept whatever the lookups say (the regex hits, then the
 *     model's high and medium candidates) already pass it, the model's
 *     title-only guesses are not looked up. Each lookup can end in a paid
 *     model call.
 *
 * A PDF or a photo still goes to the model: only the model can read it.
 * Without the field (Bulk ISBN import, the phone), or with anything other
 * than a whole number from 1 to 999, nothing changes.
 *
 * The real route and the real extraction helper. The context, the rate
 * limit, the reporter, the environment, both vendors' clients and the ISBN
 * lookup are stubbed, so no test reaches a model or a lookup source.
 */

const h = vi.hoisted(() => ({
  env: {
    GEMINI_MODEL: 'test-model',
    GEMINI_API_KEY: undefined as string | undefined,
    ANTHROPIC_API_KEY: undefined as string | undefined,
    AI_PROVIDER: undefined as 'claude' | 'gemini' | undefined,
  },
  generateContent: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/env', () => ({ env: h.env }));
vi.mock('@/lib/ai/claude', () => ({ claudeGenerateJsonString: vi.fn() }));
vi.mock('@google/generative-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/generative-ai')>()),
  GoogleGenerativeAI: vi.fn(function () {
    return { getGenerativeModel: () => ({ generateContent: h.generateContent }) };
  }),
}));
vi.mock('@/lib/books/lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/books/lookup')>()),
  lookupIsbn: vi.fn(),
}));

/** What a configured key reads as here: the vendors' clients are stubbed. */
const CONFIGURED = 'configured-in-test';

const SKIPPED_AI = 'More ISBNs than the limit asked for: the AI pass was skipped.';
const UNCHECKED_GUESSES =
  'More ISBNs than the limit asked for: guesses from titles were not checked.';

type Candidate = { isbn: string; title?: string; confidence: 'high' | 'medium' | 'low' };

/** The model's answer, in the shape the extraction schema asks for. */
function modelAnswers(candidates: Candidate[]) {
  vi.mocked(claudeGenerateJsonString).mockResolvedValue(JSON.stringify({ candidates }));
}
const high = (isbns: string[]): Candidate[] => isbns.map((isbn) => ({ isbn, confidence: 'high' }));
/** Title-only guesses: the model proposes an ISBN for a title it read. */
const guesses = (isbns: string[]): Candidate[] =>
  isbns.map((isbn, i) => ({ isbn, title: `Sample Title ${i + 1}`, confidence: 'low' }));

function upload(name: string, type: string, content: string, maxIsbns?: string | Blob): Request {
  const form = new FormData();
  form.append('file', new File([content], name, { type }));
  if (maxIsbns !== undefined) form.append('maxIsbns', maxIsbns);
  return new Request('https://test.local/api/books/extract-isbns-ai', {
    method: 'POST',
    body: form,
  });
}

/** A CSV with one ISBN per row, under a header. */
const csv = (isbns: string[]) => ['ISBN', ...isbns].join('\n');

async function extract(req: Request) {
  const res = await POST(req);
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; isbns: string[]; notes: string; path: string };
}

describe('POST /api/books/extract-isbns-ai with maxIsbns (B76)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.env.GEMINI_API_KEY = undefined;
    h.env.AI_PROVIDER = undefined;
    h.env.ANTHROPIC_API_KEY = CONFIGURED;
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'staff' as const,
      supabase: makeSupabaseStub({}).client as never,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>(['ai', 'inventory', 'books']),
    } as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    } as never);
    // Every guess checks out, so a guess is kept whenever it is looked up.
    vi.mocked(lookupIsbn).mockImplementation(
      async (isbn: string) => ({ isbn, title: 'Sample Title' }) as never,
    );
    modelAnswers([]);
  });

  it('a CSV whose regex finds 51 ISBNs, with maxIsbns 50: all 51, and no model call (9)', async () => {
    const isbns = syntheticIsbn13s(51);
    const body = await extract(upload('order-sheet.csv', 'text/csv', csv(isbns), '50'));
    expect(body).toMatchObject({ ok: true, isbns, notes: SKIPPED_AI, path: 'text' });
    expect(claudeGenerateJsonString).not.toHaveBeenCalled();
    expect(h.generateContent).not.toHaveBeenCalled();
    expect(lookupIsbn).not.toHaveBeenCalled();
  });

  it('a photo whose model answer has 51 ISBNs it read and 3 guesses: the 51, and no lookup (10)', async () => {
    const read = syntheticIsbn13s(51);
    modelAnswers([...high(read), ...guesses(syntheticIsbn13s(3, 900))]);
    const body = await extract(upload('order-sheet.png', 'image/png', 'not really a png', '50'));
    expect(body).toMatchObject({ ok: true, isbns: read, notes: UNCHECKED_GUESSES });
    // The photo still goes to the model: only the model can read it.
    expect(claudeGenerateJsonString).toHaveBeenCalledTimes(1);
    expect(lookupIsbn).not.toHaveBeenCalled();
  });

  it('a CSV with 30 regex hits and 25 more the model read, and 4 guesses: the 55, and no lookup (11)', async () => {
    const regex = syntheticIsbn13s(30);
    const read = syntheticIsbn13s(25, 100);
    modelAnswers([...high(read), ...guesses(syntheticIsbn13s(4, 900))]);
    const body = await extract(upload('order-sheet.csv', 'text/csv', csv(regex), '50'));
    expect(body.isbns).toEqual([...regex, ...read]);
    expect(body.notes).toBe(UNCHECKED_GUESSES);
    expect(claudeGenerateJsonString).toHaveBeenCalledTimes(1);
    expect(lookupIsbn).not.toHaveBeenCalled();
  });

  it('ignores a maxIsbns that is not a whole number from 1 to 999, and the model runs (13)', async () => {
    const isbns = syntheticIsbn13s(51);
    for (const value of ['0', '-1', 'abc', '1000', '5.5', '', '050', ' 50', new Blob(['50'])]) {
      vi.mocked(claudeGenerateJsonString).mockClear();
      const body = await extract(upload('order-sheet.csv', 'text/csv', csv(isbns), value));
      const label = typeof value === 'string' ? JSON.stringify(value) : 'a file';
      expect(claudeGenerateJsonString, label).toHaveBeenCalledTimes(1);
      expect(body.isbns, label).toEqual(isbns);
      expect(body.notes, label).toBe('51 regex hits');
    }
  });

  it('at the cap or under it, the model runs once and the guesses are checked, as before (14)', async () => {
    const regex = syntheticIsbn13s(50);
    const guessed = syntheticIsbn13s(2, 900);
    modelAnswers(guesses(guessed));
    const body = await extract(upload('order-sheet.csv', 'text/csv', csv(regex), '50'));
    expect(claudeGenerateJsonString).toHaveBeenCalledTimes(1);
    expect(lookupIsbn).toHaveBeenCalledTimes(2);
    // The panel then refuses these 52, as it would have without the field.
    expect(body.isbns).toEqual([...regex, ...guessed]);
    expect(body.notes).toBe('50 regex hits, +2 from AI');
  });

  it('without maxIsbns (Bulk ISBN import, the phone), the model and the checks run whatever the count (14)', async () => {
    const regex = syntheticIsbn13s(51);
    const guessed = syntheticIsbn13s(2, 900);
    modelAnswers(guesses(guessed));
    const body = await extract(upload('order-sheet.csv', 'text/csv', csv(regex)));
    expect(claudeGenerateJsonString).toHaveBeenCalledTimes(1);
    expect(lookupIsbn).toHaveBeenCalledTimes(2);
    expect(body.isbns).toEqual([...regex, ...guessed]);
  });

  it('a PDF with maxIsbns still goes to the model, and its guesses are checked under the cap (14)', async () => {
    const read = syntheticIsbn13s(10);
    const guessed = syntheticIsbn13s(3, 900);
    modelAnswers([...high(read), ...guesses(guessed)]);
    const body = await extract(
      upload('order-sheet.pdf', 'application/pdf', '%PDF-1.4 placeholder', '50'),
    );
    expect(body.path).toBe('multimodal');
    expect(claudeGenerateJsonString).toHaveBeenCalledTimes(1);
    expect(lookupIsbn).toHaveBeenCalledTimes(3);
    expect(body.isbns).toEqual([...read, ...guessed]);
  });
});
