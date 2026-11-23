import 'server-only';

import { z } from 'zod';

import { passkeyRelyingParty } from '@/lib/auth/passkey-relying-party';
import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds, rawErrorText } from '@/server/services/lib/fetch-by-ids';

import {
  BRIEFING_FORMER_MEMBER,
  BRIEFING_SUPPORT_ACTOR,
  BRIEFING_WEEK_DAYS,
  briefingPersonNotes,
  buildPlatformSecurityBriefing,
  buildSecurityBriefing,
  countBriefingChanges,
  describeBriefingChange,
  extractBriefingChanges,
  type BriefingChange,
  type BriefingChangeCounts,
  type BriefingEventsInput,
  type BriefingMembersInput,
  type BriefingWeekCounts,
  type PlatformBriefingRepairInput,
  type PlatformSecurityBriefing,
  type SecurityBriefing,
} from '@stockpilot/core';

/**
 * The platform console's security briefing (migration
 * platform_security_briefing): what happened this week across every
 * organization, and one organization's detail.
 *
 * Read with the service client: the four functions are granted to
 * service_role only. So this module has no gate of its own, like its sibling
 * platform services: the one page that imports it calls
 * requirePlatformAdmin() first (security-briefing.callers.test.ts pins the
 * importer; test/page-step-up.guard.test.ts rule 3 pins the gate).
 *
 * Every read stands alone. Each has its own time budget, is checked against
 * its schema, and on any failure (the function missing because the code is
 * ahead of the migration, a timeout, a shape this build does not know)
 * becomes null and is reported once. The rules in core turn a null into
 * "could not check", never into a zero. Nothing here throws: the console has
 * no error page, and this section sits on the page that holds the passkey
 * kill switch.
 */

/** How long one read may take before the page gives up on it. */
export const SECURITY_BRIEFING_READ_BUDGET_MS = 6000;

/** The most accounts the passkey repair count reads; past it the page says "or more". */
export const PASSKEY_REPAIR_READ_CAP = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ───────────────────────── the database's answers ───────────────────────── */

/** A count: a whole number, never negative. Event counts can pass 2^31. */
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/** A time as Postgres writes a timestamptz into jsonb. */
const time = z
  .string()
  .max(64)
  .refine((v) => Number.isFinite(Date.parse(v)));

/** One organization's member counts: the same eleven keys in the members read and the detail. */
const memberCounts = {
  organization_id: uuid,
  name: z.string(),
  mfa_policy: z.string(),
  members: count,
  admins: count,
  without_second_step: count,
  admins_without_second_step: count,
  members_with_idle_sign_ins: count,
  idle_sign_ins: count,
  admins_joined_this_week: count,
  sign_ins_reported_this_week: count,
};

/** Every list below is capped by the database at the same number. */
const MAX_ORGANIZATIONS = 500;
const MAX_PEOPLE = 200;
const MAX_CHANGES = 200;

export const platformBriefingMembersSchema = z
  .object({
    organizations: z.array(z.object(memberCounts).strict()).max(MAX_ORGANIZATIONS),
    organizations_truncated: z.boolean(),
    totals: z
      .object({
        organizations: count,
        accounts: count,
        accounts_without_second_step: count,
        admin_accounts_without_second_step: count,
      })
      .strict(),
    idle_after_days: count,
  })
  .strict();

const outcomes = z.object({ blocked: count, flagged: count, allowed: count }).strict();
/** Always the five categories, zeros included. */
const week = z
  .object({
    password_guessing: outcomes,
    exploit: outcomes,
    bots: outcomes,
    phishing: outcomes,
    malware: outcomes,
  })
  .strict();
const eventCounts = {
  this_week: week,
  last_week: week,
  passkey_unexplained_sign_in_this_week: count,
  passkey_counter_went_back_this_week: count,
};

export const platformBriefingEventsSchema = z
  .object({
    organizations: z
      .array(z.object({ organization_id: uuid, ...eventCounts }).strict())
      .max(MAX_ORGANIZATIONS),
    organizations_truncated: z.boolean(),
    no_organization: z.object(eventCounts).strict(),
    oldest_event_at: time.nullable(),
  })
  .strict();

export const platformBriefingChangesSchema = z
  .object({
    organizations: z
      .array(
        z
          .object({
            organization_id: uuid,
            admins_promoted: count,
            admins_demoted_or_removed: count,
            ownership_moved: count,
            sign_in_policy_loosened: count,
            sign_in_policy_tightened: count,
            sign_in_policy_changed_other: count,
          })
          .strict(),
      )
      .max(MAX_ORGANIZATIONS),
    organizations_truncated: z.boolean(),
  })
  .strict();

/** An audit row's before or after, narrowed by the database to these four keys. */
const narrowed = z
  .object({
    role: z.string().max(64).optional(),
    mfa_policy: z.string().max(64).optional(),
    user_id: z.string().max(64).optional(),
    owner_user_id: z.string().max(64).optional(),
  })
  .strict()
  .nullable();

/** Null when the id names no organization. */
export const platformBriefingOrganizationSchema = z
  .object({
    ...memberCounts,
    idle_after_days: count,
    people: z
      .array(
        z
          .object({
            user_id: uuid,
            full_name: z.string().nullable(),
            email: z.string(),
            role: z.string(),
            has_second_step: z.boolean(),
            idle_sign_ins: count,
            oldest_idle_at: time.nullable(),
          })
          .strict(),
      )
      .max(MAX_PEOPLE),
    people_truncated: z.boolean(),
    changes: z
      .array(
        z
          .object({
            created_at: time,
            event: z.string(),
            actor_user_id: uuid.nullable(),
            target_user_id: uuid.nullable(),
            entity_id: z.string().nullable(),
            entity_type: z.string().nullable(),
            before: narrowed,
            after: narrowed,
            role: z.string().nullable(),
            already_member: z.boolean(),
            made_as: z.string().nullable(),
          })
          .strict(),
      )
      .max(MAX_CHANGES),
    changes_truncated: z.boolean(),
  })
  .strict()
  .nullable();

/* ─────────────────────────────── one read ─────────────────────────────── */

type Read<T> = { ok: true; value: T } | { ok: false };

interface Answer {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/**
 * One read with its own time budget. Never throws: any failure is reported
 * once, as a warning, under the read's own tag, and answered as not ok.
 *
 * `Database = any`, so a misspelt function name or a function that is not in
 * the database yet (PGRST202: the code is ahead of the migration) compiles
 * and fails only here. It is said in the report by name, as the Users tab's
 * activity read does.
 */
async function read<T>(
  /** The database function asked, for the report. */
  fn: string,
  schema: z.ZodType<T>,
  call: (signal: AbortSignal) => PromiseLike<Answer>,
  extra: Record<string, string> = {},
): Promise<Read<T>> {
  const fail = async (problem: unknown, code?: string): Promise<Read<T>> => {
    await reportError(problem instanceof Error ? problem : new Error(rawErrorText(problem)), {
      tag: `platform.security-briefing.${fn}`,
      level: 'warning',
      extra: { ...extra, code: code ?? null },
    });
    return { ok: false };
  };
  try {
    const { data, error } = await call(AbortSignal.timeout(SECURITY_BRIEFING_READ_BUDGET_MS));
    if (error) {
      if (error.code === 'PGRST202') {
        return await fail(
          new Error(`${fn} is not in the database yet: the code is ahead of the migration`),
          error.code,
        );
      }
      return await fail(new Error(error.message), error.code);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      // Where the shape differs, never a value from the answer.
      const where = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
        .join('; ');
      return await fail(new Error(`${fn} answered a shape this build does not know (${where})`));
    }
    return { ok: true, value: parsed.data };
  } catch (err) {
    return await fail(err);
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;

function readEvents(admin: AdminClient) {
  return read('platform_security_briefing_events', platformBriefingEventsSchema, (signal) =>
    admin.rpc('platform_security_briefing_events').abortSignal(signal),
  );
}

/* ─────────────────────────── database to core ─────────────────────────── */

type MemberCounts = z.infer<z.ZodObject<typeof memberCounts>>;

function membersInput(row: MemberCounts, idleAfterDays: number): BriefingMembersInput {
  return {
    mfaPolicy: row.mfa_policy,
    members: row.members,
    admins: row.admins,
    withoutSecondStep: row.without_second_step,
    adminsWithoutSecondStep: row.admins_without_second_step,
    membersWithIdleSignIns: row.members_with_idle_sign_ins,
    idleSignIns: row.idle_sign_ins,
    idleAfterDays,
    adminsJoinedThisWeek: row.admins_joined_this_week,
    signInsReportedThisWeek: row.sign_ins_reported_this_week,
  };
}

const NO_EVENTS: BriefingWeekCounts = {};

/* ─────────────────────────── all organizations ─────────────────────────── */

/**
 * How many accounts have a passkey set-up that is not healthy, for the site
 * this server serves. 'not_configured' when this server has no passkey site
 * (a preview, a machine with another project's settings): there is nothing
 * to check. Only the account id is asked for: never a factor id.
 */
async function readPasskeyRepair(
  admin: AdminClient,
): Promise<PlatformBriefingRepairInput | 'not_configured' | null> {
  const site = passkeyRelyingParty();
  if (!site) return 'not_configured';
  const answer = await read(
    'passkey_account_states',
    z.array(z.object({ user_id: uuid })).max(PASSKEY_REPAIR_READ_CAP),
    (signal) =>
      admin
        .rpc('passkey_account_states', { p_rp_id: site.rpId })
        .select('user_id')
        .limit(PASSKEY_REPAIR_READ_CAP)
        .abortSignal(signal),
  );
  if (!answer.ok) return null;
  return {
    accounts: answer.value.length,
    capped: answer.value.length >= PASSKEY_REPAIR_READ_CAP,
  };
}

/**
 * The briefing across every organization: counts only, never a person's name
 * or email. Four reads in parallel, each failing alone. Never throws: a
 * failure outside the reads (no service client) is reported and answered as
 * a briefing in which nothing could be checked.
 */
export async function readPlatformSecurityBriefing(
  now: number = Date.now(),
): Promise<PlatformSecurityBriefing> {
  try {
    return await readEveryOrganization(now);
  } catch (err) {
    await reportError(new Error(rawErrorText(err)), {
      tag: 'platform.security-briefing',
      level: 'warning',
    });
    return buildPlatformSecurityBriefing({
      now,
      members: null,
      events: null,
      changes: null,
      passkeyRepair: null,
    });
  }
}

async function readEveryOrganization(now: number): Promise<PlatformSecurityBriefing> {
  const admin = createAdminClient();
  const [members, events, changes, passkeyRepair] = await Promise.all([
    read('platform_security_briefing_members', platformBriefingMembersSchema, (signal) =>
      admin.rpc('platform_security_briefing_members').abortSignal(signal),
    ),
    readEvents(admin),
    read('platform_security_briefing_changes', platformBriefingChangesSchema, (signal) =>
      admin.rpc('platform_security_briefing_changes').abortSignal(signal),
    ),
    readPasskeyRepair(admin),
  ]);

  return buildPlatformSecurityBriefing({
    now,
    members: members.ok
      ? {
          organizations: members.value.organizations.map((o) => ({
            organizationId: o.organization_id,
            name: o.name,
            ...membersInput(o, members.value.idle_after_days),
          })),
          truncated: members.value.organizations_truncated,
          totalOrganizations: members.value.totals.organizations,
          accounts: members.value.totals.accounts,
          accountsWithoutSecondStep: members.value.totals.accounts_without_second_step,
          adminAccountsWithoutSecondStep: members.value.totals.admin_accounts_without_second_step,
        }
      : null,
    events: events.ok
      ? {
          organizations: events.value.organizations.map((o) => ({
            organizationId: o.organization_id,
            thisWeek: o.this_week,
            lastWeek: o.last_week,
          })),
          truncated: events.value.organizations_truncated,
          noOrganization: {
            thisWeek: events.value.no_organization.this_week,
            lastWeek: events.value.no_organization.last_week,
          },
          // In any organization or none.
          passkeyUnexplainedSignIns: events.value.organizations.reduce(
            (sum, o) => sum + o.passkey_unexplained_sign_in_this_week,
            events.value.no_organization.passkey_unexplained_sign_in_this_week,
          ),
          passkeyCountersWentBack: events.value.organizations.reduce(
            (sum, o) => sum + o.passkey_counter_went_back_this_week,
            events.value.no_organization.passkey_counter_went_back_this_week,
          ),
          oldestEventAt: events.value.oldest_event_at,
        }
      : null,
    changes: changes.ok
      ? {
          organizations: changes.value.organizations.map((o) => ({
            organizationId: o.organization_id,
            adminsPromoted: o.admins_promoted,
            adminsDemotedOrRemoved: o.admins_demoted_or_removed,
            ownershipMoved: o.ownership_moved,
            policyLoosened: o.sign_in_policy_loosened,
            policyTightened: o.sign_in_policy_tightened,
            policyChangedOther: o.sign_in_policy_changed_other,
          })),
          truncated: changes.value.organizations_truncated,
        }
      : null,
    passkeyRepair,
  });
}

/* ───────────────────────────── one organization ───────────────────────────── */

/** The organization a briefing is asked for, checked before anything else is read. */
export type BriefingOrganization =
  | { found: true; id: string; name: string }
  /** `failed`: the read itself failed (reported), so it is not known. */
  | { found: false; failed: boolean };

/**
 * Whether the id names an organization, and its name: one row, so the page
 * can refuse an unknown id before it writes its audit row. Never throws.
 */
export async function findBriefingOrganization(
  organizationId: string,
): Promise<BriefingOrganization> {
  try {
    const { data, error } = await createAdminClient()
      .from('organizations')
      .select('id, name')
      .eq('id', organizationId)
      .abortSignal(AbortSignal.timeout(SECURITY_BRIEFING_READ_BUDGET_MS))
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { id?: unknown; name?: unknown } | null;
    if (!row || typeof row.id !== 'string') return { found: false, failed: false };
    return { found: true, id: row.id, name: typeof row.name === 'string' ? row.name : row.id };
  } catch (err) {
    await reportError(new Error(rawErrorText(err)), {
      tag: 'platform.security-briefing.organization',
      level: 'warning',
      extra: { organizationId },
    });
    return { found: false, failed: true };
  }
}

export interface OrganizationBriefingPerson {
  userId: string;
  fullName: string | null;
  email: string;
  role: string;
  /** "No second step", "2 sign-ins not used in 30 days, the oldest since 3 Oct". */
  notes: string[];
}

export interface OrganizationBriefingChange {
  at: string;
  /** The change in one sentence, with the names resolved. */
  text: string;
}

export interface OrganizationSecurityBriefing {
  briefing: SecurityBriefing;
  /** Null when the organization's detail could not be read. */
  detail: {
    people: OrganizationBriefingPerson[];
    peopleTruncated: boolean;
    /** Admin and sign-in policy changes of 30 days, newest first. */
    changes: OrganizationBriefingChange[];
    changesTruncated: boolean;
  } | null;
}

interface ChangeNames {
  /** The display name of an account that is a member of the organization now. */
  members: Map<string, string>;
  /** Accounts that are not members now and are platform administrators. */
  support: Set<string>;
}

/** Every account a change names. */
function accountsIn(changes: readonly BriefingChange[]): string[] {
  const ids = new Set<string>();
  const add = (id: string | null) => {
    if (id) ids.add(id);
  };
  for (const c of changes) {
    if (c.kind === 'account_deleted') continue;
    add(c.actorUserId);
    if (c.kind === 'ownership_moved') {
      add(c.fromUserId);
      add(c.toUserId);
    } else if (c.kind !== 'policy_changed') {
      add(c.subjectUserId);
    }
  }
  return [...ids];
}

/**
 * Who the changes name, by account id: one batched read of the profiles and
 * one of the organization's real memberships (accepted, not an act-as seat:
 * the rule every console reader uses). Null when either read failed
 * (reported): the lines are then written without names.
 */
async function readChangeNames(
  admin: AdminClient,
  organizationId: string,
  ids: string[],
): Promise<ChangeNames | null> {
  const names: ChangeNames = { members: new Map(), support: new Set() };
  if (ids.length === 0) return names;
  try {
    const [profiles, memberships] = await Promise.all([
      fetchAllRowsByIds<{ id?: unknown; full_name?: unknown; email?: unknown }>(
        ids,
        (batch) => (from, to) =>
          admin
            .from('user_profiles')
            .select('id, full_name, email')
            .in('id', batch)
            .order('id')
            .range(from, to),
        { requireList: 'user_profiles' },
      ),
      fetchAllRowsByIds<{ user_id?: unknown }>(
        ids,
        (batch) => (from, to) =>
          admin
            .from('organization_members')
            .select('id, user_id')
            .eq('organization_id', organizationId)
            .in('user_id', batch)
            .not('accepted_at', 'is', null)
            .is('impersonation_expires_at', null)
            .order('id')
            .range(from, to),
        { requireList: 'organization_members' },
      ),
    ]);
    const isMember = new Set(
      memberships.flatMap((m) => (typeof m.user_id === 'string' ? [m.user_id] : [])),
    );
    for (const p of profiles) {
      if (typeof p.id !== 'string') continue;
      const email = typeof p.email === 'string' && p.email.length > 0 ? p.email : null;
      if (isMember.has(p.id)) {
        const fullName =
          typeof p.full_name === 'string' && p.full_name.trim().length > 0
            ? p.full_name.trim()
            : null;
        const name = fullName ?? email;
        if (name) names.members.set(p.id, name);
      } else if (isPlatformAdmin(email)) {
        names.support.add(p.id);
      }
    }
    return names;
  } catch (err) {
    await reportError(new Error(rawErrorText(err)), {
      tag: 'platform.security-briefing.names',
      level: 'warning',
      extra: { organizationId, count: ids.length },
    });
    return null;
  }
}

/**
 * One change as its sentence. A person who is a member now is named. One
 * who is not is "a former member", or "StockPilot support" when the one who
 * made the change is a platform administrator with no membership there
 * (support acting as the organization). When the names could not be read, a
 * person is "a member" and nobody is said to have made the change.
 */
function changeText(change: BriefingChange, names: ChangeNames | null): string {
  if (change.kind === 'account_deleted') return describeBriefingChange(change);
  const person = (id: string | null): string =>
    names === null ? 'a member' : ((id && names.members.get(id)) ?? BRIEFING_FORMER_MEMBER);
  const actorId = change.actorUserId;
  const actor =
    names === null || actorId === null
      ? null
      : (names.members.get(actorId) ??
        (names.support.has(actorId) ? BRIEFING_SUPPORT_ACTOR : BRIEFING_FORMER_MEMBER));
  if (change.kind === 'policy_changed') return describeBriefingChange(change, { actor });
  if (change.kind === 'ownership_moved') {
    return describeBriefingChange(change, {
      actor,
      from: change.fromUserId ? person(change.fromUserId) : null,
      to: change.toUserId ? person(change.toUserId) : null,
    });
  }
  return describeBriefingChange(change, { actor, subject: person(change.subjectUserId) });
}

/**
 * One organization's briefing for the console: its counts, the members who
 * need a look (by name and email), and its admin and sign-in policy changes
 * of 30 days.
 *
 * THE CALLER WRITES THE viewed_org AUDIT ROW BEFORE CALLING THIS: it shows
 * named members' sign-in state across a tenant boundary. Never throws.
 */
export async function readOrganizationSecurityBriefing(
  organizationId: string,
  now: number = Date.now(),
): Promise<OrganizationSecurityBriefing> {
  try {
    return await readOneOrganization(organizationId, now);
  } catch (err) {
    await reportError(new Error(rawErrorText(err)), {
      tag: 'platform.security-briefing.for-organization',
      level: 'warning',
      extra: { organizationId },
    });
    return {
      briefing: buildSecurityBriefing({ now, members: null, events: null, changes: null }),
      detail: null,
    };
  }
}

async function readOneOrganization(
  organizationId: string,
  now: number,
): Promise<OrganizationSecurityBriefing> {
  const admin = createAdminClient();
  const [detailRead, eventsRead] = await Promise.all([
    read(
      'platform_security_briefing_for_organization',
      platformBriefingOrganizationSchema,
      (signal) =>
        admin
          .rpc('platform_security_briefing_for_organization', {
            p_organization_id: organizationId,
          })
          .abortSignal(signal),
      { organizationId },
    ),
    // The all-organizations events read, this organization picked out of it.
    readEvents(admin),
  ]);
  // A null answer means the id names no organization. The page has already
  // found it, so that is a read that did not answer, not a zero.
  const detail = detailRead.ok ? detailRead.value : null;

  let events: BriefingEventsInput | null = null;
  if (eventsRead.ok) {
    const own = eventsRead.value.organizations.find((o) => o.organization_id === organizationId);
    if (own) {
      events = {
        thisWeek: own.this_week,
        lastWeek: own.last_week,
        oldestEventAt: eventsRead.value.oldest_event_at,
      };
    } else if (!eventsRead.value.organizations_truncated) {
      // Not listed, and the list was not cut short: no event in the two weeks.
      events = {
        thisWeek: NO_EVENTS,
        lastWeek: NO_EVENTS,
        oldestEventAt: eventsRead.value.oldest_event_at,
      };
    }
  }

  let changeCounts: BriefingChangeCounts | null = null;
  let people: OrganizationBriefingPerson[] = [];
  let changes: OrganizationBriefingChange[] = [];
  if (detail) {
    const listed = extractBriefingChanges(
      detail.changes.map((row) => ({
        createdAt: row.created_at,
        event: row.event,
        actorUserId: row.actor_user_id,
        targetUserId: row.target_user_id,
        entityId: row.entity_id,
        entityType: row.entity_type,
        before: row.before,
        after: row.after,
        role: row.role,
        alreadyMember: row.already_member,
        madeAs: row.made_as,
      })),
    );
    changeCounts = countBriefingChanges(listed, now - BRIEFING_WEEK_DAYS * DAY_MS);
    const names = await readChangeNames(admin, organizationId, accountsIn(listed));
    changes = listed.map((change) => ({ at: change.at, text: changeText(change, names) }));
    people = detail.people.map((p) => ({
      userId: p.user_id,
      fullName: p.full_name,
      email: p.email,
      role: p.role,
      notes: briefingPersonNotes(
        {
          userId: p.user_id,
          fullName: p.full_name,
          email: p.email,
          role: p.role,
          hasSecondStep: p.has_second_step,
          idleSignIns: p.idle_sign_ins,
          oldestIdleAt: p.oldest_idle_at,
        },
        { now, idleAfterDays: detail.idle_after_days },
      ),
    }));
  }

  return {
    briefing: buildSecurityBriefing({
      now,
      members: detail ? membersInput(detail, detail.idle_after_days) : null,
      events,
      changes: changeCounts,
    }),
    detail: detail
      ? {
          people,
          peopleTruncated: detail.people_truncated,
          changes,
          changesTruncated: detail.changes_truncated,
        }
      : null,
  };
}
