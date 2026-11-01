import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { lookupIsbn } from '@/lib/books/lookup';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/books/lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/books/lookup')>()),
  lookupIsbn: vi.fn(),
}));

/**
 * GET /api/v1/books/isbn-lookup: the phone's not-in-inventory ISBN (S16). A
 * failed lookup still answers 200 with no metadata (the phone then offers a
 * blank add card), but its `error` used to be the failure's own text, a
 * failed request's address among them, and nothing was reported.
 */

const ISBN = '9780262033848';
const request = () =>
  new Request(`https://test.local/api/v1/books/isbn-lookup?isbn=${ISBN}`) as unknown as Parameters<
    typeof GET
  >[0];

describe('GET /api/v1/books/isbn-lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'staff' as const,
      supabase: makeSupabaseStub({ 'inventory_items.select': { data: null, error: null } })
        .client as never,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>(),
    });
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('answers the metadata it found', async () => {
    vi.mocked(lookupIsbn).mockResolvedValueOnce({ title: 'A Book' } as never);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      isbn: ISBN,
      existingItem: null,
      metadata: { title: 'A Book' },
    });
  });

  it('a failed lookup answers 200 with lookup_failed, never its own text, and is reported as a warning', async () => {
    const err = new Error(
      'request to https://books.example.test/volumes failed, reason: getaddrinfo ENOTFOUND',
    );
    vi.mocked(lookupIsbn).mockRejectedValueOnce(err);
    const res = await GET(request());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      isbn: ISBN,
      existingItem: null,
      metadata: null,
      error: 'lookup_failed',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toMatch(/ENOTFOUND|example\.test/);
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.v1.books.isbn_lookup',
      organizationId: 'org-1',
      level: 'warning',
    });
  });
});
