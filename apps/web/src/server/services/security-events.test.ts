import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationRowUnavailableError } from '@/lib/auth/organization-row-unavailable';
import { makeServiceContext } from '@/test/supabase-mock';

/**
 * Blocked activity's reads (server/services/security-events.ts): the MFA
 * step-up first, then owners and admins only, then the two gated database
 * functions through the member's own client, with the context's organization
 * and nothing else. A 42501 from them is the same forbidden answer; any other
 * error is reported by its code and answered as an internal error.
 */

const h = vi.hoisted(() => ({
  report: vi.fn(async () => undefined),
  gate: vi.fn(),
  realGate: null as null | ((...args: never[]) => unknown),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('./context', async (importOriginal) => {
  const real = await importOriginal<typeof import('./context')>();
  h.realGate = real.mfaGateError as never;
  return { ...real, mfaGateError: (...args: Parameters<typeof real.mfaGateError>) => h.gate(...args) };
});

import { mfaGateError, ServiceError } from './context';
import { SECURITY_ACTIVITY_ROW_LIMIT, SecurityEventsService } from './security-events';

const ORG = '0f1e2d3c-4b5a-4968-8776-655443322110';

const ROW = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  minute: '2026-11-20T10:15:00+00:00',
  category: 'password_guessing',
  outcome: 'blocked',
  reason: 'wrong_password',
  source: 'web',
  country: 'NL',
  city: 'Utrecht',
  event_count: 3,
  last_seen_at: '2026-11-20T10:15:42.120+00:00',
};

function client(
  rows: { data: unknown; error: unknown } = { data: [ROW], error: null },
  totals: { data: unknown; error: unknown } = {
    data: [{ category: 'password_guessing', outcome: 'blocked', reason: 'wrong_password', source: 'web', country: 'NL', events: 3 }],
    error: null,
  },
) {
  const rpc = vi.fn(async (fn: string) =>
    fn === 'security_events_for_organization' ? rows : fn === 'security_event_totals_for_organization' ? totals : { data: null, error: { code: 'XX000' } },
  );
  return { rpc };
}

function service(
  supabase: ReturnType<typeof client>,
  over: Parameters<typeof makeServiceContext>[1] = {},
) {
  return new SecurityEventsService(
    makeServiceContext(supabase, { organizationId: ORG, role: 'admin', ...over }) as never,
  );
}

beforeEach(() => {
  // src/test/setup.ts resets every mock between tests: the real gate again.
  h.gate.mockImplementation(h.realGate!);
});

describe('the gate', () => {
  it.each(['manager', 'staff', 'viewer'] as const)('a %s is refused before any read', async (role) => {
    const db = client();
    await expect(service(db, { role }).activity()).rejects.toMatchObject({
      name: 'ServiceError',
      code: 'forbidden',
    });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('an %s reads, with the context’s organization only', async (role) => {
    const db = client();
    await service(db, { role }).activity();
    expect(db.rpc.mock.calls).toEqual([
      ['security_events_for_organization', { p_organization_id: ORG, p_limit: 100 }],
      ['security_event_totals_for_organization', { p_organization_id: ORG, p_from: null, p_to: null }],
    ]);
  });

  it('the MFA step-up comes first, even for an owner, and before the role', async () => {
    const db = client();
    await expect(
      service(db, { role: 'owner', mfaRequired: true, mfaSatisfied: false }).activity(),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'mfa_required' } });
    // A staff member who owes the step-up gets the step-up answer, not the role's.
    await expect(
      service(db, { role: 'staff', mfaRequired: true, mfaSatisfied: false }).activity(),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'mfa_required' } });
    expect(h.gate).toHaveBeenCalledTimes(2);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('a policy that could not be read reaches the page as "couldn’t check your access", before any read', async () => {
    h.gate.mockImplementationOnce(() => {
      throw new OrganizationRowUnavailableError();
    });
    const db = client();
    await expect(
      service(db, { mfaRequired: true, mfaSatisfied: false }).activity(),
    ).rejects.toBeInstanceOf(OrganizationRowUnavailableError);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('an admin whose session is stepped up is not stopped by the gate', async () => {
    const db = client();
    await service(db, { mfaRequired: true, mfaSatisfied: true }).activity();
    expect(h.gate).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledTimes(2);
  });

  it('the gate is the real one (mfaGateError of services/context)', () => {
    expect(mfaGateError({ mfaEnrolled: true })).toMatchObject({ details: { reason: 'aal2_required' } });
  });
});

describe('the database’s answers', () => {
  it('a 42501 from either function is the same forbidden answer, never reported', async () => {
    const refused = { data: null, error: { code: '42501', message: 'security_events_not_allowed' } };
    for (const db of [client(refused), client(undefined, refused), client(refused, { data: null, error: { code: '57014' } })]) {
      const e = await service(db).activity().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ServiceError);
      expect(e).toMatchObject({ code: 'forbidden', message: 'Only owners and admins can see blocked activity.' });
    }
    expect(h.report).not.toHaveBeenCalled();
  });

  it.each(['mfa_required', 'aal2_required'])(
    'a 42501 with the database’s own authenticator answer (hint %s) is the same forbidden answer, never reported',
    async (hint) => {
      const refused = { data: null, error: { code: '42501', message: hint, hint } };
      for (const db of [client(refused), client(undefined, refused), client(refused, refused)]) {
        const e = await service(db).activity().catch((x: unknown) => x);
        expect(e).toBeInstanceOf(ServiceError);
        expect(e).toMatchObject({ code: 'forbidden', message: 'Only owners and admins can see blocked activity.' });
      }
      expect(h.report).not.toHaveBeenCalled();
    },
  );

  it('totals that time out (57014) leave the totals out and keep the rows, reported once', async () => {
    const db = client(undefined, { data: null, error: { code: '57014', message: `canceling statement for ${ORG}` } });
    const activity = await service(db).activity();
    expect(activity.totals).toBeNull();
    expect(activity.rows.map((r) => r.id)).toEqual([ROW.id]);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'security-events.read',
      organizationId: ORG,
      extra: { code: '57014' },
    });
    expect((h.report.mock.calls[0] as unknown as [Error])[0].message).not.toContain('canceling');
  });

  it('any other totals error is still an internal error, reported', async () => {
    const db = client(undefined, { data: null, error: { code: 'XX000', message: 'internal' } });
    await expect(service(db).activity()).rejects.toMatchObject({ code: 'internal_error' });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'security-events.read',
      organizationId: ORG,
      extra: { code: 'XX000' },
    });
  });

  it('any other error is reported by its code only and answered as an internal error', async () => {
    const db = client({ data: null, error: { code: '57014', message: `timeout for ${ORG}` } });
    const e = (await service(db).activity().catch((x: unknown) => x)) as ServiceError;
    expect(e).toMatchObject({ code: 'internal_error', message: 'An internal error occurred. Please try again.' });
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'security-events.read',
      organizationId: ORG,
      extra: { code: '57014' },
    });
    expect((h.report.mock.calls[0] as unknown as [Error])[0].message).not.toContain('timeout');
  });

  it('rows come back newest first as the function gives them, with counts as numbers', async () => {
    const overCap = { ...ROW, id: 'a1b2c3d4-0000-4000-8000-000000000002', reason: 'over_minute_cap', country: null, city: null, event_count: '41' };
    const db = client({ data: [ROW, overCap, { id: 'broken' }], error: null });
    const { rows } = await service(db).activity();
    expect(rows).toEqual([
      {
        id: ROW.id,
        minute: ROW.minute,
        lastSeenAt: ROW.last_seen_at,
        category: 'password_guessing',
        outcome: 'blocked',
        reason: 'wrong_password',
        source: 'web',
        country: 'NL',
        city: 'Utrecht',
        count: 3,
      },
      expect.objectContaining({ reason: 'over_minute_cap', country: null, city: null, count: 41 }),
    ]);
  });

  it('totals are summed per category, in the core order, and a category with none is left out', async () => {
    const db = client(undefined, {
      data: [
        { category: 'password_guessing', outcome: 'blocked', reason: 'wrong_password', source: 'web', country: 'NL', events: 7 },
        { category: 'exploit', outcome: 'blocked', reason: 'env_file', source: 'web', country: null, events: '2' },
        { category: 'password_guessing', outcome: 'blocked', reason: 'wrong_code', source: 'web', country: 'US', events: 5 },
        { category: 'password_guessing', outcome: 'blocked', reason: 'over_minute_cap', source: 'web', country: null, events: 30 },
        { category: 'bots', outcome: 'blocked', reason: 'support_paused', source: 'web', country: null, events: 0 },
        { category: 'not_a_category', outcome: 'blocked', reason: 'x', source: 'web', country: null, events: 9 },
      ],
      error: null,
    });
    expect((await service(db).activity()).totals).toEqual([
      { category: 'password_guessing', events: 42 },
      { category: 'exploit', events: 2 },
    ]);
  });

  // Part 6: a file the upload checks refused is recorded in the organization,
  // and its owners and admins see it here like any other row, never hidden.
  it('a refused file is listed like any other row, and counted in the totals', async () => {
    const upload = { ...ROW, id: 'a1b2c3d4-0000-4000-8000-000000000003', category: 'malware', reason: 'upload_hidden_file', country: null, city: null, event_count: 1 };
    const db = client(
      { data: [upload, ROW], error: null },
      {
        data: [
          { category: 'malware', outcome: 'blocked', reason: 'upload_wrong_type', source: 'web', country: null, events: 4 },
          { category: 'password_guessing', outcome: 'blocked', reason: 'wrong_password', source: 'web', country: 'NL', events: 3 },
        ],
        error: null,
      },
    );
    const { rows, totals } = await service(db).activity();
    expect(rows.map((r) => [r.category, r.reason])).toEqual([
      ['malware', 'upload_hidden_file'],
      ['password_guessing', 'wrong_password'],
    ]);
    expect(totals).toEqual([
      { category: 'password_guessing', events: 3 },
      { category: 'malware', events: 4 },
    ]);
  });

  it('the row limit is of the rows shown: every kind counts toward it, none is dropped after it', async () => {
    const many = Array.from({ length: SECURITY_ACTIVITY_ROW_LIMIT + 20 }, (_, i) => ({
      ...ROW,
      id: `a1b2c3d4-0000-4000-8000-${String(i).padStart(12, '0')}`,
      category: i % 2 === 0 ? 'malware' : 'password_guessing',
      reason: i % 2 === 0 ? 'upload_wrong_type' : 'wrong_password',
    }));
    const db = client({ data: many, error: null });
    const { rows } = await service(db).activity();
    expect(rows).toHaveLength(SECURITY_ACTIVITY_ROW_LIMIT);
    expect(rows.map((r) => r.id)).toEqual(many.slice(0, SECURITY_ACTIVITY_ROW_LIMIT).map((r) => r.id));
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(['malware', 'password_guessing']));
    // The function is asked for exactly the rows the page shows.
    expect(db.rpc).toHaveBeenCalledWith('security_events_for_organization', {
      p_organization_id: ORG,
      p_limit: SECURITY_ACTIVITY_ROW_LIMIT,
    });
  });

  it('no row carries a file name, a path or anything else the function might add', async () => {
    const upload = {
      ...ROW,
      category: 'malware',
      reason: 'upload_active_content',
      file_name: 'invoice-of-a-secret-school.pdf',
      storage_path: 'org/po-imports/x.pdf',
      detail: 'pdf_javascript',
    };
    const { rows } = await service(client({ data: [upload], error: null })).activity();
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['category', 'city', 'count', 'country', 'id', 'lastSeenAt', 'minute', 'outcome', 'reason', 'source'].sort(),
    );
    expect(JSON.stringify(rows)).not.toMatch(/secret-school|po-imports|pdf_javascript/);
  });

  it('nothing recorded: no totals and no rows', async () => {
    const db = client({ data: [], error: null }, { data: [], error: null });
    expect(await service(db).activity()).toEqual({ totals: [], rows: [] });
  });
});
