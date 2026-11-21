// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Part 3 (sign-in alerts): the member's "This was not me". One function, used
 * by the emailed link's page and by the signed-in action. The order (review
 * 1, finding 2):
 * ONE ALERT, ONE SIGN-OUT:
 *   - an alert already not_me when the call starts does nothing more: no
 *     sign-out, no telling. (The sign-out below always comes before the mark,
 *     so a marked alert has had its sessions ended.) A link in an email can
 *     therefore not be used to end the account's sessions again and again;
 *   a. every session of the account is ended first. If that fails the answer
 *      is "try again", nothing else changes and nobody is told, so the retry
 *      is a full first report;
 *   b. the alert is marked not_me, with its resolved_at, in one update that
 *      only changes an alert not already not_me;
 *   c. only when (b) changed the row: the device row is forgotten (by its
 *      hash) only for a new-device alert, the country row only for a
 *      new-country alert; the owners and admins of each organization the
 *      member belongs to (accepted, not a support act-as seat, at most 5) get
 *      an in-app notice and an email naming the device FAMILY; the member is
 *      emailed; one audit row per organization; one security event. Managers
 *      and staff are never told; nor is the member twice.
 * The emails go one after another, the member's first (finding 3). The
 * member's name never leads a title or a subject (finding 7). The answer says
 * whether an owner or admin was told, so the words claim it only then
 * (finding 8).
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
  /** Tables whose reads answer something that is not a list (an empty body). */
  notList: new Set<string>(),
  /** What happened, in order: `revoke`, `<op>:<table>`, `notify`, `email:member`, `email:admin`. */
  order: [] as string[],
  /** Emails being sent at this moment, and the most there ever were at once. */
  sending: 0,
  mostSendingAtOnce: 0,
  revoke: vi.fn(async (_userId: string): Promise<{ ok: boolean; sessionIds: string[] }> => ({
    ok: true,
    sessionIds: ['s1', 's2'],
  })),
  memberEmail: vi.fn(async (_a: Record<string, unknown>): Promise<{ ok: boolean; id?: string }> => ({
    ok: true,
    id: 'dryrun',
  })),
  adminEmail: vi.fn(async (_a: Record<string, unknown>): Promise<{ ok: boolean; id?: string }> => ({
    ok: true,
    id: 'dryrun',
  })),
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
    h.order.push(`${state.op}:${table}`);
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
    if (h.notList.has(table)) return { data: {}, error: null, status: 200 };
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
  revokeAllSessionsForUser: (userId: string) => {
    h.order.push('revoke');
    return h.revoke(userId);
  },
}));
/** One send that takes a turn of the event loop, so sends made together would overlap. */
async function sending<T>(name: string, send: () => Promise<T>): Promise<T> {
  h.order.push(name);
  h.sending += 1;
  h.mostSendingAtOnce = Math.max(h.mostSendingAtOnce, h.sending);
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    return await send();
  } finally {
    h.sending -= 1;
  }
}
vi.mock('@/lib/email/login-alert', () => ({
  SIGN_IN_ALERTS_LIST_PATH: '/dashboard/settings/security/sign-ins',
  sendSignedOutEverywhereEmail: (a: Record<string, unknown>) => sending('email:member', () => h.memberEmail(a)),
  sendSignInReportedEmail: (a: Record<string, unknown>) => sending('email:admin', () => h.adminEmail(a)),
}));
vi.mock('@/server/services/notifications', () => ({
  createNotification: (a: Record<string, unknown>) => {
    h.order.push('notify');
    return h.notify(a);
  },
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
  h.order = [];
  h.sending = 0;
  h.mostSendingAtOnce = 0;
  h.failures = {};
  h.notList = new Set();
  h.revoke.mockResolvedValue({ ok: true, sessionIds: ['s1', 's2'] });
  h.memberEmail.mockResolvedValue({ ok: true, id: 'dryrun' });
  h.adminEmail.mockResolvedValue({ ok: true, id: 'dryrun' });
  h.notify.mockResolvedValue('n1');
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

const TITLE = 'A member reported a sign-in they did not make';

function report(alert: SignInAlertRecord, via: 'link' | 'signed_in' = 'link') {
  return reportSignInAlertNotMe({ alert, via, auditFrom: AUDIT_FROM });
}

function tags(): string[] {
  return h.reportError.mock.calls.map((c) => (c[1] as { tag: string }).tag);
}

function nobodyWasTold() {
  expect(h.memberEmail).not.toHaveBeenCalled();
  expect(h.adminEmail).not.toHaveBeenCalled();
  expect(h.notify).not.toHaveBeenCalled();
  expect(h.audit).not.toHaveBeenCalled();
  expect(h.event).not.toHaveBeenCalled();
}

describe('reportSignInAlertNotMe: the first report', () => {
  it('ends every session first, then marks the alert not_me with its resolved_at in one conditional update', async () => {
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: true });

    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect(h.revoke).toHaveBeenCalledWith(MEMBER);
    const update = h.calls.find((c) => c.table === 'sign_in_alerts' && c.op === 'update')!;
    expect(update.patch).toEqual({ status: 'not_me', resolved_at: expect.any(String) });
    expect(update.filters).toEqual([
      ['eq', 'id', ALERT],
      ['eq', 'user_id', MEMBER],
      ['neq', 'status', 'not_me'],
    ]);
    expect(h.tables.sign_in_alerts![0]).toMatchObject({ status: 'not_me' });
    expect(h.tables.sign_in_alerts![0]!.resolved_at).not.toBeNull();

    // The order: the sign-out, the update, and only then anything else.
    const acted = h.order.filter((step) => !step.startsWith('select:'));
    expect(acted.slice(0, 2)).toEqual(['revoke', 'update:sign_in_alerts']);
    expect(acted.indexOf('delete:user_login_devices')).toBeGreaterThan(1);
    expect(acted.indexOf('notify')).toBeGreaterThan(1);
    expect(acted.indexOf('email:member')).toBeGreaterThan(1);
  });

  it('a new-device alert forgets that device row only; the country rows stay', async () => {
    await report(await readAlert());
    expect(h.tables.user_login_devices).toEqual([{ user_id: MEMBER, device_hash: 'cd'.repeat(20) }]);
    expect(h.tables.user_sign_in_countries).toHaveLength(2);
  });

  it('a new-country alert forgets that country row only; the device rows stay', async () => {
    seed(alertRow({ new_device: false, new_country: true }));
    await report(await readAlert());
    expect(h.tables.user_sign_in_countries).toEqual([{ user_id: MEMBER, country: 'US' }]);
    expect(h.tables.user_login_devices).toHaveLength(2);
  });

  it('both flags: both rows are forgotten', async () => {
    seed(alertRow({ new_device: true, new_country: true }));
    await report(await readAlert(), 'signed_in');
    expect(h.tables.user_login_devices).toHaveLength(1);
    expect(h.tables.user_sign_in_countries).toEqual([{ user_id: MEMBER, country: 'US' }]);
  });

  it('the member is emailed once, with their own device words, the place, the sign-in time, and whether an owner or admin was told', async () => {
    await report(await readAlert());
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.memberEmail.mock.calls[0]![0]).toEqual({
      to: 'member@example.test',
      firstName: 'Avery',
      device: 'Avery work laptop',
      place: { country: 'MX', city: 'Tijuana' },
      signedInAt: new Date('2026-11-20T15:30:00.000Z'),
      adminsTold: true,
    });
  });

  it('owners and admins are told by email and in the app, naming the device family; managers, staff, act-as seats and invitations are not', async () => {
    await report(await readAlert());
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
      title: TITLE,
      link: '/dashboard/settings/security/sign-ins',
      metadata: { alert_id: ALERT, member_id: MEMBER },
    });
    expect(String(h.notify.mock.calls[0]![0].body)).toContain('Chrome on macOS');
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain('Avery work laptop');
  });

  it('the members of the organizations are read on the server: accepted, not act-as, owners and admins only', async () => {
    await report(await readAlert());
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
    await report(await readAlert());
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.adminEmail.mock.calls.map((c) => c[0].to)).not.toContain('member@example.test');
    expect(h.notify.mock.calls.map((c) => c[0].userId)).not.toContain(MEMBER);
  });

  it('an admin of two of the organizations gets one email and a notice in each', async () => {
    h.tables.organization_members!.push(member(MEMBER, ORG_B, 'staff'), member(ADMIN_A, ORG_B, 'admin'));
    await report(await readAlert());
    expect(h.adminEmail.mock.calls.filter((c) => c[0].to === 'admin@example.test')).toHaveLength(1);
    const notices = h.notify.mock.calls.filter((c) => c[0].userId === ADMIN_A).map((c) => c[0].organizationId);
    expect(notices.sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it('a disabled admin gets no email', async () => {
    h.tables.user_profiles = h.tables.user_profiles!.map((p) =>
      p.id === ADMIN_A ? { ...p, disabled_at: '2026-11-01T00:00:00Z' } : p,
    );
    await report(await readAlert());
    expect(h.adminEmail.mock.calls.map((c) => c[0].to)).toEqual(['owner@example.test']);
  });

  it('one audit row per organization, as the member, with the request it came from', async () => {
    h.tables.organization_members!.push(member(MEMBER, ORG_B, 'staff'), member(ADMIN_B, ORG_B, 'admin'));
    await report(await readAlert());
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
    await report(await readAlert());
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
    await report(await readAlert());
    const ids = h.calls.find((c) => c.table === 'organization_members' && c.filters[0]![0] === 'in')!
      .filters[0]![2] as string[];
    expect(ids.length).toBeLessThanOrEqual(5);
  });

  it('a member in no organization: the member is told, one audit row with no organization, nobody else', async () => {
    h.tables.organization_members = [];
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: false });
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.adminEmail).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ organization_id: null });
  });
});

describe('reportSignInAlertNotMe: the emails go one after another (finding 3)', () => {
  it('the member’s email first, then each owner and admin, never two at once', async () => {
    h.tables.organization_members!.push(member(MEMBER, ORG_B, 'staff'), member(ADMIN_B, ORG_B, 'admin'));
    await report(await readAlert());
    const emails = h.order.filter((step) => step.startsWith('email:'));
    expect(emails).toEqual(['email:member', 'email:admin', 'email:admin', 'email:admin']);
    expect(h.mostSendingAtOnce).toBe(1);
  });

  it('emails that were not sent are reported ONCE, with how many, never the addresses', async () => {
    h.adminEmail.mockResolvedValue({ ok: false });
    const answer = await report(await readAlert());
    // Each owner and admin still has the in-app notice.
    expect(answer).toEqual({ outcome: 'done', adminsTold: true });
    const failures = h.reportError.mock.calls.filter(
      (c) => (c[1] as { tag: string }).tag === 'security.sign_in_report_email_failed',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]![1]).toEqual({
      tag: 'security.sign_in_report_email_failed',
      level: 'warning',
      extra: { member_not_sent: 0, admins_not_sent: 2, admins: 2 },
    });
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('example.test');
  });

  it('a member’s email that was not sent is in the same one report', async () => {
    h.memberEmail.mockResolvedValue({ ok: false });
    await report(await readAlert());
    const failures = h.reportError.mock.calls.filter(
      (c) => (c[1] as { tag: string }).tag === 'security.sign_in_report_email_failed',
    );
    expect(failures).toHaveLength(1);
    expect((failures[0]![1] as { extra: unknown }).extra).toEqual({
      member_not_sent: 1,
      admins_not_sent: 0,
      admins: 2,
    });
  });

  it('a send that throws is a send that failed: the others still go, and it is counted in the one report', async () => {
    h.memberEmail.mockRejectedValue(new Error('render failed for member@example.test'));
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: true });
    expect(h.adminEmail).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(tags().filter((t) => t === 'security.sign_in_report_email_failed')).toHaveLength(1);
    expect(tags()).not.toContain('security.sign_in_report_tell_failed');
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('example.test');
  });

  it('every email sent: nothing is reported', async () => {
    await report(await readAlert());
    expect(tags()).not.toContain('security.sign_in_report_email_failed');
  });
});

describe('reportSignInAlertNotMe: the member’s name never leads (finding 7)', () => {
  it('the notice’s title is fixed words; the name is in the body, next to the sign-in address', async () => {
    await report(await readAlert());
    for (const [notice] of h.notify.mock.calls) {
      expect(notice.title).toBe(TITLE);
      expect(String(notice.body)).toContain('Avery Example (member@example.test)');
    }
  });

  it('a name the member chose is cut to 80 characters and loses its control and invisible characters', async () => {
    const chosen = `Sign in\u0000 at\u200B once\u202E\n to keep\u2066 your account. ${'x'.repeat(200)}`;
    h.tables.user_profiles = h.tables.user_profiles!.map((p) => (p.id === MEMBER ? { ...p, full_name: chosen } : p));
    await report(await readAlert());
    const clean = `Sign in at once to keep your account. ${'x'.repeat(200)}`.slice(0, 80);
    for (const [notice] of h.notify.mock.calls) {
      expect(notice.title).toBe(TITLE);
      expect(String(notice.body)).toContain(`${clean} (member@example.test)`);
      expect(String(notice.body)).not.toContain('x'.repeat(81));
      expect(String(notice.body)).not.toMatch(/[\u0000-\u001F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/);
    }
    for (const [email] of h.adminEmail.mock.calls) {
      expect(email.memberName).toBe(clean);
      expect(email.memberEmail).toBe('member@example.test');
    }
  });

  it('a member with no name is named by the sign-in address alone', async () => {
    h.tables.user_profiles = h.tables.user_profiles!.map((p) => (p.id === MEMBER ? { ...p, full_name: null } : p));
    await report(await readAlert());
    expect(h.notify.mock.calls[0]![0].title).toBe(TITLE);
    expect(String(h.notify.mock.calls[0]![0].body)).toMatch(/^member@example\.test said /);
    expect(h.adminEmail.mock.calls[0]![0].memberName).toBeNull();
  });
});

describe('reportSignInAlertNotMe: "the owners and admins were told" only when one was (finding 8)', () => {
  it('a sole owner: nobody else to tell, so the answer and the member’s email do not claim it', async () => {
    h.tables.organization_members = [member(MEMBER, ORG_A, 'owner'), member(STAFF_A, ORG_A, 'staff')];
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: false });
    expect(h.memberEmail.mock.calls[0]![0]).toMatchObject({ adminsTold: false });
  });

  it('a membership read that fails: not claimed', async () => {
    h.failures.organization_members = { select: { code: '57014', message: 'timeout' } };
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: false });
    expect(h.memberEmail.mock.calls[0]![0]).toMatchObject({ adminsTold: false });
  });

  it('no notice could be made and no email was sent: not claimed', async () => {
    h.notify.mockResolvedValue(null);
    h.adminEmail.mockResolvedValue({ ok: false });
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: false });
    expect(h.memberEmail.mock.calls[0]![0]).toMatchObject({ adminsTold: false });
  });

  it('no notice could be made but an email was sent: the answer claims it', async () => {
    h.notify.mockResolvedValue(null);
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: true });
  });

  it('a notice that throws is not a notice', async () => {
    h.notify.mockRejectedValue(new Error('boom'));
    h.adminEmail.mockResolvedValue({ ok: false });
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: false });
  });
});

describe('reportSignInAlertNotMe: again, and half-finished (finding 2)', () => {
  it('a second press ends nothing and tells nobody: one alert, one sign-out', async () => {
    await report(await readAlert());
    vi.clearAllMocks();
    h.order = [];
    const devices = h.tables.user_login_devices!.length;

    // The alert is read again, as each caller does: it is not_me now.
    const again = await report(await readAlert());
    expect(again).toEqual({ outcome: 'already_reported' });
    expect(h.revoke).not.toHaveBeenCalled();
    // The read, and nothing else: no sign-out, no update, no delete.
    expect(h.order).toEqual(['select:sign_in_alerts']);
    expect(h.tables.user_login_devices).toHaveLength(devices);
    nobodyWasTold();
  });

  it('however often it is pressed again, no session is ended again', async () => {
    await report(await readAlert());
    vi.clearAllMocks();
    for (let press = 0; press < 5; press++) {
      expect(await report(await readAlert())).toEqual({ outcome: 'already_reported' });
    }
    expect(h.revoke).not.toHaveBeenCalled();
    nobodyWasTold();
  });

  it('a press after a FAILED sign-out (the alert is still open) completes the report, once', async () => {
    h.revoke.mockResolvedValue({ ok: false, sessionIds: [] });
    expect(await report(await readAlert())).toEqual({ outcome: 'failed' });
    expect(h.tables.sign_in_alerts![0]).toMatchObject({ status: 'open', resolved_at: null });
    nobodyWasTold();

    h.revoke.mockResolvedValue({ ok: true, sessionIds: ['s1'] });
    expect(await report(await readAlert())).toEqual({ outcome: 'done', adminsTold: true });
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.adminEmail).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.event).toHaveBeenCalledTimes(1);

    // A third press: nothing more, of anything.
    expect(await report(await readAlert())).toEqual({ outcome: 'already_reported' });
    expect(h.revoke).toHaveBeenCalledTimes(2);
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.adminEmail).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.event).toHaveBeenCalledTimes(1);
  });

  it('two presses at once: the one whose update changes no row tells nobody (its sign-out ran before the mark, as always)', async () => {
    // Read while the alert is open; the other press marks it before this one's update.
    const alert = await readAlert();
    Object.assign(h.tables.sign_in_alerts![0]!, { status: 'not_me', resolved_at: '2026-11-20T15:40:00Z' });
    const answer = await report(alert);
    expect(answer).toEqual({ outcome: 'already_reported' });
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect(h.tables.user_login_devices).toHaveLength(2);
    nobodyWasTold();
  });

  it('"this was me" earlier does not stop a later "not me"', async () => {
    seed(alertRow({ status: 'was_me', resolved_at: '2026-11-20T15:35:00Z' }));
    const answer = await report(await readAlert(), 'signed_in');
    expect(answer).toEqual({ outcome: 'done', adminsTold: true });
    expect(h.tables.sign_in_alerts![0]).toMatchObject({ status: 'not_me' });
  });

  it('a sign-out that fails: "try again", the alert stays as it was, nothing is forgotten and nobody is told; the retry is a full first report', async () => {
    h.revoke.mockResolvedValue({ ok: false, sessionIds: [] });
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'failed' });
    expect(h.tables.sign_in_alerts![0]).toMatchObject({ status: 'open', resolved_at: null });
    expect(h.order.filter((step) => !step.startsWith('select:'))).toEqual(['revoke']);
    expect(h.tables.user_login_devices).toHaveLength(2);
    nobodyWasTold();

    h.revoke.mockResolvedValue({ ok: true, sessionIds: ['s1'] });
    const retry = await report(await readAlert());
    expect(retry).toEqual({ outcome: 'done', adminsTold: true });
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.adminEmail).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ metadata: { signed_out: true } });
    expect(h.tables.user_login_devices).toHaveLength(1);
  });

  it('a sign-out that throws is a sign-out that failed', async () => {
    h.revoke.mockRejectedValue(new Error('network'));
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'failed' });
    expect(h.tables.sign_in_alerts![0]).toMatchObject({ status: 'open' });
    nobodyWasTold();
  });

  it('an update that fails: the sessions ended, nothing is forgotten, nobody is told, and the retry is a full first report', async () => {
    h.failures.sign_in_alerts = { update: { code: '57014', message: 'timeout' } };
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'failed' });
    expect(h.revoke).toHaveBeenCalledWith(MEMBER);
    expect(h.tables.user_login_devices).toHaveLength(2);
    nobodyWasTold();
    expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'security.sign_in_report_update_failed',
      level: 'warning',
      extra: { code: '57014' },
    });

    h.failures = {};
    const retry = await report(await readAlert());
    expect(retry).toEqual({ outcome: 'done', adminsTold: true });
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
  });

  it('a failed forget is reported with a code only, and the answer is still done', async () => {
    h.failures.user_login_devices = { delete: { code: '42501', message: 'refused for member@example.test' } };
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: true });
    expect(tags()).toContain('security.sign_in_report_forget_failed');
    expect(JSON.stringify(h.reportError.mock.calls)).not.toContain('example.test');
  });

  it('a profile page that is not a list is a failed read, reported with its detail: nobody is emailed as if that were everyone', async () => {
    h.notList.add('user_profiles');
    const answer = await report(await readAlert());
    // The sign-out and the status decided the answer; the rest is best effort.
    // The in-app notices come from the memberships, which were read.
    expect(answer).toEqual({ outcome: 'done', adminsTold: true });
    expect(h.memberEmail).not.toHaveBeenCalled();
    expect(h.adminEmail).not.toHaveBeenCalled();
    const failure = h.reportError.mock.calls.find(
      (c) => (c[1] as { tag: string }).tag === 'security.sign_in_report_read_failed',
    );
    expect(failure).toBeTruthy();
    const extra = (failure![1] as { extra: Record<string, unknown> }).extra;
    expect(extra.read).toBe('profiles');
    expect(String(extra.detail)).toContain('user_profiles');
    expect(h.notify).toHaveBeenCalled();
    // With no profile read, the notice names nobody: fixed words only.
    expect(h.notify.mock.calls[0]![0].title).toBe(TITLE);
    expect(String(h.notify.mock.calls[0]![0].body)).toMatch(/^A member said /);
  });

  it('a membership or organization answer that is not a list is a failed read too', async () => {
    h.notList.add('organization_members');
    await report(await readAlert());
    expect(h.adminEmail).not.toHaveBeenCalled();
    expect(h.audit.mock.calls.map((c) => c[0].organization_id)).toEqual([null]);
    const reads = h.reportError.mock.calls
      .filter((c) => (c[1] as { tag: string }).tag === 'security.sign_in_report_read_failed')
      .map((c) => (c[1] as { extra: { read: string } }).extra.read);
    expect(reads).toContain('organizations');
  });

  it('a membership read that fails: the member is still told; one audit row with no organization', async () => {
    h.failures.organization_members = { select: { code: '57014', message: 'timeout' } };
    const answer = await report(await readAlert());
    expect(answer).toEqual({ outcome: 'done', adminsTold: false });
    expect(h.memberEmail).toHaveBeenCalledTimes(1);
    expect(h.adminEmail).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ organization_id: null });
  });
});
