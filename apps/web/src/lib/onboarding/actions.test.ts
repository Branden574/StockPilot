/**
 * Tour-state Server Actions report whether they worked (2026-09-22).
 *
 * The browser now keeps the tour state for the whole session
 * (tour-state-cache.ts), so a failed read must be distinguishable from "no
 * tours seen yet", and an outcome may only be applied locally once the
 * server confirms it. postgrest-js RESOLVES failures ({ data: null, error })
 * instead of throwing, so the `error` field is what these pin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withContext: vi.fn(),
  readResult: { data: null as unknown, error: null as unknown },
  upsertResult: { error: null as unknown },
  upsert: vi.fn(),
}));

vi.mock('@/server/services/context', () => ({
  withContext: () => h.withContext(),
}));

function fakeSupabase() {
  const select = {
    eq: () => select,
    maybeSingle: async () => h.readResult,
  };
  return {
    from: (table: string) => {
      expect(table).toBe('user_onboarding');
      return {
        select: () => select,
        upsert: async (row: unknown, opts: unknown) => {
          h.upsert(row, opts);
          return h.upsertResult;
        },
      };
    },
  };
}

import { getTourStateAction, recordTourOutcomeAction } from './actions';

beforeEach(() => {
  h.withContext.mockReset();
  h.upsert.mockReset();
  h.withContext.mockImplementation(async () => ({
    userId: 'user-a',
    role: 'admin',
    supabase: fakeSupabase(),
  }));
  h.readResult = { data: null, error: null };
  h.upsertResult = { error: null };
});

describe('getTourStateAction', () => {
  it('names the user it read for', async () => {
    h.readResult = {
      data: { completed_tours: { 'items-page': { v: 1 } }, dismissed_tours: null },
      error: null,
    };
    await expect(getTourStateAction()).resolves.toEqual({
      ok: true,
      userId: 'user-a',
      completed: { 'items-page': { v: 1 } },
      dismissed: {},
    });
  });

  it('a person with no row yet is a SUCCESSFUL empty read', async () => {
    await expect(getTourStateAction()).resolves.toMatchObject({ ok: true, userId: 'user-a' });
  });

  it('a resolved query error is a failed read, not "nothing seen"', async () => {
    h.readResult = { data: null, error: { message: 'upstream timeout' } };
    await expect(getTourStateAction()).resolves.toEqual({
      ok: false,
      userId: null,
      completed: {},
      dismissed: {},
    });
  });

  it('a thrown context error is a failed read', async () => {
    h.withContext.mockImplementation(async () => {
      throw new Error('no session');
    });
    await expect(getTourStateAction()).resolves.toMatchObject({ ok: false, userId: null });
  });
});

describe('recordTourOutcomeAction', () => {
  const input = { tourId: 'items-page', version: 2, outcome: 'dismissed' as const };

  it('merges into the existing map and confirms the write for the session user', async () => {
    h.readResult = {
      data: { completed_tours: {}, dismissed_tours: { 'orders-page': { v: 1 } } },
      error: null,
    };
    await expect(recordTourOutcomeAction(input)).resolves.toEqual({ ok: true, userId: 'user-a' });
    const [row] = h.upsert.mock.calls[0]!;
    expect(Object.keys((row as { dismissed_tours: object }).dismissed_tours).sort()).toEqual([
      'items-page',
      'orders-page',
    ]);
  });

  it('a failed read of the current map writes NOTHING (it would erase every other tour)', async () => {
    h.readResult = { data: null, error: { message: 'upstream timeout' } };
    await expect(recordTourOutcomeAction(input)).resolves.toEqual({ ok: false });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('a failed write is reported as not recorded', async () => {
    h.upsertResult = { error: { message: 'rls' } };
    await expect(recordTourOutcomeAction(input)).resolves.toEqual({ ok: false });
  });

  it('rejects malformed input without touching the database', async () => {
    await expect(
      recordTourOutcomeAction({ ...input, tourId: 'NOT valid!' }),
    ).resolves.toEqual({ ok: false });
    expect(h.withContext).not.toHaveBeenCalled();
  });
});
