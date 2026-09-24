import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import { RentalsService } from '@/server/services/rentals';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/server/services/rentals', () => ({
  RentalsService: vi.fn(),
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(async () => undefined),
}));

/** Security invariant (S6-A, listed in scripts/security-test.sh): the one
 *  body every internal failure gets is a fixed sentence (the phone shows
 *  `message ?? error`), never the error's own text. */
const INTERNAL_BODY = {
  error: 'internal_error',
  message: 'Something went wrong. Please try again.',
};

const WAREHOUSE = '11111111-1111-1111-1111-111111111111';
const ITEM = '22222222-2222-2222-2222-222222222222';

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['rentals']),
  };
}

function futureIso(days = 7) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function validBody() {
  return {
    warehouseId: WAREHOUSE,
    borrowerName: 'Andrew Rosas',
    borrowerEmail: 'andrew@example.com',
    expectedReturnAt: futureIso(),
    notes: 'Canopy #3',
    lines: [{ itemId: ITEM, quantity: 2 }],
  };
}

function buildRequest(body: unknown) {
  return new Request('https://test.local/api/v1/rentals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

function mockCreate(impl: () => Promise<{ id: string }>) {
  const create = vi.fn(impl);
  vi.mocked(RentalsService).mockImplementationOnce(function () {
    return { create } as unknown as InstanceType<typeof RentalsService>;
  });
  return create;
}

describe('POST /api/v1/rentals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('creates the rental through RentalsService.create and returns 201', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const create = mockCreate(async () => ({ id: 'rental-1' }));

    const res = await POST(buildRequest(validBody()));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'rental-1' });
    // The whole point of the route: the service runs, so lines,
    // reservations, the availability guard, audit + email all happen.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouseId: WAREHOUSE,
        borrowerName: 'Andrew Rosas',
        lines: [{ itemId: ITEM, quantity: 2 }],
      }),
    );
  });

  it('rejects a line-less rental with 400 before touching the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const create = mockCreate(async () => ({ id: 'never' }));

    const res = await POST(buildRequest({ ...validBody(), lines: [] }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'validation_error' });
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 400 on a malformed JSON body instead of throwing', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const req = new Request('https://test.local/api/v1/rentals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    }) as unknown as Parameters<typeof POST>[0];
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it.each([
    ['validation_error', 400],
    ['forbidden', 403],
    ['module_disabled', 403],
    ['plan_limit_exceeded', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['unauthenticated', 401],
    ['internal_error', 500],
  ] as const)('maps ServiceError %s to %i', async (code, status) => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockCreate(async () => {
      throw new ServiceError(code, 'nope');
    });

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: code });
  });

  it('surfaces the availability refusal message verbatim so the phone can show it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockCreate(async () => {
      throw new ServiceError(
        'validation_error',
        'Projector B: only 2 available to rent (5 on hand, 3 already reserved) — 5 requested.',
      );
    });

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('only 2 available to rent');
  });

  it('never leaks a raw internal_error detail to the caller', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    mockCreate(async () => {
      throw new Error('relation "rentals" violates policy rentals_insert');
    });

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(INTERNAL_BODY);
    expect(text).not.toContain('rentals_insert');
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
  });

  // S6-A. A ServiceError internal_error carries the raw PostgREST text in
  // `internalDetail` (its public message is already generic, S13). The body
  // is the fixed one, and the raw text goes to the reporter, which it never
  // reached before. Mutation caught: answering `{ error, message:
  // e.internalDetail ?? e.message }`, or answering without reporting.
  it('answers an internal ServiceError with the fixed body and reports the raw detail', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const raw =
      'canceling statement due to statement timeout while locking tuple (0,6) in relation "inventory_items"';
    mockCreate(async () => {
      throw new ServiceError('internal_error', raw);
    });

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(INTERNAL_BODY);
    expect(text).not.toContain('inventory_items');
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
    const reported = vi.mocked(reportError).mock.calls[0]![0] as Error;
    expect(reported.message).toBe(raw);
  });

  it('keeps an app-authored conflict sentence (a lock timeout) as a 409 the phone can show', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const sentence =
      'Someone else is checking out or approving these items right now. Try again in a moment.';
    mockCreate(async () => {
      throw new ServiceError('conflict', sentence);
    });

    const res = await POST(buildRequest(validBody()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', message: sentence });
    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
  });
});
