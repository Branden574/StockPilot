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
 * organization: the names in the changes come from one batched read of the
 * profiles and one of the organization's real memberships; a platform
 * administrator with no membership there is "StockPilot support", anyone
 * else who is no member now is "a former member". Made-up people only.
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
    },
  ],
  organizations_truncated: false,
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
  changes: [changeRow()],
  changes_truncated: false,
  ...over,
});

type Answer = { data: unknown; error: { message: string; code?: string } | null };
const ok = (data: unknown): Answer => ({ data, error: null });

let answers: Record<string, Answer | (() => Answer)>;
let profiles: Array<Record<string, unknown>>;
let memberships: Array<Record<string, unknown>>;
let namesFail: boolean;
/** Every rpc chain as it was awaited. */
let awaited: MockCall[];

const rpc = (fn: string) => (call: MockCall) => {
  if (call.methods.includes('abortSignal')) awaited.push(call);
  const answer = answers[fn];
  if (!answer) throw new Error(`no answer for ${fn}`);
  return typeof answer === 'function' ? answer() : answer;
};

const stub = makeSupabaseStub({
  'rpc:platform_security_briefing_members': rpc('platform_security_briefing_members'),
  'rpc:platform_security_briefing_events': rpc('platform_security_briefing_events'),
  'rpc:platform_security_briefing_changes': rpc('platform_security_briefing_changes'),
  'rpc:platform_security_briefing_for_organization': rpc(
    'platform_security_briefing_for_organization',
  ),
  'rpc:passkey_account_states': rpc('passkey_account_states'),
  'user_profiles.select': (call) =>
    namesFail
      ? { data: null, error: { message: 'profiles unreadable' } }
      : servedLikePostgrest(profiles)(call),
  'organization_members.select': (call) => servedLikePostgrest(memberships)(call),
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
        adminChanges: 3,
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
      unchecked: 'Second steps, reported sign-ins and new admins could not be checked.',
      check: (b) => {
        expect(b.totalsLine).toBeNull();
        expect(b.organizations[0]).toMatchObject({
          adminsWithoutSecondStep: null,
          membersWithoutSecondStep: null,
          signInsReported: null,
          adminChanges: null,
          // The other reads are shown.
          blockedThisWeek: 28,
          policyChanges: 1,
        });
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
          adminChanges: null,
          policyChanges: null,
          blockedThisWeek: 28,
          adminsWithoutSecondStep: 1,
        });
      },
    },
    {
      fn: 'passkey_account_states',
      unchecked: 'Passkey set-ups that need repair could not be checked.',
      check: (b) => {
        expect(b.goodShape).not.toContain('No passkey set-up needs repair.');
        expect(b.organizations[0]).toMatchObject({ blockedThisWeek: 28, adminChanges: 3 });
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
      'Second steps, reported sign-ins and new admins could not be checked.',
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
    expect(timeout.mock.calls).toEqual([[6000], [6000]]);
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
      changes: [
        {
          at: '2026-11-22T18:04:11.52+00:00',
          text: 'Alex Example was made an admin by Dana Example.',
        },
      ],
      changesTruncated: false,
    });
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("the week's admin changes are counted from the list: a change 8 days old is listed, not counted", async () => {
    answers.platform_security_briefing_for_organization = ok(
      detailAnswer({
        admins_joined_this_week: 0,
        changes: [changeRow({ created_at: '2026-11-15T11:59:59+00:00' })],
      }),
    );
    const old = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(old.detail?.changes).toHaveLength(1);
    expect(old.briefing.items.map((i) => i.id)).not.toContain('admin_changes');

    answers.platform_security_briefing_for_organization = ok(
      detailAnswer({
        admins_joined_this_week: 0,
        changes: [changeRow({ created_at: '2026-11-16T12:00:00+00:00' })],
      }),
    );
    const inWeek = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(inWeek.briefing.items.map((i) => i.id)).toContain('admin_changes');
  });

  it('names: one batched read of the profiles, one of the real memberships of that organization', async () => {
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
      'Alex Example was made an admin by StockPilot support.',
      'A former member was made an admin by a former member.',
      'Alex Example was changed from admin to manager.',
      'A former member, an admin, was removed by Dana Example.',
      'A member deleted their account.',
      'The sign-in policy was loosened: Required for everyone to Optional by Dana Example.',
      'Ownership moved from Dana Example to Alex Example.',
    ]);

    // One read of each table for the whole list.
    expect(stub.fromCalls).toEqual(['user_profiles', 'organization_members']);
    const profileChain = stub.chainArgsAll.get('user_profiles.select')?.[0];
    expect(profileChain?.[0]).toEqual(['id, full_name, email']);
    expect([...(profileChain?.[1]?.[1] as string[])].sort()).toEqual(
      [ADMIN, ALEX, FORMER_ADMIN, GONE, SUPPORT].sort(),
    );
    const memberMethods = stub.chainsAll.get('organization_members.select')?.[0];
    const memberArgs = stub.chainArgsAll.get('organization_members.select')?.[0];
    expect(memberMethods).toEqual(['select', 'eq', 'in', 'not', 'is', 'order', 'range']);
    // Real memberships only: this organization, accepted, not an act-as seat.
    expect(memberArgs?.[1]).toEqual(['organization_id', ORG]);
    expect(memberArgs?.[3]).toEqual(['accepted_at', 'is', null]);
    expect(memberArgs?.[4]).toEqual(['impersonation_expires_at', null]);
    // The account of the self-deleted member is never looked up.
    expect(detail?.changes.map((c) => c.text).join(' ')).not.toContain('Gone Example');
  });

  it('no change names anyone: no name is read', async () => {
    answers.platform_security_briefing_for_organization = ok(detailAnswer({ changes: [] }));
    const { detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail?.changes).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('the names could not be read: the lines name nobody, it is reported, nothing throws', async () => {
    namesFail = true;
    const { detail } = await readOrganizationSecurityBriefing(ORG, NOW);
    expect(detail?.changes.map((c) => c.text)).toEqual(['A member was made an admin.']);
    expect(reports().map((r) => r.tag)).toEqual(['platform.security-briefing.names']);
  });

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
      'Second steps, reported sign-ins and new admins could not be checked.',
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
      'Second steps, reported sign-ins and new admins could not be checked.',
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
