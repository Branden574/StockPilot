import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_EVENT_SAMPLES_FAILED, SECURITY_EVENT_SAMPLES_REFUSED } from '@stockpilot/core';

/**
 * "What was asked for" (a Server Action the how-to-respond panel calls once
 * when it opens).
 *
 * Security invariant. Pinned: the console's read gate
 * (checkPlatformConsoleRead) is asked first, before the input is looked at
 * and before the service is touched; a refused gate answers the one fixed
 * refusal, the same value whatever was sent, and reads nothing; the input is
 * a kind of the six or none, a whole UTC hour within 7 days or none, two
 * capitals or no country, and no other key; anything else is "could not
 * check" (never a refusal, never a thrown error) and reads nothing.
 */

const NOW = Date.parse('2026-11-24T10:15:05Z');

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
vi.mock('@/server/services/platform/security-event-samples', () => ({
  readPlatformSecurityEventSamples: (...a: unknown[]) => {
    h.order.push('read');
    return h.read(...a);
  },
}));

import { readSecurityEventSamplesAction } from './security-event-samples';

const VIEW = { ok: true, view: { v: 1 } };
const ASK = { reason: 'env_file', hour: '2026-11-24T09:00:00.000Z', country: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.order = [];
  h.gate = { ok: true };
  h.read.mockResolvedValue(VIEW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readSecurityEventSamplesAction', () => {
  it('asks the gate first and reads only after it', async () => {
    await expect(readSecurityEventSamplesAction(ASK)).resolves.toBe(VIEW);
    expect(h.order).toEqual(['gate', 'read']);
    expect(h.read.mock.calls).toEqual([[ASK, NOW]]);
  });

  it('a card opened from the legend, the hour running now and a country are handed on as sent', async () => {
    const asks = [
      { reason: null, hour: null, country: null },
      { reason: 'admin_tool', hour: '2026-11-24T10:00:00.000Z', country: null },
      { reason: 'path_traversal', hour: '2026-11-17T10:00:00.000Z', country: 'NL' },
    ];
    for (const ask of asks) await readSecurityEventSamplesAction(ask);
    expect(h.read.mock.calls.map((c) => c[0])).toEqual(asks);
  });

  it('a refused gate: the one fixed refusal, whatever was sent, and the service is never called', async () => {
    h.gate = { ok: false };
    const answers = [];
    for (const input of [ASK, { reason: null, hour: null, country: null }, { x: 1 }, null, 'x']) {
      answers.push(await readSecurityEventSamplesAction(input));
    }
    for (const answer of answers) expect(answer).toBe(SECURITY_EVENT_SAMPLES_REFUSED);
    expect(h.order).toEqual(['gate', 'gate', 'gate', 'gate', 'gate']);
    expect(h.read).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing', undefined],
    ['not an object', 'env_file'],
    ['a key too many', { ...ASK, organizationId: 'x' }],
    ['a key missing', { reason: 'env_file', hour: null }],
    ['a kind outside the six', { ...ASK, reason: 'wrong_password' }],
    ['an hour that is not whole', { ...ASK, hour: '2026-11-24T09:30:00.000Z' }],
    ['an hour after the hour running now', { ...ASK, hour: '2026-11-24T11:00:00.000Z' }],
    ['an hour more than 7 days back', { ...ASK, hour: '2026-11-17T09:00:00.000Z' }],
    ['an hour that is not a time', { ...ASK, hour: 'yesterday' }],
    ['an hour as a number', { ...ASK, hour: NOW }],
    ['a long hour', { ...ASK, hour: `2026-11-24T09:00:00.000Z${' '.repeat(40)}` }],
    ['a country in small letters', { ...ASK, country: 'nl' }],
    ['a country of three letters', { ...ASK, country: 'NLD' }],
  ])('%s: could not check, and nothing is read', async (_what, input) => {
    await expect(readSecurityEventSamplesAction(input)).resolves.toBe(
      SECURITY_EVENT_SAMPLES_FAILED,
    );
    expect(h.order).toEqual(['gate']);
    expect(h.read).not.toHaveBeenCalled();
  });
});
