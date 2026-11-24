import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_ALERTS_FAILED } from '@stockpilot/core';

import {
  FIXTURE_ACTOR,
  FIXTURE_ACTOR_EMAIL,
  FIXTURE_ORG,
  FIXTURE_ORG_NAME,
  rawAlert,
  rawChange,
  rawSecurityAlertList,
} from '@/test/security-alerts-fixture';

/**
 * The console's read of the security alerts (platform_security_alert_list,
 * migration 0480). Security invariant. Pinned: one call, with the newest 50
 * alerts and 50 changes, under its own time budget; the answer is read by
 * core's strict reader, and anything it does not know is "could not check",
 * never an empty list; the function missing, refused (no_state), failing or
 * timing out is "could not check", reported once with its code or the place
 * the shape differs, never a value from the answer; each change's actor is
 * resolved to a sign-in email in one lookup, and a lookup that fails leaves
 * the emails out without failing the read; the only organization name is
 * the one the list returns; nothing here throws.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  profiles: vi.fn(),
  calls: [] as Array<{ fn: string; args: unknown }>,
  from: [] as string[],
  inIds: [] as unknown[],
  report: vi.fn(async (_e: unknown, _c: unknown) => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: unknown) => {
      h.calls.push({ fn, args });
      const answer = Promise.resolve().then(() => h.rpc(fn, args));
      return { abortSignal: () => answer };
    },
    from: (table: string) => {
      h.from.push(table);
      const q = {
        select: () => q,
        in: (_c: string, ids: unknown[]) => {
          h.inIds.push(...ids);
          return q;
        },
        order: () => q,
        range: () => Promise.resolve().then(() => h.profiles()),
      };
      return q;
    },
  }),
}));

import { readPlatformSecurityAlerts, SECURITY_ALERTS_READ_BUDGET_MS } from './security-alerts';

beforeEach(() => {
  h.calls = [];
  h.from = [];
  h.inIds = [];
  h.rpc.mockReset();
  h.rpc.mockReturnValue({ data: rawSecurityAlertList(), error: null });
  h.profiles.mockReset();
  h.profiles.mockReturnValue({
    data: [{ id: FIXTURE_ACTOR, email: FIXTURE_ACTOR_EMAIL }],
    error: null,
  });
  h.report.mockReset();
  h.report.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readPlatformSecurityAlerts', () => {
  it('one call, the newest 50 alerts and 50 changes; the view, each actor with an email', async () => {
    const result = await readPlatformSecurityAlerts();
    expect(h.calls).toEqual([
      { fn: 'platform_security_alert_list', args: { p_limit: 50, p_changes: 50 } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.alerts).toHaveLength(7);
    expect(result.view.state.recordOnly).toBe(true);
    expect(result.view.changes[0]).toMatchObject({
      name: 'aimed_guessing_events',
      oldValue: 20,
      newValue: 40,
      actorUserId: FIXTURE_ACTOR,
      actorEmail: FIXTURE_ACTOR_EMAIL,
    });
    expect(result.view.latestChanges[0]!.actorEmail).toBe(FIXTURE_ACTOR_EMAIL);
    // One lookup, for the one actor, in user_profiles only.
    expect(h.from).toEqual(['user_profiles']);
    expect(h.inIds).toEqual([FIXTURE_ACTOR]);
    expect(h.report).not.toHaveBeenCalled();
  });

  it('the only organization name is the aimed alert’s own, as the list returns it', async () => {
    const result = await readPlatformSecurityAlerts();
    if (!result.ok) throw new Error('expected a view');
    const named = result.view.alerts.filter((a) => a.organizationName !== null);
    expect(named.map((a) => [a.rule, a.subject, a.organizationName])).toEqual([
      ['aimed_guessing', FIXTURE_ORG, FIXTURE_ORG_NAME],
    ]);
    expect(h.from).not.toContain('organizations');
  });

  it('no changes: no lookup', async () => {
    h.rpc.mockReturnValue({
      data: rawSecurityAlertList({ changes: [], latest_changes: [] }),
      error: null,
    });
    const result = await readPlatformSecurityAlerts();
    expect(result.ok).toBe(true);
    expect(h.from).toEqual([]);
  });

  it.each([
    ['fails', () => ({ data: null, error: { message: 'boom', code: 'XX000' } })],
    [
      'throws',
      () => {
        throw new Error('socket hang up');
      },
    ],
  ])(
    'a lookup of the actors that %s leaves the emails out, reported once; the read is still shown',
    async (_w, answer) => {
      h.profiles.mockImplementation(answer);
      const result = await readPlatformSecurityAlerts();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.view.changes[0]!.actorEmail).toBeNull();
      expect(h.report).toHaveBeenCalledTimes(1);
      expect(h.report.mock.calls[0]![1]).toMatchObject({
        tag: 'platform.security-alerts.actor-emails',
        level: 'warning',
        extra: { count: 1 },
      });
    },
  );

  it('a lookup of the actors that hangs is left out after 3 s', async () => {
    vi.useFakeTimers();
    h.profiles.mockImplementation(() => new Promise(() => undefined));
    const pending = readPlatformSecurityAlerts();
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await pending;
    expect(result.ok && result.view.changes[0]!.actorEmail).toBeNull();
  });

  it('an email that is not a string, or another id, is never shown', async () => {
    const other = '0e0e0e0e-0000-4000-8000-00000000000e';
    h.rpc.mockReturnValue({
      data: rawSecurityAlertList({
        changes: [
          rawChange('push_on', false, true, '2026-11-21T10:00:00+00:00'),
          {
            ...rawChange('push_on', true, false, '2026-11-21T09:00:00+00:00'),
            actor_user_id: other,
          },
        ],
      }),
      error: null,
    });
    h.profiles.mockReturnValue({
      data: [
        { id: FIXTURE_ACTOR, email: 42 },
        { id: other, email: null },
      ],
      error: null,
    });
    const result = await readPlatformSecurityAlerts();
    if (!result.ok) throw new Error('expected a view');
    expect(result.view.changes.map((c) => c.actorEmail)).toEqual([null, null]);
  });

  /* ─────────────── could not check: reported once, never a value ─────────────── */

  it.each([
    [
      'missing (PGRST202)',
      { code: 'PGRST202', message: 'Could not find the function' },
      'PGRST202',
    ],
    ['missing (42883)', { code: '42883', message: 'function does not exist' }, '42883'],
    [
      'its own cancel (57014)',
      { code: '57014', message: 'canceling statement due to timeout' },
      '57014',
    ],
    ['not allowed (42501)', { code: '42501', message: 'permission denied' }, '42501'],
    ['an error with no code', { message: 'fetch failed' }, null],
  ])('the function %s: could not check, reported with its code only', async (_w, error, code) => {
    h.rpc.mockReturnValue({ data: null, error });
    await expect(readPlatformSecurityAlerts()).resolves.toBe(SECURITY_ALERTS_FAILED);
    expect(h.report).toHaveBeenCalledTimes(1);
    const [e, ctx] = h.report.mock.calls[0]!;
    expect(ctx).toEqual({
      tag: 'platform.security-alerts.platform_security_alert_list',
      level: 'warning',
      extra: { code },
    });
    expect(String((e as Error).message)).not.toContain(error.message);
  });

  it('refused no_state: could not check, never an empty list', async () => {
    h.rpc.mockReturnValue({
      data: { refused: 'no_state', generated_at: '2026-11-24T12:05:30+00:00' },
      error: null,
    });
    await expect(readPlatformSecurityAlerts()).resolves.toBe(SECURITY_ALERTS_FAILED);
    expect(h.report.mock.calls[0]![1]).toMatchObject({ extra: { refused: 'no_state' } });
  });

  it.each([
    ['a tenth key', { ...rawSecurityAlertList(), more: 1 }],
    [
      'record_only that disagrees with its switches',
      rawSecurityAlertList({ state: { push_on: true } }),
    ],
    [
      'an alert of a rule the contract does not name',
      rawSecurityAlertList({ alerts: [{ rule: 'all' }] }),
    ],
    [
      'a change of a name the contract does not name',
      rawSecurityAlertList({
        changes: [rawChange('everything', 1, 2, '2026-11-21T10:00:00+00:00')],
      }),
    ],
    [
      'an organization name past 200 characters',
      rawSecurityAlertList({
        alerts: [rawAlert('aimed_guessing', { organization_name: 'x'.repeat(201) })],
      }),
    ],
    ['nothing', null],
  ])(
    'an answer this build cannot read (%s): could not check, with the place only',
    async (_w, data) => {
      h.rpc.mockReturnValue({ data, error: null });
      await expect(readPlatformSecurityAlerts()).resolves.toBe(SECURITY_ALERTS_FAILED);
      expect(h.report).toHaveBeenCalledTimes(1);
      const extra = (h.report.mock.calls[0]![1] as { extra: { where: string } }).extra;
      expect(Object.keys(extra)).toEqual(['where']);
      expect(extra.where.length).toBeLessThanOrEqual(80);
    },
  );

  it('a read cut at its budget: could not check, as a timeout', async () => {
    // The budget is the service's own AbortSignal.timeout, which the real
    // client turns into a thrown TimeoutError: this throw stands for it.
    h.rpc.mockImplementation(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    });
    await expect(readPlatformSecurityAlerts()).resolves.toBe(SECURITY_ALERTS_FAILED);
    expect(h.report.mock.calls[0]![1]).toMatchObject({ extra: { code: 'timeout' } });
    expect(SECURITY_ALERTS_READ_BUDGET_MS).toBe(6_000);
  });

  it('a client that throws: could not check, never a throw', async () => {
    h.rpc.mockImplementation(() => {
      throw new Error('supabaseUrl is required');
    });
    await expect(readPlatformSecurityAlerts()).resolves.toBe(SECURITY_ALERTS_FAILED);
  });
});
