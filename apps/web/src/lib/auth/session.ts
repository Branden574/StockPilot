import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { SESSION_HEADER_USER_EMAIL, SESSION_HEADER_USER_ID } from '@/lib/supabase/middleware';

import type { Role } from '@stockpilot/core';

export interface ServerSession {
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  defaultOrganizationId: string | null;
}

export interface OrgContext extends ServerSession {
  organizationId: string;
  role: Role;
}

/**
 * Loads user + active membership.
 *
 * Performance:
 *   - User id comes from a request header set by the proxy middleware
 *     after it called auth.getUser() (the only secure validation path).
 *     Page renders skip the redundant ~250ms HTTP round trip to Auth.
 *   - Profile + membership lookups run in parallel.
 *   - Wrapped in React.cache() so every service call inside the same
 *     render shares one fetch.
 *
 * Security:
 *   - Headers come from the proxy, which validated the JWT against
 *     Supabase Auth and refreshed the cookie if needed. Server components
 *     can't be reached without going through the proxy, so the header is
 *     trusted within this request.
 *   - Per-query authorization still happens via the JWT cookie + RLS.
 */
const loadSessionAndContext = cache(
  async (): Promise<{ session: ServerSession | null; orgRole: Role | null; orgId: string | null }> => {
    const h = await headers();
    const userId = h.get(SESSION_HEADER_USER_ID);
    if (!userId) return { session: null, orgRole: null, orgId: null };

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
        .select('organization_id, role')
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

    const member = anyMemberRes.data as { organization_id: string; role: Role } | null;

    if (
      member &&
      session.defaultOrganizationId &&
      member.organization_id !== session.defaultOrganizationId
    ) {
      const { data: targeted } = await supabase
        .from('organization_members')
        .select('organization_id, role')
        .eq('user_id', userId)
        .eq('organization_id', session.defaultOrganizationId)
        .not('accepted_at', 'is', null)
        .maybeSingle();
      if (targeted) {
        return {
          session,
          orgRole: (targeted.role as Role) ?? null,
          orgId: (targeted.organization_id as string) ?? null,
        };
      }
    }

    return {
      session,
      orgRole: member?.role ?? null,
      orgId: member?.organization_id ?? null,
    };
  },
);

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
  const { session, orgRole, orgId: defaultOrgId } = await loadSessionAndContext();
  if (!session) redirect('/signin');

  const targetOrgId = orgId ?? session.defaultOrganizationId ?? defaultOrgId;
  if (!targetOrgId) redirect('/onboarding');

  if (orgId && orgId !== defaultOrgId) {
    const supabase = await createClient();
    const { data: member } = await supabase
      .from('organization_members')
      .select('role')
      .eq('organization_id', orgId)
      .eq('user_id', session.userId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!member) redirect('/onboarding');
    return { ...session, organizationId: orgId, role: member.role as Role };
  }

  if (!orgRole) redirect('/onboarding');

  return {
    ...session,
    organizationId: targetOrgId,
    role: orgRole,
  };
});
