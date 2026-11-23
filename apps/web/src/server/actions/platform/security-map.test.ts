import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_MAP_POLL_FAILED, SECURITY_MAP_POLL_REFUSED } from '@stockpilot/core';

/**
 * The attack map's poll (a Server Action the open console page calls).
 *
 * Security invariant. Pinned: the console's read gate
 * (checkPlatformConsoleRead) is asked first, before the input is looked at
 * and before the service is touched; a refused gate answers the one fixed
 * refusal, the same value whatever was sent, and reads nothing; the input is
 * one of two reads and an optional day start, and anything else is a failed
 * read (never a refusal, never a thrown error); the day start is handed on
 * as an ISO instant and only to a read of the whole window.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  gate: { ok: true } as { ok: boolean },
  read: vi.fn(),
}));

vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformConsoleRead: vi.fn(async () => {
    h.order.push('gate');
    return h.gate;
  }),
  // The weaker check must not be what gates this action.
  checkPlatformAdmin: vi.fn(async () => {
    throw new Error("the action check is not this action's gate");
  }),
}));
vi.mock('@/server/services/platform/security-map', () => ({
  readPlatformSecurityMap: (...a: unknown[]) => {
    h.order.push('read');
    return h.read(...a);
  },
}));

import { pollPlatformSecurityMapAction } from './security-map';

const VIEW = { ok: true, view: { v: 1 }, refusedWindow: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.gate = { ok: true };
  h.read.mockResolvedValue(VIEW);
});

describe('pollPlatformSecurityMapAction', () => {
  it('asks the gate first and reads only after it', async () => {
    await expect(pollPlatformSecurityMapAction({ scope: 'recent', dayStart: null })).resolves.toBe(
      VIEW,
    );
    expect(h.order).toEqual(['gate', 'read']);
    expect(h.read.mock.calls).toEqual([[{ scope: 'recent', dayStart: null }]]);
  });

  it('a refused gate: the one fixed refusal, whatever was sent, and the service is never called', async () => {
    h.gate = { ok: false };
    const answers = [];
    for (const input of [
      { scope: 'whole', dayStart: null },
      { scope: 'recent', dayStart: null },
      { scope: 'everything' },
      null,
      'x',
    ]) {
      answers.push(await pollPlatformSecurityMapAction(input));
    }
    for (const answer of answers) expect(answer).toBe(SECURITY_MAP_POLL_REFUSED);
    expect(h.order).toEqual(['gate', 'gate', 'gate', 'gate', 'gate']);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('the day start is handed on as an ISO instant, to a read of the whole window only', async () => {
    await pollPlatformSecurityMapAction({ scope: 'whole', dayStart: '2026-11-23T00:00:00-08:00' });
    await pollPlatformSecurityMapAction({ scope: 'recent', dayStart: '2026-11-23T00:00:00-08:00' });
    await pollPlatformSecurityMapAction({ scope: 'whole', dayStart: null });
    expect(h.read.mock.calls).toEqual([
      [{ scope: 'whole', dayStart: '2026-11-23T08:00:00.000Z' }],
      [{ scope: 'recent', dayStart: null }],
      [{ scope: 'whole', dayStart: null }],
    ]);
  });

  it('an input it does not know is a failed read after the gate: nothing is read, nothing is thrown', async () => {
    for (const input of [
      undefined,
      null,
      'whole',
      {},
      { scope: 'everything', dayStart: null },
      { scope: 'whole' },
      { scope: 'whole', dayStart: 'midnight' },
      { scope: 'whole', dayStart: 5 },
      { scope: 'whole', dayStart: 'x'.repeat(41) },
      { scope: 'whole', dayStart: null, from: '2020-01-01T00:00:00Z' },
    ]) {
      await expect(pollPlatformSecurityMapAction(input)).resolves.toBe(SECURITY_MAP_POLL_FAILED);
    }
    expect(h.read).not.toHaveBeenCalled();
    expect(h.order.every((step) => step === 'gate')).toBe(true);
  });

  it('a caller cannot choose the window: the action takes no start and no end', async () => {
    await pollPlatformSecurityMapAction({ scope: 'whole', dayStart: null });
    expect(Object.keys(h.read.mock.calls[0]?.[0] as object).sort()).toEqual(['dayStart', 'scope']);
  });
});
