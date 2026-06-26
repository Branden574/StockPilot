import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { SESSION_HEADER_USER_EMAIL, SESSION_HEADER_USER_ID } from '@/lib/supabase/middleware';
import { loadEffectivePermissions } from '@/lib/auth/effective-permissions';

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

interface LoadedContext {
  session: ServerSession | null;
  orgRole: Role | null;
  orgId: string | null;
  orgName: string | null;
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
 * request header set by the proxy after auth.getUser() validation.
 *
 * Wrapped in React.cache() so every consumer in the same render shares
 * one fetch — layout, page, and every service. Layouts no longer need
 * their own membership query.
 */
const loadSessionAndContext = cache(async (): Promise<LoadedContext> => {
  const h = await headers();
  const userId = h.get(SESSION_HEADER_USER_ID);
  if (!userId) return { session: null, orgRole: null, orgId: null, orgName: null };

  const email = h.get(SESSION_HEADER_USER_EMAIL) ?? '';
  const supabase = await createClient();

  const [profileRes, anyMemberRes] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('id, email, full_name, avatar_url, default_organization_id')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('organization_members')
      .select('organization_id, role, organizations:organization_id (name)')
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      .limit(1)
      .maybeSingle(),
  ]);

  const profile = profileRes.data as
    | {
        id: string;
        email: string;
        full_name: string | null;
        avatar_url: string | null;
        default_organization_id: string | null;
      }
    | null;

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

  const memberRow = anyMemberRes.data as
    | {
        organization_id: string;
        role: Role;
        organizations: { name: string } | { name: string }[] | null;
      }
    | null;

  if (
    memberRow &&
    session.defaultOrganizationId &&
    memberRow.organization_id !== session.defaultOrganizationId
  ) {
    const { data: targeted } = await supabase
      .from('organization_members')
      .select('organization_id, role, organizations:organization_id (name)')
      .eq('user_id', userId)
      .eq('organization_id', session.defaultOrganizationId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (targeted) {
      const t = targeted as typeof memberRow;
      return {
        session,
        orgRole: t.role,
        orgId: t.organization_id,
        orgName: pickOrgName(t.organizations),
      };
    }
  }

  return {
    session,
    orgRole: memberRow?.role ?? null,
    orgId: memberRow?.organization_id ?? null,
    orgName: memberRow ? pickOrgName(memberRow.organizations) : null,
  };
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

  const targetOrgId = orgId ?? session.defaultOrganizationId ?? defaultOrgId;
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
