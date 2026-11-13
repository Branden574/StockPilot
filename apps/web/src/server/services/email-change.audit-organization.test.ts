import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Docket S74 (web). Every audit row the email-change service writes is filed
 * under an organization only when the person is a current, accepted member of
 * it, by the same rule the sign-in row uses (resolveDefaultOrgAndRole in
 * auth-audit.ts): the profile's default organization when it is an accepted
 * membership, else the person's oldest accepted membership, else none. A row
 * that resolves to no organization is still written, with organization_id
 * null, never dropped.
 *
 * A membership read that fails files the row with no organization and reports
 * the failure (fail closed: never an organization the read could not confirm).
 *
 * The membership check under test is the REAL resolver, over an in-memory
 * organization_members table that honours the filters the resolver sends
 * (eq, not accepted_at is null, order, limit). GoTrue, mail, rate limits and
 * the password check are stand-ins.
 */

const USER_ID = '55555555-5555-4555-8555-555555555555';
/** The person's own workspace, an accepted membership. */
const ORG_HOME = '11111111-1111-4111-8111-111111111111';
/** Another workspace the person also belongs to (joined later than ORG_HOME). */
const ORG_SECOND = '22222222-2222-4222-8222-222222222222';
/** A workspace the person does not (or no longer) belong to. */
const ORG_OTHER = '33333333-3333-4333-8333-333333333333';
/** An id no organization has. */
const ORG_MISSING = '99999999-9999-4999-8999-999999999999';

const OLD = 'before@example.com';
const NEW = 'after@example.com';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  /** Tables whose SELECT answers { data: null, error }. */
  failingReads: new Set<string>(),
  /** A select list whose read of user_profiles fails (the resolver's own read). */
  failingProfileSelect: null as string | null,
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
}));

/** A PostgREST-shaped read over h.tables that honours the filters it is sent. */
function selectQuery(table: string, columns: string) {
  const eqs: Array<[string, unknown]> = [];
  const notNull: string[] = [];
  const orders: Array<[string, boolean]> = [];
  let limit: number | null = null;
  const run = () => {
    const failed =
      h.failingReads.has(table) ||
      (table === 'user_profiles' && h.failingProfileSelect === columns);
    if (failed) {
      return { data: null, error: { code: 'XX000', message: 'read failed in test' } };
    }
    let rows = (h.tables[table] ?? []).filter(
      (r) => eqs.every(([c, v]) => r[c] === v) && notNull.every((c) => r[c] != null),
    );
    for (const [col, asc] of [...orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const x = String(a[col]);
        const y = String(b[col]);
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (limit != null) rows = rows.slice(0, limit);
    return { data: rows, error: null };
  };
  const q = {
    eq(col: string, v: unknown) {
      eqs.push([col, v]);
      return q;
    },
    not(col: string, op: string, v: unknown) {
      if (op !== 'is' || v !== null) throw new Error(`unexpected not(${col}, ${op})`);
      notNull.push(col);
      return q;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orders.push([col, opts?.ascending !== false]);
      return q;
    },
    limit(n: number) {
      limit = n;
      return q;
    },
    async maybeSingle() {
      const res = run();
      if (res.error) return res;
      if (res.data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'many' } };
      return { data: res.data[0] ?? null, error: null };
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(resolve, reject);
    },
  };
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { generateLink, getUserById } },
    rpc,
    from: (table: string) => ({
      select: (columns: string) => selectQuery(table, columns),
      insert: (payload: Record<string, unknown>) => {
        h.inserts.push({ table, payload });
        const res = { error: null, status: 201, statusText: 'Created' };
        return { abortSignal: () => Promise.resolve(res) };
      },
      update: (payload: Record<string, unknown>) => ({
        eq: async (col: string, v: unknown) => {
          h.updates.push({ table, payload });
          for (const r of h.tables[table] ?? []) if (r[col] === v) Object.assign(r, payload);
          return { error: null };
        },
      }),
    }),
  }),
}));

const generateLink = vi.fn();
const getUserById = vi.fn();
const rpc = vi.fn();
const sendEmail = vi.fn();

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: (args: unknown) => sendEmail(args) }));
// The signing value is a dull one under a neutral name
// (src/test/secret-shaped-fixtures.guard.test.ts).
const envState = vi.hoisted(() => {
  const SIGNING_INPUT = 'test-only-signing-input';
  return { NEXT_PUBLIC_APP_URL: 'https://app.example.com', SUPABASE_SERVICE_ROLE_KEY: SIGNING_INPUT };
});
vi.mock('@/lib/env', () => ({ env: envState }));
const reportError = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import {
  cancelEmailChange,
  reconcileProfileEmail,
  requestEmailChange,
  resendEmailChange,
} from './email-change';
import { resolveDefaultOrgAndRole } from './auth-audit';

function profile(defaultOrg: string | null, email = OLD): Row {
  return {
    id: USER_ID,
    email,
    default_organization_id: defaultOrg,
    full_name: 'Robin Example',
    disabled_at: null,
    deleted_at: null,
  };
}

function member(orgId: string, accepted: boolean, createdAt: string): Row {
  return {
    user_id: USER_ID,
    organization_id: orgId,
    role: 'staff',
    accepted_at: accepted ? createdAt : null,
    created_at: createdAt,
  };
}

function authUser(overrides: Row = {}) {
  return { data: { user: { id: USER_ID, email: OLD, ...overrides } }, error: null };
}

/** The one person's world: their profile row and their membership rows. */
interface World {
  defaultOrg: string | null;
  members: Row[];
}

const WORLDS: Record<string, { world: World; expected: string | null }> = {
  'a current accepted member of the default organization': {
    world: { defaultOrg: ORG_HOME, members: [member(ORG_HOME, true, '2026-01-01T00:00:00Z')] },
    expected: ORG_HOME,
  },
  'a former member of the default organization (membership removed), with no other': {
    world: { defaultOrg: ORG_OTHER, members: [] },
    expected: null,
  },
  'a pending (not accepted) member of the default organization': {
    world: { defaultOrg: ORG_OTHER, members: [member(ORG_OTHER, false, '2026-01-01T00:00:00Z')] },
    expected: null,
  },
  'a default organization that does not exist': {
    world: { defaultOrg: ORG_MISSING, members: [] },
    expected: null,
  },
  'no default organization and no membership': {
    world: { defaultOrg: null, members: [] },
    expected: null,
  },
  'a default the person is not a member of, while they hold other accepted memberships': {
    world: {
      defaultOrg: ORG_OTHER,
      members: [
        member(ORG_SECOND, true, '2026-03-01T00:00:00Z'),
        member(ORG_HOME, true, '2026-01-01T00:00:00Z'),
      ],
    },
    // The sign-in rule: the oldest accepted membership, never the default.
    expected: ORG_HOME,
  },
};

function setWorld(world: World, opts: { authEmail?: string; profileEmail?: string } = {}) {
  h.tables.user_profiles = [profile(world.defaultOrg, opts.profileEmail ?? OLD)];
  h.tables.organization_members = world.members.map((m) => ({ ...m }));
  h.tables.audit_logs = [];
}

/** Each audit writer of the service: how to reach it, and the event it writes. */
const WRITERS: Array<{
  name: string;
  event: string;
  outcome?: string;
  run: () => Promise<unknown>;
  arrange?: () => void;
}> = [
  {
    name: 'request refused for a taken address (target_exists)',
    event: 'user.email.change_requested',
    outcome: 'target_exists',
    arrange: () => {
      rpc.mockImplementation(async (name: string) =>
        name === 'auth_user_exists_by_email' ? { data: true, error: null } : { data: null, error: null },
      );
    },
    run: () =>
      requestEmailChange({
        userId: USER_ID,
        newEmail: NEW,
        currentPassword: 'test-only-current-password',
        mfa: { enrolled: false, aal2: false },
        source: 'web',
      }).catch(() => undefined),
  },
  {
    name: 'request sent',
    event: 'user.email.change_requested',
    outcome: 'sent',
    run: () =>
      requestEmailChange({
        userId: USER_ID,
        newEmail: NEW,
        currentPassword: 'test-only-current-password',
        mfa: { enrolled: false, aal2: false },
        source: 'web',
      }),
  },
  {
    name: 'resend',
    event: 'user.email.change_resent',
    arrange: () => {
      getUserById.mockResolvedValue(authUser({ new_email: NEW, email_change_sent_at: new Date().toISOString() }));
    },
    run: () => resendEmailChange({ userId: USER_ID, mfa: { enrolled: false, aal2: false }, source: 'mobile' }),
  },
  {
    name: 'cancel',
    event: 'user.email.change_cancelled',
    arrange: () => {
      getUserById.mockResolvedValue(authUser({ new_email: NEW, email_change_sent_at: new Date().toISOString() }));
    },
    run: () => cancelEmailChange({ userId: USER_ID, source: 'web' }),
  },
  {
    name: 'reconcile (the projection lagged the verified address)',
    event: 'user.email.changed',
    arrange: () => {
      getUserById.mockResolvedValue(authUser({ email: NEW }));
    },
    run: () => reconcileProfileEmail(USER_ID),
  },
];

function auditRowsWritten() {
  return h.inserts.filter((i) => i.table === 'audit_logs').map((i) => i.payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(h.tables)) delete h.tables[k];
  h.failingReads.clear();
  h.failingProfileSelect = null;
  h.inserts.length = 0;
  h.updates.length = 0;
  getUserById.mockResolvedValue(authUser());
  sendEmail.mockResolvedValue({ ok: true, id: 'msg' });
  rpc.mockImplementation(async (name: string) => {
    if (name === 'auth_user_exists_by_email') return { data: false, error: null };
    if (name === 'cancel_pending_email_change') return { data: true, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
  generateLink.mockImplementation(async (params: { type: string }) =>
    params.type === 'email_change_current'
      ? { data: { properties: { hashed_token: 'ab'.repeat(28), email_otp: '00000000' } }, error: null }
      : { data: { properties: { hashed_token: 'cd'.repeat(28), email_otp: '12345678' } }, error: null },
  );
});

describe.each(WRITERS)('email-change audit writer: $name', (writer) => {
  it.each(Object.entries(WORLDS))(
    'for %s, the row is written and filed under the membership the sign-in rule resolves',
    async (_label, { world, expected }) => {
      setWorld(world);
      writer.arrange?.();
      await writer.run();

      const rows = auditRowsWritten();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: USER_ID,
        event: writer.event,
        organization_id: expected,
      });
      if (writer.outcome) {
        expect(rows[0]!.metadata).toMatchObject({ outcome: writer.outcome });
      }
    },
  );

  it('a membership read that fails files the row with no organization and reports the failure', async () => {
    setWorld(WORLDS['a current accepted member of the default organization']!.world);
    h.failingReads.add('organization_members');
    writer.arrange?.();
    await writer.run();

    const rows = auditRowsWritten();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: USER_ID, event: writer.event, organization_id: null });
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'audit.organization_unresolved' }),
    );
  });
});

describe('resolveDefaultOrgAndRole: a read that fails resolves to no organization and is reported', () => {
  it('the profile read fails: no organization, even though an accepted membership exists', async () => {
    setWorld(WORLDS['a current accepted member of the default organization']!.world);
    h.failingProfileSelect = 'default_organization_id';
    await expect(resolveDefaultOrgAndRole(USER_ID)).resolves.toEqual({ organizationId: null, role: null });
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, ctx] = reportError.mock.calls[0]! as [unknown, { tag: string; extra: Record<string, unknown> }];
    expect(ctx).toMatchObject({ tag: 'audit.organization_unresolved', level: 'warning' });
    // The code only, never the message, which can quote request details.
    expect(JSON.stringify(reportError.mock.calls)).not.toContain('read failed in test');
  });

  it('the membership read fails: no organization, reported once', async () => {
    setWorld(WORLDS['a default the person is not a member of, while they hold other accepted memberships']!.world);
    h.failingReads.add('organization_members');
    await expect(resolveDefaultOrgAndRole(USER_ID)).resolves.toEqual({ organizationId: null, role: null });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('reads that succeed report nothing', async () => {
    setWorld(WORLDS['a current accepted member of the default organization']!.world);
    await expect(resolveDefaultOrgAndRole(USER_ID)).resolves.toEqual({ organizationId: ORG_HOME, role: 'staff' });
    expect(reportError).not.toHaveBeenCalled();
  });
});
