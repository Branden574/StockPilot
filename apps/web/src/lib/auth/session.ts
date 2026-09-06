import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { SESSION_HEADER_USER_EMAIL, SESSION_HEADER_USER_ID } from '@/lib/supabase/middleware';
import { loadEffectivePermissions } from '@/lib/auth/effective-permissions';
import {
  assertAccountActiveOrRedirect,
  resolveAccountStatus,
  type AccountStatusRow,
} from '@/lib/auth/account-status';

import type { Permission, Role } from '@stockpilot/core';

export interface ServerSession {
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  defaultOrganizationId: string | null;
}

export interface OrgContext extends ServerSession {
  organizationId: string;
  organizationName: string;
  role: Role;
  /**
   * Effective permission set = static role defaults with org-level role +
   * per-user overrides applied. Consult via `can(ctx, perm)` for every
   * request-scoped gate so configurable overrides take effect. Computed once
   * per request (this fn is React.cache()d). Optional only so synthetic
   * contexts elsewhere stay valid — requireOrgContext always sets it; when
   * absent `can()` falls back to the static role defaults.
   */
  permissions?: Set<Permission>;
}

/**
 * One accepted org membership of the current user, shaped for the org
 * switcher. Derived from loadSessionAndContext's single membership
 * query (cold-start plan rank 8) — the dashboard layout used to issue
 * a THIRD organization_members query per render just to get logo_url.
 */
export interface SessionMembership {
  organizationId: string;
  role: Role;
  name: string;
  logoUrl: string | null;
}

interface LoadedContext {
  session: ServerSession | null;
  orgRole: Role | null;
  orgId: string | null;
  orgName: string | null;
  memberships: SessionMembership[];
}

function pickOrgName(
  orgs: { name: string } | { name: string }[] | null | undefined,
): string | null {
  if (!orgs) return null;
  if (Array.isArray(orgs)) return orgs[0]?.name ?? null;
  return orgs.name ?? null;
}

/**
 * Loads user, profile, active membership, and active org name in
 * **one** parallel-pair Supabase round trip. The user id comes from a
 * request header set by the proxy after session verification
 * (auth.getClaims() local JWT verify, auth.getUser() fallback — see
 * lib/supabase/middleware.ts).
 *
 * Wrapped in React.cache() so every consumer in the same render shares
 * one fetch — layout, page, and every service. Layouts no longer need
 * their own membership query.
 */
const loadSessionAndContext = cache(async (): Promise<LoadedContext> => {
  const h = await headers();
  const userId = h.get(SESSION_HEADER_USER_ID);
  if (!userId) {
    return { session: null, orgRole: null, orgId: null, orgName: null, memberships: [] };
  }

  const email = h.get(SESSION_HEADER_USER_EMAIL) ?? '';
  const supabase = await createClient();

  // Memberships are fetched WITHOUT a limit(1) on purpose (perf plan
  // 2026-07-02 P1e): the old shape grabbed ONE arbitrary membership and,
  // whenever it wasn't the user's default org, issued a SECOND sequential
  // membership query — a per-request penalty for every multi-org user on
  // every dashboard render. A user's accepted memberships are a handful of
  // tiny rows; fetching them all and picking in JS costs the same single
  // round-trip for everyone.
  const [profileRes, membersRes] = await Promise.all([
    supabase
      .from('user_profiles')
      // disabled_at rides this EXISTING select for free — the row is already
      // fetched by primary key on every authenticated render, so the
      // platform-wide account-disable check costs zero extra round trips here.
      .select('id, email, full_name, avatar_url, default_organization_id, disabled_at')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('organization_members')
      // id + logo_url ride along (rank 8) so the dashboard layout's org
      // switcher derives from THIS query instead of issuing its own
      // organization_members query per render. Widened columns only —
      // filters/limits are unchanged, so the membership-selection (and
      // therefore permission-floor) semantics are identical.
      .select('organization_id, role, organizations:organization_id (id, name, logo_url)')
      .eq('user_id', userId)
      .not('accepted_at', 'is', null),
  ]);

  const profile = profileRes.data as
    | {
        id: string;
        email: string;
        full_name: string | null;
        avatar_url: string | null;
        default_organization_id: string | null;
        disabled_at: string | null;
      }
    | null;

  // Account-status gate (install point 1 of 3). This covers every RSC page and
  // every org-scoped Server Action, inherited by all ~128 requireOrgContext and
  // ~166 withContext call sites without touching any of them.
  //
  // It is safe to redirect from inside this cache()d loader precisely because
  // `userId` can only come from the proxy-set header: an /api route never has
  // that header, returns early above, and therefore can never throw
  // NEXT_REDIRECT out of a route handler (recurring bug #23).
  //
  // The read is CLASSIFIED, not merely null-checked. This used to be
  // `if (profile) assertAccountActiveOrRedirect(profile)`, which never looked at
  // profileRes.error: any failure of the select above produced {data: null},
  // skipped the guard entirely, and fell through to the header-derived session
  // below — a disabled user got a complete OrgContext with org and role, and
  // nothing was reported. The same error failed CLOSED at the other two funnels,
  // so one error class produced opposite outcomes. resolveAccountStatus reports
  // the failure and returns 'unreadable', which denies (by throwing) WITHOUT
  // showing the disabled screen to someone whose account is fine.
  const status = await resolveAccountStatus(
    { data: profileRes.data as AccountStatusRow | null, error: profileRes.error },
    userId,
  );
  assertAccountActiveOrRedirect(status);

  const session: ServerSession = profile
    ? {
        userId: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        avatarUrl: profile.avatar_url,
        defaultOrganizationId: profile.default_organization_id,
      }
    : {
        userId,
        email,
        fullName: null,
        avatarUrl: null,
        defaultOrganizationId: null,
      };

  type MemberOrg = { id: string; name: string; logo_url: string | null };
  const memberRows = (membersRes.data ?? []) as Array<{
    organization_id: string;
    role: Role;
    organizations: MemberOrg | MemberOrg[] | null;
  }>;

  // Same selection semantics as the old two-query shape: prefer the
  // membership matching the profile's default org; otherwise fall back to
  // the first row PostgREST returned (previously the arbitrary limit(1) row).
  const memberRow =
    (session.defaultOrganizationId
      ? memberRows.find((m) => m.organization_id === session.defaultOrganizationId)
      : undefined) ??
    memberRows[0] ??
    null;

  // Org-switcher shape, derived from the SAME rows (rank 8). Rows whose
  // to-one embed came back empty are dropped — identical to the layout's
  // old `if (!org) return null` mapping.
  const memberships: SessionMembership[] = memberRows
    .map((m) => {
      const org = Array.isArray(m.organizations) ? m.organizations[0] : m.organizations;
      if (!org) return null;
      return {
        organizationId: m.organization_id,
        role: m.role,
        name: org.name,
        logoUrl: org.logo_url ?? null,
      };
    })
    .filter((m): m is SessionMembership => m !== null);

  return {
    session,
    orgRole: memberRow?.role ?? null,
    orgId: memberRow?.organization_id ?? null,
    orgName: memberRow ? pickOrgName(memberRow.organizations) : null,
    memberships,
  };
});

/**
 * The current user's accepted memberships (org switcher data), shared
 * with every other consumer of loadSessionAndContext in the render —
 * zero additional round trips. Empty array when signed out.
 */
export const getSessionMemberships = cache(async (): Promise<SessionMembership[]> => {
  const { memberships } = await loadSessionAndContext();
  return memberships;
});

export const getServerSession = cache(async (): Promise<ServerSession | null> => {
  const { session } = await loadSessionAndContext();
  return session;
});

export const requireSession = cache(async (): Promise<ServerSession> => {
  const session = await getServerSession();
  if (!session) redirect('/signin');
  return session;
});

export const requireOrgContext = cache(async (orgId?: string): Promise<OrgContext> => {
  const { session, orgRole, orgId: defaultOrgId, orgName } = await loadSessionAndContext();
  if (!session) redirect('/signin');

  // ═══ THE ORG MUST COME FROM A MEMBERSHIP, NEVER FROM A PREFERENCE ═══
  //
  // `defaultOrgId` is the org of the membership the loader RESOLVED above: it
  // already prefers the profile's `default_organization_id` when that is a
  // real, accepted membership, and falls back to another one when it is not.
  //
  // Reading `session.defaultOrganizationId` here instead re-introduced the raw
  // preference AFTER that resolution. Nothing clears the column when a member
  // is removed (TeamService.removeMember only deletes membership + assignment
  // rows), so a user removed from org A while still belonging to org B got a
  // context with organizationId = A and the role, name and permissions of B.
  // RLS blocks most reads for a non-member, but every service-role path scopes
  // by ctx.organizationId — so writes were aimed at an org the user had been
  // removed from, with a role they held somewhere else.
  const targetOrgId = orgId ?? defaultOrgId;
  if (!targetOrgId) redirect('/onboarding');

  if (orgId && orgId !== defaultOrgId) {
    const supabase = await createClient();
    const { data: member } = await supabase
      .from('organization_members')
      .select('role, organizations:organization_id (name)')
      .eq('organization_id', orgId)
      .eq('user_id', session.userId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!member) redirect('/onboarding');
    const orgs = (member as { organizations: { name: string } | { name: string }[] | null })
      .organizations;
    const role = (member as { role: Role }).role;
    return {
      ...session,
      organizationId: orgId,
      organizationName: pickOrgName(orgs) ?? 'Workspace',
      role,
      permissions: await loadEffectivePermissions(supabase, orgId, session.userId, role),
    };
  }

  if (!orgRole) redirect('/onboarding');

  const supabase = await createClient();
  return {
    ...session,
    organizationId: targetOrgId,
    organizationName: orgName ?? 'Workspace',
    role: orgRole,
    permissions: await loadEffectivePermissions(supabase, targetOrgId, session.userId, orgRole),
  };
});
