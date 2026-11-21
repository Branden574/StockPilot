// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext } from '@/test/supabase-mock';

/**
 * Part 3 (sign-in alerts): the reads and the "This was me" answer
 * (server/services/sign-in-alerts.ts).
 *   - The organization's list: the step-up first, then owners and admins only
 *     (the Blocked activity order), then sign_in_alerts_for_organization
 *     through the member's own client with the context's organization. It
 *     names the device family, never the member's own label.
 *   - The member's own alerts: my_sign_in_alerts() through the member's own
 *     client; an unreadable answer is null, not an empty list.
 *   - "This was me": refused while the session owes the authenticator step,
 *     then one update of the member's own OPEN alert that sets the answer and
 *     its resolved_at together.
 */

const h = vi.hoisted(() => ({
  report: vi.fn(async (..._a: unknown[]) => undefined),
  updates: [] as Array<{ patch: Record<string, unknown>; filters: Array<[string, string, unknown]> }>,
  updateAnswer: { data: [{ id: 'x' }] as unknown, error: null as unknown },
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'sign_in_alerts') throw new Error(`unexpected table ${table}`);
      const filters: Array<[string, string, unknown]> = [];
      let patch: Record<string, unknown> = {};
      const b: Record<string, unknown> = {
        update: (p: Record<string, unknown>) => {
          patch = p;
          return b;
        },
        eq: (c: string, v: unknown) => {
          filters.push(['eq', c, v]);
          return b;
        },
        select: () => b,
        then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
          h.updates.push({ patch, filters });
          return Promise.resolve(h.updateAnswer).then(ok, bad);
        },
      };
      return b;
    },
  }),
}));

import { ServiceError } from './context';
import { SIGN_IN_ALERTS_ROW_LIMIT, SignInAlertsService } from './sign-in-alerts';

const ORG = '0f1e2d3c-4b5a-4968-8776-655443322110';
const ME = '11111111-1111-4111-8111-111111111111';
const ALERT = 'a1e27000-0000-4000-8000-000000000001';

const ORG_ROW = {
  id: ALERT,
  user_id: ME,
  full_name: 'Avery Example',
  email: 'member@example.test',
  new_device: true,
  new_country: true,
  client: 'web',
  device_family: 'Chrome on macOS',
  country: 'MX',
  city: 'Tijuana',
  status: 'open',
  resolved_at: null,
  created_at: '2026-11-20T15:30:00+00:00',
};

const MY_ROW = {
  id: ALERT,
  session_id: '5e551011-0000-4000-8000-0000000000c1',
  new_device: false,
  new_country: true,
  client: 'phone',
  device_label: 'StockPilot app on iPhone',
  country: 'MX',
  city: null,
  status: 'open',
  created_at: '2026-11-20T15:30:00+00:00',
};

function client(answer: { data: unknown; error: unknown }) {
  return { rpc: vi.fn(async (_fn: string, _args?: unknown) => answer) };
}

function service(
  supabase: ReturnType<typeof client>,
  over: Parameters<typeof makeServiceContext>[1] = {},
) {
  return new SignInAlertsService(
    makeServiceContext(supabase, { organizationId: ORG, userId: ME, role: 'admin', ...over }) as never,
  );
}

beforeEach(() => {
  h.updates = [];
  h.updateAnswer = { data: [{ id: ALERT }], error: null };
});

describe('forOrganization', () => {
  it.each(['manager', 'staff', 'viewer'] as const)('a %s is refused before any read', async (role) => {
    const db = client({ data: [ORG_ROW], error: null });
    await expect(service(db, { role }).forOrganization()).rejects.toMatchObject({
      name: 'ServiceError',
      code: 'forbidden',
    });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('an admin who owes the authenticator step is refused before the role is even looked at', async () => {
    const db = client({ data: [ORG_ROW], error: null });
    await expect(
      service(db, { role: 'staff', mfaRequired: true, mfaSatisfied: false }).forOrganization(),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'mfa_required' } });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('a %s reads the context organization’s list, newest 100', async (role) => {
    const db = client({ data: [ORG_ROW], error: null });
    const rows = await service(db, { role }).forOrganization();
    expect(db.rpc).toHaveBeenCalledWith('sign_in_alerts_for_organization', {
      p_organization_id: ORG,
      p_limit: SIGN_IN_ALERTS_ROW_LIMIT,
    });
    expect(SIGN_IN_ALERTS_ROW_LIMIT).toBe(100);
    expect(rows).toEqual([
      {
        id: ALERT,
        userId: ME,
        fullName: 'Avery Example',
        email: 'member@example.test',
        newDevice: true,
        newCountry: true,
        client: 'web',
        deviceFamily: 'Chrome on macOS',
        country: 'MX',
        city: 'Tijuana',
        status: 'open',
        resolvedAt: null,
        createdAt: '2026-11-20T15:30:00+00:00',
      },
    ]);
  });

  it('a 42501 from the database is forbidden, not reported', async () => {
    const db = client({ data: null, error: { code: '42501', hint: 'aal2_required' } });
    await expect(service(db).forOrganization()).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('any other error is reported by its code and answered as an internal error', async () => {
    const db = client({ data: null, error: { code: '57014', message: 'canceling statement for member@example.test' } });
    await expect(service(db).forOrganization()).rejects.toMatchObject({ code: 'internal_error' });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.report.mock.calls)).not.toContain('example.test');
  });

  it('an answer that is not a list is a failed read, reported, never an empty list', async () => {
    const db = client({ data: {}, error: null });
    await expect(service(db).forOrganization()).rejects.toMatchObject({ code: 'internal_error' });
    expect(h.report).toHaveBeenCalledTimes(1);
  });

  it('a row out of shape is left out', async () => {
    const db = client({ data: [ORG_ROW, { id: null }], error: null });
    expect(await service(db).forOrganization()).toHaveLength(1);
  });
});

describe('mine', () => {
  it('reads my_sign_in_alerts with no arguments, for any role', async () => {
    const db = client({ data: [MY_ROW], error: null });
    const rows = await service(db, { role: 'staff' }).mine();
    expect(db.rpc).toHaveBeenCalledWith('my_sign_in_alerts');
    expect(rows).toEqual([
      {
        id: ALERT,
        sessionId: '5e551011-0000-4000-8000-0000000000c1',
        newDevice: false,
        newCountry: true,
        client: 'phone',
        deviceLabel: 'StockPilot app on iPhone',
        country: 'MX',
        city: null,
        status: 'open',
        createdAt: '2026-11-20T15:30:00+00:00',
      },
    ]);
  });

  it('an answer that cannot be read is null; only an error other than 42501 is reported', async () => {
    expect(await service(client({ data: null, error: { code: '42501' } })).mine()).toBeNull();
    expect(h.report).not.toHaveBeenCalled();
    expect(await service(client({ data: null, error: { code: '57014' } })).mine()).toBeNull();
    expect(h.report).toHaveBeenCalledTimes(1);
  });
});

describe('confirm ("This was me")', () => {
  it('sets was_me and resolved_at together, only on the member’s own open alert', async () => {
    const answer = await service(client({ data: null, error: null }), { role: 'staff' }).confirm(ALERT);
    expect(answer).toBe('confirmed');
    expect(h.updates).toEqual([
      {
        patch: { status: 'was_me', resolved_at: expect.any(String) },
        filters: [
          ['eq', 'id', ALERT],
          ['eq', 'user_id', ME],
          ['eq', 'status', 'open'],
        ],
      },
    ]);
  });

  it('an alert already answered, or not the member’s, changes nothing: the same unchanged answer', async () => {
    h.updateAnswer = { data: [], error: null };
    expect(await service(client({ data: null, error: null })).confirm(ALERT)).toBe('unchanged');
  });

  it('refused while the session owes the authenticator step, before any write', async () => {
    await expect(
      service(client({ data: null, error: null }), { mfaRequired: true, mfaSatisfied: false }).confirm(ALERT),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(h.updates).toEqual([]);
  });

  it('an id that is not a uuid is not found, with no write', async () => {
    await expect(service(client({ data: null, error: null })).confirm('nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(h.updates).toEqual([]);
  });

  it('a failed update is reported by its code and answered as an internal error', async () => {
    h.updateAnswer = { data: null, error: { code: '57014' } };
    await expect(service(client({ data: null, error: null })).confirm(ALERT)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(h.report).toHaveBeenCalledTimes(1);
  });
});
