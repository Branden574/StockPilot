// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Part 3 (sign-in alerts): the member's "This was not me". One function, used
 * by the emailed link's page and by the signed-in action:
 *   1. the alert is marked not_me, with its resolved_at, in one update that
 *      only changes an alert not already not_me;
 *   2. every session of the account is ended, whether or not (1) changed a
 *      row, so a retry after a half-finished report still signs out;
 *   3. the device row is forgotten (by its hash) only for a new-device alert,
 *      the country row only for a new-country alert, so the next sign-in from
 *      either alerts again;
 *   4. on the first report only: the member is emailed, the owners and admins
 *      of each organization the member belongs to (accepted, not a support
 *      act-as seat, at most 5) get an email and an in-app notice naming the
 *      device FAMILY, one audit row per organization, one security event.
 *      Managers and staff are never told; nor is the member twice.
 * Steps 1 and 2 decide the answer. Everything else is best effort.
 *
 * The admin client is an in-memory model of the tables. Every id, name and
 * address is made up; mail is a mock.
 */

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  calls: [] as Array<{ table: string; op: string; filters: Filter[]; patch?: Row; limit?: number }>,
  failures: {} as Record<string, Partial<Record<'select' | 'update' | 'delete', { code: string; message: string }>>>,
  revoke: vi.fn(async (_userId: string) => ({ ok: true, sessionIds: ['s1', 's2'] })),
  memberEmail: vi.fn(async (_a: Record<string, unknown>) => ({ ok: true, id: 'dryrun' })),
  adminEmail: vi.fn(async (_a: Record<string, unknown>) => ({ ok: true, id: 'dryrun' })),
  notify: vi.fn(async (_a: Record<string, unknown>) => 'n1' as string | null),
  audit: vi.fn(async (_row: Record<string, unknown>) => true),
  event: vi.fn(async (_a: Record<string, unknown>) => undefined),
  reportError: vi.fn(async (..._a: unknown[]) => undefined),
}));

function builder(table: string) {
  const state = {
    op: 'select' as 'select' | 'update' | 'delete',
    filters: [] as Filter[],
    tests: [] as Array<(r: Row) => boolean>,
    patch: undefined as Row | undefined,
    limit: undefined as number | undefined,
    offset: 0,
    returning: false,
    orderBy: null as null | { column: string; ascending: boolean },
  };
  const run = () => {
    h.calls.push({ table, op: state.op, filters: state.filters, patch: state.patch, limit: state.limit });
    const failure = h.failures[table]?.[state.op];
    if (failure) return { data: null, error: failure };
    const rows = (h.tables[table] ??= []);
    const matched = rows.filter((r) => state.tests.every((t) => t(r)));
    if (state.op === 'update') {
      for (const r of matched) Object.assign(r, state.patch);
      return { data: state.returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
    }
    if (state.op === 'delete') {
      h.tables[table] = rows.filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    let out = matched.map((r) => ({ ...r }));
    if (state.orderBy) {
      const { column, ascending } = state.orderBy;
      out.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
    }
    if (state.limit !== undefined) out = out.slice(state.offset, state.limit);
    return { data: out, error: null };
  };
  const b: Record<string, unknown> = {
    select: () => {
      if (state.op !== 'select') state.returning = true;
      return b;
    },
    update: (patch: Row) => {
      state.op = 'update';
      state.patch = patch;
      return b;
    },
    delete: () => {
      state.op = 'delete';
      return b;
    },
    eq: (c: string, v: unknown) => {
      state.filters.push(['eq', c, v]);
      state.tests.push((r) => r[c] === v);
      return b;
    },
    neq: (c: string, v: unknown) => {
      state.filters.push(['neq', c, v]);
      state.tests.push((r) => r[c] !== v);
      return b;
    },
    in: (c: string, vs: unknown[]) => {
      state.filters.push(['in', c, vs]);
      state.tests.push((r) => vs.includes(r[c]));
      return b;
    },
    not: (c: string, _op: string, _v: null) => {
      state.filters.push(['not.is', c, null]);
      state.tests.push((r) => r[c] !== null && r[c] !== undefined);
      return b;
    },
    is: (c: string, _v: null) => {
      state.filters.push(['is', c, null]);
      state.tests.push((r) => r[c] === null || r[c] === undefined);
      return b;
    },
    order: (column: string, opts?: { ascending?: boolean }) => {
      state.orderBy = { column, ascending: opts?.ascending !== false };
      return b;
    },
    limit: (n: number) => {
      state.limit = n;
      return b;
    },
    range: (from: number, to: number) => {
      state.limit = to + 1;
      state.offset = from;
      return b;
    },
    then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve().then(run).then(ok, bad),
  };
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: builder }) }));
vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: (userId: string) => h.revoke(userId),
}));
vi.mock('@/lib/email/login-alert', () => ({
  SIGN_IN_ALERTS_LIST_PATH: '/dashboard/settings/security/sign-ins',
  sendSignedOutEverywhereEmail: (a: Record<string, unknown>) => h.memberEmail(a),
  sendSignInReportedEmail: (a: Record<string, unknown>) => h.adminEmail(a),
}));
vi.mock('@/server/services/notifications', () => ({
  createNotification: (a: Record<string, unknown>) => h.notify(a),
}));
vi.mock('@/server/services/audit', () => ({
  insertAuditRowReported: (row: Record<string, unknown>) => h.audit(row),
}));
vi.mock('@/server/security/sign-in-alert-events', () => ({
  recordSignInAlertEvent: (a: Record<string, unknown>) => h.event(a),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));

import { readSignInAlert, reportSignInAlertNotMe, type SignInAlertRecord } from './sign-in-alert-report';

const MEMBER = '11111111-1111-4111-8111-111111111111';
const OWNER_A = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = '33333333-3333-4333-8333-333333333333';
const MANAGER_A = '44444444-4444-4444-8444-444444444444';
const STAFF_A = '55555555-5555-4555-8555-555555555555';
const ACT_AS_A = '66666666-6666-4666-8666-666666666666';
const INVITED_A = '77777777-7777-4777-8777-777777777777';
const ADMIN_B = '88888888-8888-4888-8888-888888888888';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALERT = 'a1e27000-0000-4000-8000-000000000001';
const HASH = 'ab'.repeat(20);
const AUDIT_FROM = { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15' };

function member(user_id: string, organization_id: string, role: string, extra: Row = {}): Row {
  return {
    user_id,
    organization_id,
    role,
    accepted_at: '2026-01-01T00:00:00Z',
    impersonation_expires_at: null,
    ...extra,
  };
}

function profile(id: string, full_name: string | null, email: string, disabled_at: string | null = null): Row {
  return { id, full_name, email, disabled_at };
}

function alertRow(extra: Row = {}): Row {
  return {
    id: ALERT,
    user_id: MEMBER,
    session_id: null,
    new_device: true,
    new_country: false,
    client: 'web',
    device_label: 'Avery work laptop',
    device_family: 'Chrome on macOS',
    device_hash: HASH,
    country: 'MX',
    city: 'Tijuana',
    status: 'open',
    resolved_at: null,
    created_at: '2026-11-20T15:30:00.000Z',
    ...extra,
  };
}

function seed(alert: Row = alertRow()) {
  h.tables = {
    sign_in_alerts: [alert],
    user_login_devices: [
      { user_id: MEMBER, device_hash: HASH },
      { user_id: MEMBER, device_hash: 'cd'.repeat(20) },
    ],
    user_sign_in_countries: [
      { user_id: MEMBER, country: 'US' },
      { user_id: MEMBER, country: 'MX' },
    ],
    organization_members: [
      member(MEMBER, ORG_A, 'staff'),
      member(OWNER_A, ORG_A, 'owner'),
      member(ADMIN_A, ORG_A, 'admin'),
      member(MANAGER_A, ORG_A, 'manager'),
      member(STAFF_A, ORG_A, 'staff'),
      member(ACT_AS_A, ORG_A, 'owner', { impersonation_expires_at: '2026-11-20T16:00:00Z' }),
      member(INVITED_A, ORG_A, 'admin', { accepted_at: null }),
    ],
    user_profiles: [
      profile(MEMBER, 'Avery Example', 'member@example.test'),
      profile(OWNER_A, 'Jordan Owner', 'owner@example.test'),
      profile(ADMIN_A, 'Casey Admin', 'admin@example.test'),
      profile(MANAGER_A, 'Riley Manager', 'manager@example.test'),
      profile(STAFF_A, 'Sam Staff', 'staff@example.test'),
      profile(ACT_AS_A, 'Support Person', 'support@example.test'),
      profile(INVITED_A, 'Invited Admin', 'invited@example.test'),
      profile(ADMIN_B, 'Morgan Admin', 'adminb@example.test'),
    ],
    organizations: [
      { id: ORG_A, name: 'Example School' },
      { id: ORG_B, name: 'Example Warehouse' },
    ],
  };
}

async function readAlert(): Promise<SignInAlertRecord> {
  const read = await readSignInAlert(ALERT);
  if (read.kind !== 'found') throw new Error(`alert not found: ${read.kind}`);
  return read.alert;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.failures = {};
  h.revoke.mockResolvedValue({ ok: true, sessionIds: ['s1', 's2'] });
  h.memberEmail.mockResolvedValue({ ok: true, id: 'dryrun' });
  h.adminEmail.mockResolvedValue({ ok: true, id: 'dryrun' });
  seed();
});

describe('readSignInAlert', () => {
  it('reads one alert by id with the service role, every column the report needs', async () => {
    const read = await readSignInAlert(ALERT);
    expect(read).toEqual({
      kind: 'found',
      alert: {
        id: ALERT,
        userId: MEMBER,
        sessionId: null,
        newDevice: true,
        newCountry: false,
        client: 'web',
        deviceLabel: 'Avery work laptop',
        deviceFamily: 'Chrome on macOS',
        deviceHash: HASH,
        country: 'MX',
        city: 'Tijuana',
        status: 'open',
        createdAt: '2026-11-20T15:30:00.000Z',
      },
    });
  });

  it('an id that is not a uuid is missing, with no read', async () => {
    expect(await readSignInAlert('not-a-uuid')).toEqual({ kind: 'missing' });
    expect(h.calls).toEqual([]);
  });

  it('no such alert is missing; a failed read is failed', async () => {
    h.tables.sign_in_alerts = [];
    expect(await readSignInAlert(ALERT)).toEqual({ kind: 'missing' });
    h.failures.sign_in_alerts = { select: { code: '57014', message: 'timeout' } };
    expect(await readSignInAlert(ALERT)).toEqual({ kind: 'failed' });
  });
});

describe('reportSignInAlertNotMe: the first report', () => {
  it('marks the alert not_me with its resolved_at in one conditional update, then signs out every session', async () => {
    const answer = await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(answer).toEqual({ outcome: 'done', firstReport: true });

    const update = h.calls.find((c) => c.table === 'sign_in_alerts' && c.op === 'update')!;
    expect(update.patch).toEqual({ status: 'not_me', resolved_at: expect.any(String) });
    expect(update.filters).toEqual([
      ['eq', 'id', ALERT],
      ['eq', 'user_id', MEMBER],
      ['neq', 'status', 'not_me'],
    ]);
    expect(h.tables.sign_in_alerts![0]).toMatchObject({ status: 'not_me' });
    expect(h.tables.sign_in_alerts![0]!.resolved_at).not.toBeNull();
    expect(h.revoke).toHaveBeenCalledWith(MEMBER);
  });

  it('a new-device alert forgets that device row only; the country rows stay', async () => {
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(h.tables.user_login_devices).toEqual([{ user_id: MEMBER, device_hash: 'cd'.repeat(20) }]);
    expect(h.tables.user_sign_in_countries).toHaveLength(2);
  });

  it('a new-country alert forgets that country row only; the device rows stay', async () => {
    seed(alertRow({ new_device: false, new_country: true }));
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(h.tables.user_sign_in_countries).toEqual([{ user_id: MEMBER, country: 'US' }]);
    expect(h.tables.user_login_devices).toHaveLength(2);
  });

  it('both flags: both rows are forgotten', async () => {
    seed(alertRow({ new_device: true, new_country: true }));
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'signed_in', auditFrom: AUDIT_FROM });
    expect(h.tables.user_login_devices).toHaveLength(1);
    expect(h.tables.user_sign_in_countries).toEqual([{ user_id: MEMBER, country: 'US' }]);
  });

  it('the member is emailed once, with their own device words, the place and the sign-in time', async () => {
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.memberEmail.mock.calls[0]![0]).toEqual({
      to: 'member@example.test',
      firstName: 'Avery',
      device: 'Avery work laptop',
      place: { country: 'MX', city: 'Tijuana' },
      signedInAt: new Date('2026-11-20T15:30:00.000Z'),
    });
  });

  it('owners and admins are told by email and in the app, naming the device family; managers, staff, act-as seats and invitations are not', async () => {
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    const emailed = h.adminEmail.mock.calls.map((c) => c[0].to).sort();
    expect(emailed).toEqual(['admin@example.test', 'owner@example.test']);
    for (const [args] of h.adminEmail.mock.calls) {
      expect(args).toMatchObject({
        memberName: 'Avery Example',
        memberEmail: 'member@example.test',
        organizationName: 'Example School',
        deviceFamily: 'Chrome on macOS',
        place: { country: 'MX', city: 'Tijuana' },
      });
      expect(JSON.stringify(args)).not.toContain('Avery work laptop');
    }
    const noticed = h.notify.mock.calls.map((c) => c[0].userId).sort();
    expect(noticed).toEqual([OWNER_A, ADMIN_A].sort());
    expect(h.notify.mock.calls[0]![0]).toMatchObject({
      organizationId: ORG_A,
      type: 'security.sign_in_reported',
      title: 'Avery Example reported a sign-in they did not make',
      link: '/dashboard/settings/security/sign-ins',
      metadata: { alert_id: ALERT, member_id: MEMBER },
    });
    expect(String(h.notify.mock.calls[0]![0].body)).toContain('Chrome on macOS');
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain('Avery work laptop');
  });

  it('the members of the organizations are read on the server: accepted, not act-as, owners and admins only', async () => {
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    const reads = h.calls.filter((c) => c.table === 'organization_members');
    expect(reads[0]!.filters).toEqual([
      ['eq', 'user_id', MEMBER],
      ['not.is', 'accepted_at', null],
      ['is', 'impersonation_expires_at', null],
    ]);
    expect(reads[0]!.limit).toBe(5);
    expect(reads[1]!.filters).toEqual([
      ['in', 'organization_id', [ORG_A]],
      ['in', 'role', ['owner', 'admin']],
      ['not.is', 'accepted_at', null],
      ['is', 'impersonation_expires_at', null],
    ]);
  });

  it('a member who is an admin is not told as an admin: only their own email', async () => {
    h.tables.organization_members![0] = member(MEMBER, ORG_A, 'admin');
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.adminEmail.mock.calls.map((c) => c[0].to)).not.toContain('member@example.test');
    expect(h.notify.mock.calls.map((c) => c[0].userId)).not.toContain(MEMBER);
  });

  it('an admin of two of the organizations gets one email and a notice in each', async () => {
    h.tables.organization_members!.push(member(MEMBER, ORG_B, 'staff'), member(ADMIN_A, ORG_B, 'admin'));
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(h.adminEmail.mock.calls.filter((c) => c[0].to === 'admin@example.test')).toHaveLength(1);
    const notices = h.notify.mock.calls.filter((c) => c[0].userId === ADMIN_A).map((c) => c[0].organizationId);
    expect(notices.sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it('a disabled admin gets no email', async () => {
    h.tables.user_profiles = h.tables.user_profiles!.map((p) =>
      p.id === ADMIN_A ? { ...p, disabled_at: '2026-11-01T00:00:00Z' } : p,
    );
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(h.adminEmail.mock.calls.map((c) => c[0].to)).toEqual(['owner@example.test']);
  });

  it('one audit row per organization, as the member, with the request it came from', async () => {
    h.tables.organization_members!.push(member(MEMBER, ORG_B, 'staff'), member(ADMIN_B, ORG_B, 'admin'));
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls.map((c) => c[0].organization_id).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(h.audit.mock.calls[0]![0]).toEqual({
      organization_id: expect.any(String),
      user_id: MEMBER,
      event: 'security.sign_in_reported',
      ip: '203.0.113.9',
      user_agent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15',
      metadata: {
        entity_type: 'sign_in_alert',
        entity_id: ALERT,
        new_device: true,
        new_country: false,
        client: 'web',
        via: 'link',
        signed_out: true,
      },
    });
  });

  it('one security event, with the sign-in’s place and client', async () => {
    seed(alertRow({ client: 'phone' }));
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(h.event).toHaveBeenCalledTimes(1);
    expect(h.event.mock.calls[0]![0]).toEqual({
      reason: 'sign_in_not_me',
      userId: MEMBER,
      source: 'phone',
      place: { country: 'MX', city: 'Tijuana' },
    });
  });

  it('at most 5 organizations are read', async () => {
    for (let i = 0; i < 7; i++) {
      h.tables.organization_members!.push(member(MEMBER, `0000000${i}-0000-4000-8000-000000000000`, 'staff'));
    }
    await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    const ids = h.calls.find((c) => c.table === 'organization_members' && c.filters[0]![0] === 'in')!
      .filters[0]![2] as string[];
    expect(ids.length).toBeLessThanOrEqual(5);
  });

  it('a member in no organization: the member is told, one audit row with no organization, nobody else', async () => {
    h.tables.organization_members = [];
    const answer = await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(answer).toEqual({ outcome: 'done', firstReport: true });
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.adminEmail).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ organization_id: null });
  });
});

describe('reportSignInAlertNotMe: again, and half-finished', () => {
  it('a second report of the same alert signs out again and tells nobody again', async () => {
    const alert = await readAlert();
    await reportSignInAlertNotMe({ alert, via: 'link', auditFrom: AUDIT_FROM });
    vi.clearAllMocks();
    const again = await reportSignInAlertNotMe({ alert, via: 'link', auditFrom: AUDIT_FROM });
    expect(again).toEqual({ outcome: 'done', firstReport: false });
    expect(h.revoke).toHaveBeenCalledWith(MEMBER);
    expect(h.memberEmail).not.toHaveBeenCalled();
    expect(h.adminEmail).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.event).not.toHaveBeenCalled();
  });

  it('a retry after a report that stopped before the sign-out still signs out', async () => {
    // The alert is already not_me: the first try marked it and stopped there.
    seed(alertRow({ status: 'not_me', resolved_at: '2026-11-20T15:40:00Z' }));
    const answer = await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(answer).toEqual({ outcome: 'done', firstReport: false });
    expect(h.revoke).toHaveBeenCalledWith(MEMBER);
    // And the rows the first try did not reach are forgotten now.
    expect(h.tables.user_login_devices).toHaveLength(1);
  });

  it('"this was me" earlier does not stop a later "not me"', async () => {
    seed(alertRow({ status: 'was_me', resolved_at: '2026-11-20T15:35:00Z' }));
    const answer = await reportSignInAlertNotMe({ alert: await readAlert(), via: 'signed_in', auditFrom: AUDIT_FROM });
    expect(answer).toEqual({ outcome: 'done', firstReport: true });
    expect(h.tables.sign_in_alerts![0]).toMatchObject({ status: 'not_me' });
  });

  it('a sign-out that fails: the answer says so, the owners are still told, and the member is not told they were signed out', async () => {
    h.revoke.mockResolvedValue({ ok: false, sessionIds: [] });
    const answer = await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(answer).toEqual({ outcome: 'failed' });
    expect(h.memberEmail).not.toHaveBeenCalled();
    expect(h.adminEmail).toHaveBeenCalled();
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ metadata: { signed_out: false } });
    // The retry signs out; the report is not sent again.
    h.revoke.mockResolvedValue({ ok: true, sessionIds: ['s1'] });
    vi.clearAllMocks();
    const retry = await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(retry).toEqual({ outcome: 'done', firstReport: false });
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect(h.adminEmail).not.toHaveBeenCalled();
  });

  it('an update that fails: every session still ends, nobody is told, and the answer is failed', async () => {
    h.failures.sign_in_alerts = { update: { code: '57014', message: 'timeout' } };
    const answer = await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(answer).toEqual({ outcome: 'failed' });
    expect(h.revoke).toHaveBeenCalledWith(MEMBER);
    expect(h.memberEmail).not.toHaveBeenCalled();
    expect(h.adminEmail).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'security.sign_in_report_update_failed',
      level: 'warning',
      extra: { code: '57014' },
    });
  });

  it('a failed email or forget is reported with a code only, and the answer is still done', async () => {
    h.adminEmail.mockResolvedValue({ ok: false, id: undefined } as unknown as { ok: true; id: string });
    h.failures.user_login_devices = { delete: { code: '42501', message: 'refused for member@example.test' } };
    const answer = await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(answer).toEqual({ outcome: 'done', firstReport: true });
    const tags = h.reportError.mock.calls.map((c) => (c[1] as { tag: string }).tag);
    expect(tags).toContain('security.sign_in_report_forget_failed');
    expect(tags).toContain('security.sign_in_report_email_failed');
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('example.test');
  });

  it('a membership read that fails: the member is still told; one audit row with no organization', async () => {
    h.failures.organization_members = { select: { code: '57014', message: 'timeout' } };
    const answer = await reportSignInAlertNotMe({ alert: await readAlert(), via: 'link', auditFrom: AUDIT_FROM });
    expect(answer).toEqual({ outcome: 'done', firstReport: true });
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.adminEmail).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ organization_id: null });
  });
});
