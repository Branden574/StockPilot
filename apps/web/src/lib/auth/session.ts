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

/**
 * `cache()` memoizes within a single React render — every service that
 * calls getServerSession() during the same request hits Supabase once,
 * not once per call. Massive perf win on data-heavy pages.
 */
export const getServerSession = cache(async (): Promise<ServerSession | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, email, full_name, avatar_url, default_organization_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile) {
    return {
      userId: user.id,
      email: user.email ?? '',
      fullName: null,
      avatarUrl: null,
      defaultOrganizationId: null,
    };
  }

  return {
    userId: profile.id as string,
    email: profile.email as string,
    fullName: (profile.full_name as string | null) ?? null,
    avatarUrl: (profile.avatar_url as string | null) ?? null,
    defaultOrganizationId: (profile.default_organization_id as string | null) ?? null,
  };
});

export const requireSession = cache(async (): Promise<ServerSession> => {
  const session = await getServerSession();
  if (!session) redirect('/signin');
  return session;
});

export interface OrgContext extends ServerSession {
  organizationId: string;
  role: Role;
}

export const requireOrgContext = cache(async (orgId?: string): Promise<OrgContext> => {
  const session = await requireSession();
  const supabase = await createClient();

  const targetOrgId = orgId ?? session.defaultOrganizationId;
  if (!targetOrgId) redirect('/onboarding');

  const { data: member } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', targetOrgId)
    .eq('user_id', session.userId)
    .not('accepted_at', 'is', null)
    .maybeSingle();

  if (!member) redirect('/onboarding');

  return {
    ...session,
    organizationId: targetOrgId,
    role: member.role as Role,
  };
});
