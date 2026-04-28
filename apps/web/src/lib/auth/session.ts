import { cache } from 'react';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';

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
 * Loads user + profile + active membership in **two** Supabase round-trips
 * (auth.getUser, then a single Promise.all on profile + membership).
 * Wrapped in React.cache() so every service inside the same render shares
 * one fetch. Replaces the older 3-step sequential bootstrap which made
 * dashboard pages feel slow.
 */
const loadSessionAndContext = cache(
  async (): Promise<{ session: ServerSession | null; orgRole: Role | null; orgId: string | null }> => {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { session: null, orgRole: null, orgId: null };

    // Profile and "any active membership" in parallel — neither depends on the other.
    const [profileRes, anyMemberRes] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('id, email, full_name, avatar_url, default_organization_id')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('organization_members')
        .select('organization_id, role')
        .eq('user_id', user.id)
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
          userId: user.id,
          email: user.email ?? '',
          fullName: null,
          avatarUrl: null,
          defaultOrganizationId: null,
        };

    const member = anyMemberRes.data as { organization_id: string; role: Role } | null;

    // If the user has a default org but the membership we grabbed is for a
    // different org, do a targeted lookup. Rare path — most users have one
    // org and the default match.
    if (member && session.defaultOrganizationId && member.organization_id !== session.defaultOrganizationId) {
      const { data: targeted } = await supabase
        .from('organization_members')
        .select('organization_id, role')
        .eq('user_id', user.id)
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

  // If caller asked for a specific org and it's not the cached one, do a
  // narrow lookup just for that.
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
