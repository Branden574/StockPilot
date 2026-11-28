import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_ALERTS_FAILED, SECURITY_ALERTS_REFUSED } from '@stockpilot/core';

/**
 * The security alerts' "Check again" (a Server Action the open console page
 * calls). Security invariant. Pinned: the console's read gate
 * (checkPlatformConsoleRead) is asked first, before the input is looked at
 * and before the service is touched; a refused gate answers the one fixed,
 * frozen refusal, whatever was sent, and reads nothing; the input is an
 * empty object, and anything else is a failed read (never a refusal, never a
 * thrown error); a failed read is handed on as it came; the action reads
 * only (it calls no other database function and writes nothing).
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
vi.mock('@/server/services/platform/security-alerts', () => ({
  readPlatformSecurityAlerts: (...a: unknown[]) => {
    h.order.push('read');
    return h.read(...a);
  },
}));

import { readPlatformSecurityAlertsAction } from './security-alerts';

const VIEW = { ok: true, view: { v: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.gate = { ok: true };
  h.read.mockResolvedValue(VIEW);
});

describe('readPlatformSecurityAlertsAction', () => {
  it('asks the gate first and reads only after it, with nothing handed on', async () => {
    await expect(readPlatformSecurityAlertsAction({})).resolves.toBe(VIEW);
    expect(h.order).toEqual(['gate', 'read']);
    expect(h.read.mock.calls).toEqual([[]]);
  });

  it('a refused gate: the one frozen refusal, whatever was sent, and the service is never called', async () => {
    h.gate = { ok: false };
    const answers = [];
    for (const input of [{}, { limit: 200 }, null, 'x', undefined]) {
      answers.push(await readPlatformSecurityAlertsAction(input));
    }
    for (const answer of answers) expect(answer).toBe(SECURITY_ALERTS_REFUSED);
    expect(Object.isFrozen(SECURITY_ALERTS_REFUSED)).toBe(true);
    expect(SECURITY_ALERTS_REFUSED).toEqual({ ok: false, reason: 'refused' });
    expect(h.order).toEqual(['gate', 'gate', 'gate', 'gate', 'gate']);
    expect(h.read).not.toHaveBeenCalled();
  });

  it.each([
    ['a key', { limit: 200 }],
    ['a switch', { push_on: true }],
    ['null', null],
    ['a string', 'all'],
    ['an array', []],
    ['nothing', undefined],
  ])(
    'an input that is not an empty object (%s) is a failed read, not a refusal',
    async (_w, input) => {
      await expect(readPlatformSecurityAlertsAction(input)).resolves.toBe(SECURITY_ALERTS_FAILED);
      expect(h.order).toEqual(['gate']);
      expect(Object.isFrozen(SECURITY_ALERTS_FAILED)).toBe(true);
    },
  );

  it('a read that could not check is handed on as it came', async () => {
    h.read.mockResolvedValue(SECURITY_ALERTS_FAILED);
    await expect(readPlatformSecurityAlertsAction({})).resolves.toBe(SECURITY_ALERTS_FAILED);
  });

  it('reads only: no other function, no write, no revalidation, no cookie', () => {
    const file = readFileSync(path.resolve(__dirname, 'security-alerts.ts'), 'utf8');
    // The code, without its comments (which say what it does not do).
    const source = file.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).toContain('checkPlatformConsoleRead()');
    expect(source).not.toMatch(/\.rpc\(|\.from\(|revalidate|cookies\(|redirect\(/);
    expect(source).not.toMatch(/platform_security_alert_set|platform_admin_user_ids/);
    expect(file.startsWith("'use server';")).toBe(true);
  });
});
