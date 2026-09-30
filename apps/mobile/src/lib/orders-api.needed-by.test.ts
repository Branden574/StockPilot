import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NeededByResultShapeError } from '@stockpilot/core';

import { parseNeededByRevisionOutcome, reviseOrderNeededBy } from './orders-api';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time; hoisted mock as in orders-api.hold.test.ts.
const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => apiMock.api.mockReset());

const ORDER = '11111111-1111-1111-1111-111111111111';

const REVISION = {
  changed: true,
  previous: '2026-10-02T16:00:00.123456+00:00',
  neededBy: '2026-10-03T21:00:00+00:00',
  eventId: '22222222-2222-2222-2222-222222222222',
  eventUpdated: true,
  status: 'approved',
  schedule: 'moved',
  timeZone: 'America/Los_Angeles',
};

describe('reviseOrderNeededBy (F2-4, phone)', () => {
  it('POSTs the wall clock, the expected value as given and the reason to the needed-by route', async () => {
    apiMock.api.mockResolvedValueOnce({ revision: REVISION });
    const body = {
      neededByLocal: '2026-10-03T14:00',
      expectedNeededBy: '2026-10-02T16:00:00.123456+00:00',
      reason: 'School moved it',
    };
    const outcome = await reviseOrderNeededBy(ORDER, body);
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/orders/${ORDER}/needed-by`, {
      method: 'POST',
      body,
    });
    // The expected value leaves untouched (the stale check compares it exactly).
    const sent = (apiMock.api.mock.calls[0]![1] as { body: typeof body }).body;
    expect(sent.expectedNeededBy).toBe('2026-10-02T16:00:00.123456+00:00');
    expect(outcome).toEqual({
      changed: true,
      previous: '2026-10-02T16:00:00.123Z',
      neededBy: '2026-10-03T21:00:00.000Z',
      eventId: REVISION.eventId,
      eventUpdated: true,
      status: 'approved',
      schedule: 'moved',
      timeZone: 'America/Los_Angeles',
    });
  });

  it('an answer it cannot read is an error, never a guessed outcome', async () => {
    for (const revision of [
      undefined,
      { ...REVISION, schedule: 'teleported' },
      { ...REVISION, schedule: undefined },
      { ...REVISION, timeZone: '' },
      { ...REVISION, timeZone: undefined },
      { ...REVISION, changed: 'yes' },
    ]) {
      apiMock.api.mockResolvedValueOnce({ revision });
      await expect(reviseOrderNeededBy(ORDER, { neededByLocal: 'x', expectedNeededBy: null, reason: 'r' })).rejects.toBeInstanceOf(
        NeededByResultShapeError,
      );
    }
  });

  it('keys it does not know are ignored (a later additive change never breaks this build)', () => {
    expect(parseNeededByRevisionOutcome({ ...REVISION, schedule: 'unchanged', extra: 1 })).toMatchObject({
      schedule: 'unchanged',
    });
  });

  it("a refusal reaches the caller as the api client threw it (status, details.reason)", async () => {
    const refusal = Object.assign(new Error('Someone changed this date…'), {
      status: 409,
      details: { reason: 'needed_by_changed', current: null },
    });
    apiMock.api.mockRejectedValueOnce(refusal);
    await expect(
      reviseOrderNeededBy(ORDER, { neededByLocal: '2026-10-03T14:00', expectedNeededBy: null, reason: 'r' }),
    ).rejects.toBe(refusal);
  });
});
