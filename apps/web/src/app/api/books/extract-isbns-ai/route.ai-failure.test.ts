import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { claudeGenerateJsonString } from '@/lib/ai/claude';
import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

/**
 * S16 review: when the AI call failed, lib/books/isbn-ai-extract.ts put the
 * vendor's own text in `notes` (a provider, its billing or quota state, a
 * request id, an endpoint with the model's name, or which API key variable
 * is missing), and the route answered it with a 200. The web chat panel puts
 * `notes` into the message it sends to the AI chat, so the text was shown,
 * stored in the chat history and sent to the model. Nothing reported it.
 *
 * Now `notes` is a fixed sentence and the failure is reported, at warning
 * level, with the organization. The real route and the real extraction
 * helper; the context, the rate limit, the reporter, the environment and
 * the vendors' clients are stubbed, so no test reaches a model.
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

/** The shape of an AI vendor's refusal: its own words, a request id. */
const VENDOR_TEXT =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the API."},"request_id":"req_placeholder"}';
/** The shape of the other vendor's: its endpoint, with the model's name. */
const ENDPOINT_TEXT =
  '[GoogleGenerativeAI Error]: Error fetching from https://vendor.example.com/v1beta/models/test-model:generateContent: [429 Too Many Requests] Resource has been exhausted (e.g. check quota).';

const ISBN = '9780306406157';
/** What a configured key reads as here: the vendors' clients are stubbed. */
const CONFIGURED = 'configured-in-test';

function useContext() {
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    supabase: makeSupabaseStub({}).client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['ai', 'inventory', 'books']),
  } as never);
}

function upload(name: string, type: string, content: string) {
  const form = new FormData();
  form.append('file', new File([content], name, { type }));
  return new Request('https://test.local/api/books/extract-isbns-ai', {
    method: 'POST',
    body: form,
  });
}

async function answer(res: Response) {
  const text = await res.text();
  return { text, body: JSON.parse(text) as Record<string, unknown> };
}

describe('POST /api/books/extract-isbns-ai when the AI call fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.env.GEMINI_API_KEY = undefined;
    h.env.ANTHROPIC_API_KEY = undefined;
    h.env.AI_PROVIDER = undefined;
    useContext();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    } as never);
  });

  it('a text file: the regex hits and a fixed note, never the vendor text, and the failure is reported', async () => {
    h.env.ANTHROPIC_API_KEY = CONFIGURED;
    const err = new Error(VENDOR_TEXT);
    vi.mocked(claudeGenerateJsonString).mockRejectedValueOnce(err);

    const res = await POST(upload('order.txt', 'text/plain', `Order list\nISBN ${ISBN}\n`));

    expect(res.status).toBe(200);
    const { text, body } = await answer(res);
    expect(body).toMatchObject({
      ok: true,
      isbns: [ISBN],
      notes: 'AI extraction unavailable. Returning regex hits only.',
      path: 'text',
    });
    expect(text).not.toContain('credit balance');
    expect(text).not.toContain('req_placeholder');
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'books.extract-isbns-ai.model',
      organizationId: 'org-1',
      level: 'warning',
      extra: { path: 'text' },
    });
  });

  it('a PDF (sent to the model whole): a fixed note, never the vendor text, and reported', async () => {
    h.env.ANTHROPIC_API_KEY = CONFIGURED;
    const err = new Error(VENDOR_TEXT);
    vi.mocked(claudeGenerateJsonString).mockRejectedValueOnce(err);

    const res = await POST(upload('order.pdf', 'application/pdf', '%PDF-1.4 placeholder'));

    expect(res.status).toBe(200);
    const { text, body } = await answer(res);
    expect(body).toMatchObject({
      ok: true,
      isbns: [],
      notes: 'AI extraction unavailable.',
      path: 'multimodal',
    });
    expect(text).not.toContain('credit balance');
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'books.extract-isbns-ai.model',
      organizationId: 'org-1',
      level: 'warning',
      extra: { path: 'multimodal' },
    });
  });

  it('no AI key configured: a fixed note that names no environment variable, and reported', async () => {
    const res = await POST(upload('order.txt', 'text/plain', `ISBN ${ISBN}`));

    expect(res.status).toBe(200);
    const { text, body } = await answer(res);
    expect(body).toMatchObject({
      isbns: [ISBN],
      notes: 'AI extraction unavailable. Returning regex hits only.',
    });
    expect(text).not.toContain('_API_KEY');
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('GEMINI_API_KEY') }),
      expect.objectContaining({ tag: 'books.extract-isbns-ai.model', level: 'warning' }),
    );
  });

  it("the other vendor's failure: no endpoint, model or quota text in the answer", async () => {
    h.env.GEMINI_API_KEY = CONFIGURED;
    h.generateContent.mockRejectedValueOnce(new Error(ENDPOINT_TEXT));

    const res = await POST(upload('photo.png', 'image/png', 'not really a png'));

    expect(res.status).toBe(200);
    const { text, body } = await answer(res);
    expect(body).toMatchObject({ isbns: [], notes: 'AI extraction unavailable.' });
    expect(text).not.toContain('vendor.example.com');
    expect(text).not.toContain('test-model');
    expect(text).not.toContain('quota');
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
