import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

import { SECURITY_EVENT_CATEGORIES } from '@stockpilot/core';

/**
 * The platform console's security briefing reads (service client).
 *
 * Security invariant. Pinned: every read stands alone (one that fails is
 * "could not check" for its own part and is reported once, the others are
 * shown); a function that is not in the database yet (PGRST202) is reported
 * by name; each read has its own time budget; an answer whose shape this
 * build does not know (a key too many, a key missing, a list past its cap)
 * is "could not check", so a session id, an address or a factor id that the
 * database must never return could not pass through; nothing throws. For one
 * organization: the week's numbers are the database's own counts
 * (changes_this_week), never a count of the list, which stops at 200 rows;
 * the names in the changes come from one batched read of the organization's
 * real memberships and one of those members' profiles, under one time
 * budget; a member is always written with their email, so a name a member
 * chose can never read as "StockPilot support", which is given only to a
 * platform administrator with no membership there; anyone else who is no
 * member now is "a former member". Made-up people only.
 */

const ORG = '0b8f6c1e-0000-4000-8000-000000000001';
const OTHER_ORG = '0b8f6c1e-0000-4000-8000-000000000002';
const ADMIN = '0b8f6c1e-0000-4000-8000-0000000000c1';
const ALEX = '0b8f6c1e-0000-4000-8000-0000000000c2';
const GONE = '0b8f6c1e-0000-4000-8000-0000000000c3';
const SUPPORT = '0b8f6c1e-0000-4000-8000-0000000000c4';
const FORMER_ADMIN = '0b8f6c1e-0000-4000-8000-0000000000c5';

const NOW = Date.parse('2026-11-23T12:00:00Z');

const h = vi.hoisted(() => ({
  reportError: vi.fn(async (..._a: unknown[]) => {}),
  site: { rpId: 'example.test', origins: ['https://example.test'] } as {
    rpId: string;
    origins: string[];
  } | null,
  clientFails: false,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.reportError }));
vi.mock('@/lib/auth/passkey-relying-party', () => ({ passkeyRelyingParty: () => h.site }));
vi.mock('@/lib/auth/platform-admin', () => ({
  isPlatformAdmin: (email: string | null) => email === 'support@example.com',
}));

/* ───────── the database's answers, as CONTRACT.md writes them ───────── */

const zeros = () => ({ blocked: 0, flagged: 0, allowed: 0 });
const week = (over: Record<string, Partial<ReturnType<typeof zeros>>> = {}) =>
  Object.fromEntries(
    ['password_guessing', 'exploit', 'bots', 'phishing', 'malware'].map((c) => [
      c,
      { ...zeros(), ...(over[c] ?? {}) },
    ]),
  );

const memberRow = (over: Record<string, unknown> = {}) => ({
  organization_id: ORG,
  name: 'Example Academy',
  mfa_policy: 'admins_required',
  members: 41,
  admins: 4,
  without_second_step: 12,
  admins_without_second_step: 1,
  members_with_idle_sign_ins: 5,
  idle_sign_ins: 9,
  admins_joined_this_week: 1,
  sign_ins_reported_this_week: 0,
  ...over,
});

const membersAnswer = (over: Record<string, unknown> = {}) => ({
  organizations: [memberRow()],
  organizations_truncated: false,
  totals: {
    organizations: 1,
    accounts: 41,
    accounts_without_second_step: 12,
    admin_accounts_without_second_step: 1,
  },
  idle_after_days: 30,
  ...over,
});

const eventsAnswer = (over: Record<string, unknown> = {}) => ({
  organizations: [
    {
      organization_id: ORG,
      this_week: week({
        password_guessing: { blocked: 25, flagged: 1 },
        bots: { blocked: 3 },
        phishing: { flagged: 2 },
      }),
      last_week: week({ password_guessing: { blocked: 4 } }),
      passkey_unexplained_sign_in_this_week: 1,
      passkey_counter_went_back_this_week: 0,
    },
  ],
  organizations_truncated: false,
  no_organization: {
    this_week: week({ exploit: { blocked: 7 } }),
    last_week: week(),
    passkey_unexplained_sign_in_this_week: 0,
    passkey_counter_went_back_this_week: 2,
  },
  oldest_event_at: '2026-11-01T19:42:00+00:00',
  ...over,
});

const changesAnswer = (over: Record<string, unknown> = {}) => ({
  organizations: [
    {
      organization_id: ORG,
      admins_promoted: 1,
      admins_demoted_or_removed: 0,
      ownership_moved: 1,
      sign_in_policy_loosened: 1,
      sign_in_policy_tightened: 0,
      sign_in_policy_changed_other: 0,
      admins_added_this_week: 2,
    },
  ],
  organizations_truncated: false,
  ...over,
});

/** One organization's week, as the database counts it from every audit row. */
const weekCounts = (over: Record<string, number> = {}) => ({
  organization_id: ORG,
  admins_promoted: 0,
  admins_demoted_or_removed: 0,
  ownership_moved: 0,
  sign_in_policy_loosened: 0,
  sign_in_policy_tightened: 0,
  sign_in_policy_changed_other: 0,
  admins_added_this_week: 0,
  ...over,
});

const changeRow = (over: Record<string, unknown> = {}) => ({
  created_at: '2026-11-22T18:04:11.52+00:00',
  event: 'user.role.changed',
  actor_user_id: ADMIN,
  target_user_id: ALEX,
  entity_id: '0b8f6c1e-0000-4000-8000-0000000000e2',
  entity_type: 'organization_member',
  before: { role: 'staff' },
  after: { role: 'admin' },
  role: null,
  already_member: false,
  made_as: 'authenticated',
  ...over,
});

const detailAnswer = (over: Record<string, unknown> = {}) => ({
  ...memberRow(),
  idle_after_days: 30,
  people: [
    {
      user_id: ALEX,
      full_name: 'Alex Example',
      email: 'alex@example.com',
      role: 'admin',
      has_second_step: false,
      idle_sign_ins: 2,
      oldest_idle_at: '2026-10-03T08:15:00+00:00',
    },
  ],
  people_truncated: false,
  changes_this_week: weekCounts({ admins_promoted: 1, admins_added_this_week: 1 }),
  changes: [changeRow()],
  changes_truncated: false,
  ...over,
});

type Answer = { data: unknown; error: { message: string; code?: string } | null };
const ok = (data: unknown): Answer => ({ data, error: null });

let answers: Record<string, Answer | (() => Answer)>;
let profiles: Array<Record<string, unknown>>;
let memberships: Array<Record<string, unknown>>;
let namesFail: false | 'profiles' | 'memberships' | 'timeout';
/** Every rpc chain as it was awaited. */
let awaited: MockCall[];

const rpc = (fn: string) => (call: MockCall) => {
  if (call.methods.includes('abortSignal')) awaited.push(call);
  const answer = answers[fn];
  if (!answer) throw new Error(`no answer for ${fn}`);
  return typeof answer === 'function' ? answer() : answer;
};

/**
 * The table reads carry a time budget. The stub's PostgREST stand-in applies
 * the filters and has no word for `.abortSignal()`, so it is taken off the
 * call it serves; the tests read the signal from the recorded chain.
 */
const served = (rows: () => Array<Record<string, unknown>>) => (call: MockCall) => {
  const keep = call.methods.map((m) => m !== 'abortSignal');
  return servedLikePostgrest(rows)({
    ...call,
    methods: call.methods.filter((_, i) => keep[i]),
    args: call.args.filter((_, i) => keep[i]),
  });
};

const stub = makeSupabaseStub({
  'rpc:platform_security_briefing_members': rpc('platform_security_briefing_members'),
  'rpc:platform_security_briefing_events': rpc('platform_security_briefing_events'),
  'rpc:platform_security_briefing_changes': rpc('platform_security_briefing_changes'),
  'rpc:platform_security_briefing_for_organization': rpc(
    'platform_security_briefing_for_organization',
  ),
  'rpc:passkey_account_states': rpc('passkey_account_states'),
  'user_profiles.select': (call) => {
    if (namesFail === 'profiles') return { data: null, error: { message: 'profiles unreadable' } };
    if (namesFail === 'timeout') throw new Error('The operation was aborted due to timeout');
    return served(() => profiles)(call);
  },
  'organization_members.select': (call) =>
    namesFail === 'memberships'
      ? { data: null, error: { message: 'memberships unreadable' } }
      : served(() => memberships)(call),
  'organizations.select': () =>
    answers.organizations
      ? (answers.organizations as Answer)
      : ok([{ id: ORG, name: 'Example Academy' }]),
});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (h.clientFails) throw new Error('no service client');
    return stub.client;
  },
}));

import {
  findBriefingOrganization,
  PASSKEY_REPAIR_READ_CAP,
  platformBriefingChangesSchema,
  platformBriefingEventsSchema,
  platformBriefingMembersSchema,
  platformBriefingOrganizationSchema,
  readOrganizationSecurityBriefing,
  readPlatformSecurityBriefing,
  SECURITY_BRIEFING_READ_BUDGET_MS,
} from './security-briefing';

beforeEach(() => {
  vi.clearAllMocks();
  stub.rpcCalls.length = 0;
  stub.fromCalls.length = 0;
  stub.chainsAll.clear();
  stub.chainArgsAll.clear();
  awaited = [];
  h.site = { rpId: 'example.test', origins: ['https://example.test'] };
  h.clientFails = false;
  namesFail = false;
  answers = {
    platform_security_briefing_members: ok(membersAnswer()),
    platform_security_briefing_events: ok(eventsAnswer()),
    platform_security_briefing_changes: ok(changesAnswer()),
    platform_security_briefing_for_organization: ok(detailAnswer()),
    passkey_account_states: ok([]),
  };
  profiles = [
    { id: ADMIN, full_name: 'Dana Example', email: 'dana@example.com' },
    { id: ALEX, full_name: 'Alex Example', email: 'alex@example.com' },
    { id: GONE, full_name: 'Gone Example', email: 'gone@example.com' },
    { id: SUPPORT, full_name: 'Sam Support', email: 'support@example.com' },
    { id: FORMER_ADMIN, full_name: 'Former Example', email: 'former@example.com' },
  ];
  const member = (id: string, user_id: string, over: Record<string, unknown> = {}) => ({
    id,
    user_id,
    organization_id: ORG,
    accepted_at: '2026-01-01T00:00:00+00:00',
    impersonation_expires_at: null,
    ...over,
  });
  memberships = [
    member('m1', ADMIN),
    member('m2', ALEX),
    // Support's act-as seat is not a membership; nor is a seat in another organization.
    member('m3', SUPPORT, { impersonation_expires_at: '2026-11-22T20:00:00+00:00' }),
    member('m4', GONE, { organization_id: OTHER_ORG }),
    member('m5', FORMER_ADMIN, { accepted_at: null }),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const reports = () =>
  h.reportError.mock.calls.map(([err, ctx]) => ({
    message: (err as Error).message,
    ...(ctx as { tag: string; level?: string; extra?: Record<string, unknown> }),
  }));

/* ───────────────────────────── the schemas ───────────────────────────── */

describe("the schemas are the contract's shapes, exactly", () => {
  it("the contract's own answers parse", () => {
    expect(platformBriefingMembersSchema.safeParse(membersAnswer()).success).toBe(true);
    expect(platformBriefingEventsSchema.safeParse(eventsAnswer()).success).toBe(true);
    expect(platformBriefingChangesSchema.safeParse(changesAnswer()).success).toBe(true);
    expect(platformBriefingOrganizationSchema.safeParse(detailAnswer()).success).toBe(true);
    // An id that names no organization answers null.
    expect(platformBriefingOrganizationSchema.safeParse(null).success).toBe(true);
    // Empty lists, an empty record, and every shape of before and after.
    expect(
      platformBriefingEventsSchema.safeParse(
        eventsAnswer({ organizations: [], oldest_event_at: null }),
      ).success,
    ).toBe(true);
    expect(
      platformBriefingOrganizationSchema.safeParse(
        detailAnswer({
          people: [],
          changes: [
            changeRow({ before: { user_id: ALEX, role: 'admin' }, after: null }),
            changeRow({ before: { owner_user_id: ADMIN }, after: { owner_user_id: ALEX } }),
            changeRow({
              before: { mfa_policy: 'optional' },
              after: { mfa_policy: 'all_required' },
            }),
            changeRow({ before: {}, after: {}, actor_user_id: null, target_user_id: null }),
            changeRow({
              event: 'user.invite.accepted',
              entity_id: null,
              entity_type: null,
              before: null,
              after: null,
              role: 'admin',
              made_as: null,
            }),
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it('the five categories are the ones the events record knows, each with the three outcomes', () => {
    expect(Object.keys(eventsAnswer().no_organization.this_week)).toEqual([
      ...SECURITY_EVENT_CATEGORIES,
    ]);
    const missing = eventsAnswer();
    delete (missing.no_organization.this_week as Record<string, unknown>).malware;
    expect(platformBriefingEventsSchema.safeParse(missing).success).toBe(false);
  });

  it('a key the contract does not name is refused, at every level', () => {
    const cases: Array<[{ safeParse: (v: unknown) => { success: boolean } }, unknown]> = [
      [platformBriefingMembersSchema, membersAnswer({ session_id: 'x' })],
      [
        platformBriefingMembersSchema,
        membersAnswer({ organizations: [memberRow({ owner_email: 'owner@example.com' })] }),
      ],
      [platformBriefingEventsSchema, eventsAnswer({ ip: '203.0.113.9' })],
      [platformBriefingChangesSchema, changesAnswer({ extra: 1 })],
      [platformBriefingOrganizationSchema, detailAnswer({ factor_id: 'x' })],
      [
        platformBriefingOrganizationSchema,
        detailAnswer({ changes_this_week: { ...weekCounts(), admins_joined: 1 } }),
      ],
      [
        platformBriefingOrganizationSchema,
        detailAnswer({
          people: [{ ...(detailAnswer().people as unknown[])[0]!, factor_name: 'Phone' }],
        }),
      ],
      [
        platformBriefingOrganizationSchema,
        detailAnswer({ changes: [changeRow({ ip: '203.0.113.9' })] }),
      ],
      [
        platformBriefingOrganizationSchema,
        detailAnswer({ changes: [changeRow({ before: { role: 'staff', user_agent: 'x' } })] }),
      ],
    ];
    for (const [schema, value] of cases) expect(schema.safeParse(value).success).toBe(false);
  });

  it('every list stops at the cap the database has', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        memberRow({ organization_id: `0b8f6c1e-0000-4000-8000-${String(i).padStart(12, '0')}` }),
      );
    expect(
      platformBriefingMembersSchema.safeParse(membersAnswer({ organizations: many(500) })).success,
    ).toBe(true);
    expect(
      platformBriefingMembersSchema.safeParse(membersAnswer({ organizations: many(501) })).success,
    ).toBe(false);
    const person = (detailAnswer().people as unknown[])[0];
    expect(
      platformBriefingOrganizationSchema.safeParse(
        detailAnswer({ people: Array.from({ length: 201 }, () => person) }),
      ).success,
    ).toBe(false);
    expect(
      platformBriefingOrganizationSchema.safeParse(
        detailAnswer({ changes: Array.from({ length: 201 }, () => changeRow()) }),
      ).success,
    ).toBe(false);
  });

  it("the week's counts are part of the shape: a detail or a changes row without them is refused", () => {
    const { changes_this_week: _gone, ...without } = detailAnswer();
    expect(platformBriefingOrganizationSchema.safeParse(without).success).toBe(false);
    for (const key of Object.keys(weekCounts())) {
      const { [key]: _one, ...short } = weekCounts() as Record<string, unknown>;
      expect(
        platformBriefingOrganizationSchema.safeParse(detailAnswer({ changes_this_week: short }))
          .success,
      ).toBe(false);
      expect(
        platformBriefingChangesSchema.safeParse(changesAnswer({ organizations: [short] })).success,
      ).toBe(false);
    }
    expect(
      platformBriefingOrganizationSchema.safeParse(
        detailAnswer({ changes_this_week: weekCounts({ admins_added_this_week: -1 }) }),
      ).success,
    ).toBe(false);
  });

  it('a count is a whole number that is not negative; a time must be a time', () => {
    expect(
      platformBriefingMembersSchema.safeParse(
        membersAnswer({ organizations: [memberRow({ members: -1 })] }),
      ).success,
    ).toBe(false);
    expect(
      platformBriefingMembersSchema.safeParse(
        membersAnswer({ organizations: [memberRow({ members: '41' })] }),
      ).success,
    ).toBe(false);
    // An event count past 2^31 is fine.
    const big = eventsAnswer();
    big.no_organization.this_week.exploit!.blocked = 5_000_000_000;
    expect(platformBriefingEventsSchema.safeParse(big).success).toBe(true);
    expect(
      platformBriefingEventsSchema.safeParse(eventsAnswer({ oldest_event_at: 'yesterday' }))
        .success,
    ).toBe(false);
  });
});

/* ─────────────────────────── all organizations ─────────────────────────── */

describe('readPlatformSecurityBriefing', () => {
  it('four reads with the service client, and the briefing built from them', async () => {
    const b = await readPlatformSecurityBriefing(NOW);
    expect(stub.rpcCalls).toEqual([
      { name: 'platform_security_briefing_members', args: undefined },
      { name: 'platform_security_briefing_events', args: undefined },
      { name: 'platform_security_briefing_changes', args: undefined },
      { name: 'passkey_account_states', args: { p_rp_id: 'example.test' } },
    ]);
    expect(b.organizations).toEqual([
      {
        organizationId: ORG,
        name: 'Example Academy',
        attention: 'high',
        blockedThisWeek: 28,
        blockedLastWeek: 4,
        flaggedThisWeek: 3,
        adminsWithoutSecondStep: 1,
        membersWithoutSecondStep: 11,
        signInsReported: 0,
        // The database's count of distinct people. Never admins_joined_this_week
        // (1 here) plus admins_promoted (1 here).
        adminsAdded: 2,
        adminsRemoved: 0,
        ownershipMoves: 1,
        policyChanges: 1,
      },
    ]);
    expect(b.totalsLine).toBe(
      '41 accounts in 1 organization. 12 have no second step, 1 of them an owner or admin.',
    );
    // The two passkey reasons, added up over every organization and none.
    expect(b.items.map((i) => i.id)).toEqual(['passkey_unexplained']);
    expect(b.items[0]?.headline).toBe('3 passkey sign-ins did not look right this week');
    expect(b.unchecked).toEqual([]);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('the passkey repair count asks for the account id only, up to its cap', async () => {
    answers.passkey_account_states = ok([{ user_id: ALEX }, { user_id: GONE }]);
    const b = await readPlatformSecurityBriefing(NOW);
    const call = awaited.find((c) => c.table === 'passkey_account_states');
    expect(call?.methods).toEqual(['rpc', 'select', 'limit', 'abortSignal']);
    expect(call?.args[1]).toEqual(['user_id']);
    expect(call?.args[2]).toEqual([PASSKEY_REPAIR_READ_CAP]);
    expect(b.items.map((i) => i.id)).toContain('passkey_setup_needs_repair');
    expect(b.items.find((i) => i.id === 'passkey_setup_needs_repair')?.headline).toBe(
      '2 accounts have a passkey set-up that needs repair',
    );
  });

  it('a full repair read says "or more"', async () => {
    answers.passkey_account_states = ok(
      Array.from({ length: PASSKEY_REPAIR_READ_CAP }, () => ({ user_id: ALEX })),
    );
    const b = await readPlatformSecurityBriefing(NOW);
    expect(b.items.find((i) => i.id === 'passkey_setup_needs_repair')?.headline).toBe(
      '1,000 or more accounts have a passkey set-up that needs repair',
    );
  });

  it('this server has no passkey site: the repair count is not read, and is not a failed check', async () => {
    h.site = null;
    const b = await readPlatformSecurityBriefing(NOW);
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('passkey_account_states');
    expect(b.unchecked).toEqual([]);
    expect(b.goodShape).not.toContain('No passkey set-up needs repair.');
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('each read has its own time budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await readPlatformSecurityBriefing(NOW);
    expect(SECURITY_BRIEFING_READ_BUDGET_MS).toBe(6000);
    expect(timeout.mock.calls).toEqual([[6000], [6000], [6000], [6000]]);
    const signals = timeout.mock.results.map((r) => r.value as AbortSignal);
    // Every read was handed one of those signals, each its own.
    const handed = awaited.map((c) => c.args[c.methods.indexOf('abortSignal')]?.[0]);
    expect(handed).toHaveLength(4);
    expect(new Set(handed).size).toBe(4);
    for (const signal of handed) expect(signals).toContain(signal);
  });

  const FAILURES: Array<{
    fn: string;
    unchecked: string;
    check: (b: Awaited<ReturnType<typeof readPlatformSecurityBriefing>>) => void;
  }> = [
    {
      fn: 'platform_security_briefing_members',
      unchecked: 'Second steps and reported sign-ins could not be checked.',
      check: (b) => {
        expect(b.totalsLine).toBeNull();
        expect(b.organizations[0]).toMatchObject({
          adminsWithoutSecondStep: null,
          membersWithoutSecondStep: null,
          signInsReported: null,
          // The other reads are shown.
          adminsAdded: 2,
          blockedThisWeek: 28,
          policyChanges: 1,
        });
        expect(b.organizationsAllChecked).toBe(false);
      },
    },
    {
      fn: 'platform_security_briefing_events',
      unchecked: 'Blocked and flagged activity could not be checked.',
      check: (b) => {
        expect(b.organizations[0]).toMatchObject({
          blockedThisWeek: null,
          blockedLastWeek: null,
          flaggedThisWeek: null,
          adminsWithoutSecondStep: 1,
          policyChanges: 1,
        });
        expect(b.items.map((i) => i.id)).not.toContain('passkey_unexplained');
        expect(b.goodShape).not.toContain('No passkey sign-in looked wrong this week.');
      },
    },
    {
      fn: 'platform_security_briefing_changes',
      unchecked: 'Admin and sign-in policy changes could not be checked.',
      check: (b) => {
        expect(b.organizations[0]).toMatchObject({
          adminsAdded: null,
          adminsRemoved: null,
          ownershipMoves: null,
          policyChanges: null,
          blockedThisWeek: 28,
          adminsWithoutSecondStep: 1,
        });
        expect(b.organizationsAllChecked).toBe(false);
      },
    },
    {
      fn: 'passkey_account_states',
      unchecked: 'Passkey set-ups that need repair could not be checked.',
      check: (b) => {
        expect(b.goodShape).not.toContain('No passkey set-up needs repair.');
        expect(b.organizations[0]).toMatchObject({ blockedThisWeek: 28, adminsAdded: 2 });
        // Not one of the three organization reads.
        expect(b.organizationsAllChecked).toBe(true);
      },
    },
  ];

  it.each(FAILURES)(
    '$fn failing alone: its part is "could not check", the rest is shown, one report',
    async ({ fn, unchecked, check }) => {
      answers[fn] = { data: null, error: { message: 'canceling statement', code: '57014' } };
      const b = await readPlatformSecurityBriefing(NOW);
      expect(b.unchecked).toEqual([unchecked]);
      check(b);
      expect(reports()).toEqual([
        {
          message: 'canceling statement',
          tag: `platform.security-briefing.${fn}`,
          level: 'warning',
          extra: { code: '57014' },
        },
      ]);
    },
  );

  it.each(FAILURES)(
    '$fn rejecting (a dropped connection, the time budget): the same',
    async ({ fn, unchecked }) => {
      answers[fn] = () => {
        throw new Error('The operation was aborted due to timeout');
      };
      const b = await readPlatformSecurityBriefing(NOW);
      expect(b.unchecked).toEqual([unchecked]);
      expect(reports().map((r) => [r.tag, r.message])).toEqual([
        [`platform.security-briefing.${fn}`, 'The operation was aborted due to timeout'],
      ]);
    },
  );

  it('a function that is not in the database yet (PGRST202) is reported by name', async () => {
    for (const fn of [
      'platform_security_briefing_members',
      'platform_security_briefing_events',
      'platform_security_briefing_changes',
    ]) {
      answers[fn] = {
        data: null,
        error: { message: `Could not find the function public.${fn}`, code: 'PGRST202' },
      };
    }
    const b = await readPlatformSecurityBriefing(NOW);
    expect(b.organizationsChecked).toBe(false);
    expect(b.status).toBe('incomplete');
    expect(reports()).toEqual(
      [
        'platform_security_briefing_members',
        'platform_security_briefing_events',
        'platform_security_briefing_changes',
      ].map((fn) => ({
        message: `${fn} is not in the database yet: the code is ahead of the migration`,
        tag: `platform.security-briefing.${fn}`,
        level: 'warning',
        extra: { code: 'PGRST202' },
      })),
    );
  });

  it('an answer whose shape is not known is "could not check", reported with where and never a value', async () => {
    answers.platform_security_briefing_members = ok(
      membersAnswer({ organizations: [memberRow({ members: 'forty one', secret: 'hunter2' })] }),
    );
    answers.platform_security_briefing_events = ok(null);
    answers.platform_security_briefing_changes = ok({ organizations: 'none' });
    const b = await readPlatformSecurityBriefing(NOW);
    expect(b.unchecked).toEqual([
      'Second steps and reported sign-ins could not be checked.',
      'Blocked and flagged activity could not be checked.',
      'Admin and sign-in policy changes could not be checked.',
    ]);
    expect(b.organizations).toEqual([]);
    const said = reports();
    expect(said.map((r) => r.tag)).toEqual([
      'platform.security-briefing.platform_security_briefing_members',
      'platform.security-briefing.platform_security_briefing_events',
      'platform.security-briefing.platform_security_briefing_changes',
    ]);
    expect(said[0]?.message).toBe(
      'platform_security_briefing_members answered a shape this build does not know (organizations.0.members: invalid_type; organizations.0: unrecognized_keys)',
    );
    for (const r of said) {
      expect(r.message).not.toContain('hunter2');
      expect(r.message).not.toContain('forty one');
    }
  });

  it('never throws, even with no service client: everything is "could not check"', async () => {
    h.clientFails = true;
    const b = await readPlatformSecurityBriefing(NOW);
    expect(b.status).toBe('incomplete');
    expect(b.unchecked).toHaveLength(4);
    expect(b.organizationsChecked).toBe(false);
    expect(reports().map((r) => r.tag)).toEqual(['platform.security-briefing']);
  });

  it('counts only: no name of a person and no email in the answer', async () => {
    const text = JSON.stringify(await readPlatformSecurityBriefing(NOW));
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/Alex|Dana/);
  });
});

/* ───────────────────────────── one organization ───────────────────────────── */

describe('findBriefingOrganization', () => {
  it('one row by id: found with its name', async () => {
    expect(await findBriefingOrganization(ORG)).toEqual({
      found: true,
      id: ORG,
      name: 'Example Academy',
    });
    expect(stub.chainsAll.get('organizations.select')?.[0]).toEqual([
      'select',
      'eq',
      'abortSignal',
    ]);
    expect(stub.chainArgsAll.get('organizations.select')?.[0]?.[1]).toEqual(['id', ORG]);
  });

  it('the lookup has the same time budget as every other read', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await findBriefingOrganization(ORG);
    expect(timeout.mock.calls).toEqual([[SECURITY_BRIEFING_READ_BUDGET_MS]]);
    expect(stub.chainArgsAll.get('organizations.select')?.[0]?.[2]?.[0]).toBe(
      timeout.mock.results[0]?.value,
    );
  });

  it('no such organization: not found, and nothing reported', async () => {
    answers.organizations = ok([]);
    expect(await findBriefingOrganization(ORG)).toEqual({ found: false, failed: false });
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('a failed read: not found and failed, reported, never thrown', async () => {
    answers.organizations = { data: null, error: { message: 'connection reset' } };
    expect(await findBriefingOrganization(ORG)).toEqual({ found: false, failed: true });
    expect(reports().map((r) => r.tag)).toEqual(['platform.security-briefing.organization']);
    h.clientFails = true;
    expect(await findBriefingOrganization(ORG)).toEqual({ found: false, failed: true });
  });
});

describe('readOrganizationSecurityBriefing', () => {
  it('the detail of that organization and its events, each with the time budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { briefing, detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(stub.rpcCalls).toEqual([
      { name: 'platform_security_briefing_for_organization', args: { p_organization_id: ORG } },
      { name: 'platform_security_briefing_events', args: undefined },
    ]);
    // The detail, the events, and the names: one budget each.
    expect(timeout.mock.calls).toEqual([[6000], [6000], [6000]]);
    expect(awaited.map((c) => c.methods)).toEqual([
      ['rpc', 'abortSignal'],
      ['rpc', 'abortSignal'],
    ]);

    expect(briefing.items.map((i) => i.id)).toEqual([
      'admins_without_second_step',
      'members_without_second_step',
      'category_rising:password_guessing',
      'category_flagged:password_guessing',
      'category_flagged:phishing',
      'admin_changes',
    ]);
    expect(
      briefing.categories?.map((c) => [c.category, c.blockedThisWeek, c.blockedChange]),
    ).toEqual([
      ['password_guessing', 25, 'up from 4'],
      ['bots', 3, 'new this week'],
      ['phishing', 0, 'same'],
    ]);
    expect(briefing.idleSignIns).toBe('5 members have 9 sign-ins not used in 30 days.');
    expect(detail).toEqual({
      people: [
        {
          userId: ALEX,
          fullName: 'Alex Example',
          email: 'alex@example.com',
          role: 'admin',
          notes: ['No second step', '2 sign-ins not used in 30 days, the oldest since 3 Oct'],
        },
      ],
      peopleTruncated: false,
      idleAfterDays: 30,
      changes: [
        {
          at: '2026-11-22T18:04:11.52+00:00',
          // Each person with their email: a name is the member's own choice.
          text: 'Alex Example (alex@example.com) was made an admin by Dana Example (dana@example.com).',
        },
      ],
      changesTruncated: false,
      changesRowsRead: 1,
    });
    expect(h.reportError).not.toHaveBeenCalled();
  });

  describe("the week's numbers are the database's own counts, never a count of the list", () => {
    it('a list cut at 200 rows that hides a loosened policy: the briefing still says it was loosened', async () => {
      // A rollout week: 200 staff accept invitations after the policy was
      // loosened. The loosening is older than the 200 newest rows.
      const staffJoins = Array.from({ length: 200 }, (_, i) =>
        changeRow({
          created_at: new Date(NOW - 60_000 * (i + 1)).toISOString(),
          event: 'user.invite.accepted',
          actor_user_id: ALEX,
          target_user_id: null,
          entity_id: null,
          entity_type: null,
          before: null,
          after: null,
          role: 'staff',
          made_as: null,
        }),
      );
      answers.platform_security_briefing_for_organization = ok(
        detailAnswer({
          changes: staffJoins,
          changes_truncated: true,
          changes_this_week: weekCounts({ sign_in_policy_loosened: 1 }),
        }),
      );
      const { briefing, detail } = await readOrganizationSecurityBriefing(ORG, NOW);
      // Nothing in the list...
      expect(detail?.changes).toEqual([]);
      expect(detail?.changesTruncated).toBe(true);
      expect(detail?.changesRowsRead).toBe(200);
      // ...and the week is still told as it was.
      const policy = briefing.items.find((i) => i.id === 'policy_changes');
      expect(policy?.severity).toBe('medium');
      expect(policy?.headline).toBe('The sign-in policy was loosened once this week');
      expect(briefing.goodShape).not.toContain('No admin or sign-in policy change this week.');
      expect(briefing.status).toBe('needs_attention');
    });

    it('"no change this week" comes from the counts alone: a quiet count says it, a list line does not unsay it', async () => {
      answers.platform_security_briefing_for_organization = ok(
        detailAnswer({ changes_this_week: weekCounts() }),
      );
      const { briefing, detail } = await readOrganizationSecurityBriefing(ORG, NOW);
      // The list holds an in-week promotion; the counts are what is said.
      expect(detail?.changes).toHaveLength(1);
      expect(briefing.items.map((i) => i.id)).not.toContain('admin_changes');
      expect(briefing.goodShape).toContain('No admin or sign-in policy change this week.');
    });

    it('a change in the counts and an empty list: still an item', async () => {
      answers.platform_security_briefing_for_organization = ok(
        detailAnswer({
          changes: [],
          changes_this_week: weekCounts({ admins_demoted_or_removed: 2, ownership_moved: 1 }),
        }),
      );
      const { briefing } = await readOrganizationSecurityBriefing(ORG, NOW);
      expect(briefing.items.find((i) => i.id === 'admin_changes')?.headline).toBe(
        '2 admins removed or moved to another role, ownership moved once this week',
      );
    });

    it('admins added is the count of distinct people: never joined plus promoted', async () => {
      // One person who joined as staff on Monday and was made an admin on
      // Wednesday: the members read says 1 joined, the audit rows say 1
      // promoted, and it is one person.
      answers.platform_security_briefing_for_organization = ok(
        detailAnswer({
          admins_joined_this_week: 1,
          changes_this_week: weekCounts({ admins_promoted: 1, admins_added_this_week: 1 }),
        }),
      );
      const { briefing } = await readOrganizationSecurityBriefing(ORG, NOW);
      const item = briefing.items.find((i) => i.id === 'admin_changes');
      expect(item?.headline).toBe('1 admin added this week');
      expect(item?.whatWeSee).toBe('1 member became an admin or the owner.');
      expect(JSON.stringify(item)).not.toMatch(/\b2\b/);
      // The two source numbers alone make no item: only the distinct count does.
      answers.platform_security_briefing_for_organization = ok(
        detailAnswer({
          admins_joined_this_week: 3,
          changes_this_week: weekCounts({ admins_promoted: 4 }),
        }),
      );
      const none = await readOrganizationSecurityBriefing(ORG, NOW);
      expect(none.briefing.items.map((i) => i.id)).not.toContain('admin_changes');
    });
  });

  it('names: one batched read of the real memberships of that organization, then one of those profiles', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    answers.platform_security_briefing_for_organization = ok(
      detailAnswer({
        changes: [
          // Support acting as the organization: a platform administrator, no membership here.
          changeRow({ created_at: '2026-11-22T10:00:00+00:00', actor_user_id: SUPPORT }),
          // Someone who was an admin then and is no member now.
          changeRow({
            created_at: '2026-11-21T10:00:00+00:00',
            actor_user_id: FORMER_ADMIN,
            target_user_id: GONE,
          }),
          // The database's own row: nobody is named as having made it.
          changeRow({
            created_at: '2026-11-20T10:00:00+00:00',
            actor_user_id: null,
            made_as: 'service_role',
            before: { role: 'admin' },
            after: { role: 'manager' },
          }),
          changeRow({
            created_at: '2026-11-19T10:00:00+00:00',
            event: 'user.deactivated',
            target_user_id: null,
            before: { user_id: GONE, role: 'admin' },
            after: null,
          }),
          changeRow({
            created_at: '2026-11-18T10:00:00+00:00',
            event: 'user.deactivated',
            actor_user_id: null,
            target_user_id: null,
            entity_id: GONE,
            entity_type: 'user',
            before: null,
            after: null,
          }),
          changeRow({
            created_at: '2026-11-17T10:00:00+00:00',
            event: 'organization.mfa_policy.changed',
            target_user_id: null,
            entity_type: 'organization',
            before: { mfa_policy: 'all_required' },
            after: { mfa_policy: 'optional' },
          }),
          changeRow({
            created_at: '2026-11-16T10:00:00+00:00',
            actor_user_id: null,
            target_user_id: ADMIN,
            before: { role: 'owner' },
            after: { role: 'admin' },
          }),
          changeRow({
            created_at: '2026-11-16T10:00:00+00:00',
            actor_user_id: null,
            before: { role: 'admin' },
            after: { role: 'owner' },
          }),
        ],
      }),
    );
    const { detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail?.changes.map((c) => c.text)).toEqual([
      'Alex Example (alex@example.com) was made an admin by StockPilot support.',
      'A former member was made an admin by a former member.',
      'Alex Example (alex@example.com) was changed from admin to manager.',
      'A former member, an admin, was removed by Dana Example (dana@example.com).',
      'A member deleted their account.',
      'The sign-in policy was loosened: Required for everyone to Optional by Dana Example (dana@example.com).',
      'Ownership moved from Dana Example (dana@example.com) to Alex Example (alex@example.com).',
    ]);

    // One read of each table for the whole list: the memberships first.
    expect(stub.fromCalls).toEqual(['organization_members', 'user_profiles']);
    const memberMethods = stub.chainsAll.get('organization_members.select')?.[0];
    const memberArgs = stub.chainArgsAll.get('organization_members.select')?.[0];
    expect(memberMethods).toEqual([
      'select',
      'eq',
      'in',
      'not',
      'is',
      'order',
      'range',
      'abortSignal',
    ]);
    // Real memberships only: this organization, accepted, not an act-as seat.
    expect(memberArgs?.[1]).toEqual(['organization_id', ORG]);
    expect([...(memberArgs?.[2]?.[1] as string[])].sort()).toEqual(
      [ADMIN, ALEX, FORMER_ADMIN, GONE, SUPPORT].sort(),
    );
    expect(memberArgs?.[3]).toEqual(['accepted_at', 'is', null]);
    expect(memberArgs?.[4]).toEqual(['impersonation_expires_at', null]);
    // Profiles: the members, and the people who made a change and are not
    // members (to tell support from a former member). Never the profile of
    // someone who is neither: Gone Example is only the subject of a change.
    const profileMethods = stub.chainsAll.get('user_profiles.select')?.[0];
    const profileArgs = stub.chainArgsAll.get('user_profiles.select')?.[0];
    expect(profileMethods).toEqual(['select', 'in', 'order', 'range', 'abortSignal']);
    expect(profileArgs?.[0]).toEqual(['id, full_name, email']);
    expect([...(profileArgs?.[1]?.[1] as string[])].sort()).toEqual(
      [ADMIN, ALEX, FORMER_ADMIN, SUPPORT].sort(),
    );
    // Both under ONE time budget, the same as every other read.
    expect(timeout.mock.calls).toEqual([[6000], [6000], [6000]]);
    const namesSignal = timeout.mock.results[2]?.value as AbortSignal;
    expect(memberArgs?.[7]?.[0]).toBe(namesSignal);
    expect(profileArgs?.[4]?.[0]).toBe(namesSignal);
    // The name a support account chose is never used.
    expect(detail?.changes.map((c) => c.text).join(' ')).not.toContain('Sam Support');
    // The account of the self-deleted member is never looked up.
    expect(detail?.changes.map((c) => c.text).join(' ')).not.toContain('Gone Example');
  });

  it('no change names anyone: no name is read', async () => {
    answers.platform_security_briefing_for_organization = ok(detailAnswer({ changes: [] }));
    const { detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail?.changes).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('a member who names themselves "StockPilot support" is written with their own email, never as support', async () => {
    profiles = profiles.map((p) => (p.id === ALEX ? { ...p, full_name: 'StockPilot support' } : p));
    const loosened = (actor: string, created_at: string) =>
      changeRow({
        created_at,
        event: 'organization.mfa_policy.changed',
        actor_user_id: actor,
        target_user_id: null,
        entity_type: 'organization',
        before: { mfa_policy: 'all_required' },
        after: { mfa_policy: 'optional' },
      });
    answers.platform_security_briefing_for_organization = ok(
      detailAnswer({
        people: [
          {
            user_id: ALEX,
            full_name: 'StockPilot support',
            email: 'alex@example.com',
            role: 'admin',
            has_second_step: false,
            idle_sign_ins: 0,
            oldest_idle_at: null,
          },
        ],
        changes: [
          // The member, as the one who made a change and as the one a change is about.
          loosened(ALEX, '2026-11-22T12:00:00+00:00'),
          changeRow({ created_at: '2026-11-22T11:00:00+00:00', target_user_id: ALEX }),
          // StockPilot's own staff.
          loosened(SUPPORT, '2026-11-22T10:00:00+00:00'),
        ],
      }),
    );
    const { detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    const [byMember, aboutMember, bySupport] = detail!.changes.map((c) => c.text);
    expect(byMember).toBe(
      'The sign-in policy was loosened: Required for everyone to Optional by StockPilot support (alex@example.com).',
    );
    expect(aboutMember).toBe(
      'StockPilot support (alex@example.com) was made an admin by Dana Example (dana@example.com).',
    );
    // The real label: no email beside it, and never a profile's name.
    expect(bySupport).toBe(
      'The sign-in policy was loosened: Required for everyone to Optional by StockPilot support.',
    );
    expect(byMember).not.toBe(bySupport);
    // In People the email rides with the name.
    expect(detail?.people[0]).toMatchObject({
      fullName: 'StockPilot support',
      email: 'alex@example.com',
    });
  });

  it('someone who is no member now and named themselves "StockPilot support" is "a former member": the label is never taken from a name', async () => {
    profiles = profiles.map((p) =>
      p.id === FORMER_ADMIN ? { ...p, full_name: 'StockPilot support' } : p,
    );
    answers.platform_security_briefing_for_organization = ok(
      detailAnswer({ changes: [changeRow({ actor_user_id: FORMER_ADMIN })] }),
    );
    const { detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail?.changes.map((c) => c.text)).toEqual([
      'Alex Example (alex@example.com) was made an admin by a former member.',
    ]);
  });

  it('a member with no name is written by their email alone', async () => {
    profiles = profiles.map((p) => (p.id === ALEX ? { ...p, full_name: '  ' } : p));
    const { detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail?.changes[0]?.text).toBe(
      'alex@example.com was made an admin by Dana Example (dana@example.com).',
    );
  });

  it('an id in an audit row that is not an account id names nobody and is never asked for', async () => {
    answers.platform_security_briefing_for_organization = ok(
      detailAnswer({
        changes: [
          changeRow({
            event: 'user.deactivated',
            target_user_id: null,
            before: { user_id: 'not-an-account-id', role: 'admin' },
            after: null,
          }),
        ],
      }),
    );
    const { detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail?.changes.map((c) => c.text)).toEqual([
      'A former member, an admin, was removed by Dana Example (dana@example.com).',
    ]);
    expect(stub.chainArgsAll.get('organization_members.select')?.[0]?.[2]?.[1]).toEqual([ADMIN]);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it.each(['memberships', 'profiles', 'timeout'] as const)(
    'the names could not be read (%s): the lines say "a member" and name nobody, it is reported, nothing throws',
    async (failure) => {
      namesFail = failure;
      const { briefing, detail } = await readOrganizationSecurityBriefing(ORG, NOW);
      expect(detail?.changes.map((c) => c.text)).toEqual(['A member was made an admin.']);
      expect(reports().map((r) => r.tag)).toEqual(['platform.security-briefing.names']);
      // The rest of the briefing stands.
      expect(detail?.people).toHaveLength(1);
      expect(briefing.items.map((i) => i.id)).toContain('admin_changes');
      // A failed membership read never goes on to read profiles.
      if (failure === 'memberships') expect(stub.fromCalls).toEqual(['organization_members']);
    },
  );

  it('the organization has no event in the two weeks: zeros, and blocked activity is steady', async () => {
    answers.platform_security_briefing_events = ok(eventsAnswer({ organizations: [] }));
    const { briefing } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(briefing.categories).toEqual([]);
    expect(briefing.goodShape).toContain('Blocked activity is steady or down.');
  });

  it('the events list was cut short and the organization is not in it: could not check, never zero', async () => {
    answers.platform_security_briefing_events = ok(
      eventsAnswer({ organizations: [], organizations_truncated: true }),
    );
    const { briefing } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(briefing.categories).toBeNull();
    expect(briefing.unchecked).toContain('Blocked and flagged activity could not be checked.');
  });

  it("another organization's events are never this one's", async () => {
    const other = eventsAnswer();
    (other.organizations as Array<{ organization_id: string }>)[0]!.organization_id = OTHER_ORG;
    answers.platform_security_briefing_events = ok(other);
    const { briefing } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(briefing.categories).toEqual([]);
  });

  it('the detail failing alone: no people and no changes, the events are still shown', async () => {
    answers.platform_security_briefing_for_organization = {
      data: null,
      error: { message: 'Could not find the function', code: 'PGRST202' },
    };
    const { briefing, detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail).toBeNull();
    expect(briefing.unchecked).toEqual([
      'Second steps and reported sign-ins could not be checked.',
      'Admin and sign-in policy changes could not be checked.',
    ]);
    expect(briefing.categories).toHaveLength(3);
    expect(reports()).toEqual([
      {
        message:
          'platform_security_briefing_for_organization is not in the database yet: the code is ahead of the migration',
        tag: 'platform.security-briefing.platform_security_briefing_for_organization',
        level: 'warning',
        extra: { organizationId: ORG, code: 'PGRST202' },
      },
    ]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('the events failing alone: the people and the changes are still shown', async () => {
    answers.platform_security_briefing_events = {
      data: null,
      error: { message: 'canceling statement', code: '57014' },
    };
    const { briefing, detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail?.people).toHaveLength(1);
    expect(briefing.unchecked).toEqual(['Blocked and flagged activity could not be checked.']);
    expect(briefing.items.map((i) => i.id)).toContain('admins_without_second_step');
  });

  it('a detail with a key the contract does not name is "could not check"', async () => {
    answers.platform_security_briefing_for_organization = ok(
      detailAnswer({
        people: [{ ...(detailAnswer().people as unknown[])[0]!, session_id: 'abc' }],
      }),
    );
    const { detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail).toBeNull();
    expect(reports()[0]?.message).toBe(
      'platform_security_briefing_for_organization answered a shape this build does not know (people.0: unrecognized_keys)',
    );
  });

  it('the database answers null (the organization is gone): could not check, not a zero', async () => {
    answers.platform_security_briefing_for_organization = ok(null);
    const { briefing, detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail).toBeNull();
    expect(briefing.unchecked).toContain(
      'Second steps and reported sign-ins could not be checked.',
    );
  });

  it('never throws, even with no service client', async () => {
    h.clientFails = true;
    const { briefing, detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail).toBeNull();
    expect(briefing.status).toBe('incomplete');
    expect(reports().map((r) => r.tag)).toEqual(['platform.security-briefing.for-organization']);
  });
});
