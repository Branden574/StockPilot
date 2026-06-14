import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

import { recordPlatformAudit } from './audit';

/**
 * "Act as this org" — platform-admin impersonation via a REAL, temporary,
 * auto-expiring `owner` membership (see migration 0176 for why a cookie can't
 * work under RLS). All writes use the service-role admin client and assume the
 * CALLER passed requirePlatformAdmin + a fresh AAL2 step-up.
 *
 * Lifecycle:
 *   start → insert org_members grant (impersonation_expires_at set) + session
 *           row + switch the admin's active org to the target. Audited.
 *   stop  → restore previous active org + delete the grant + end the session.
 *           Audited.
 *   sweep → remove any grants past expiry (safety net; called on start and
 *           callable from cron).
 */

/** Impersonation grants live ~45 minutes, then auto-expire. */
export const IMPERSONATION_TTL_MS = 45 * 60 * 1000;

export interface ActiveImpersonation {
  sessionId: string;
  targetOrganizationId: string;
  expiresAt: string;
}

/**
 * Sweep expired impersonation grants. For each expired active session it
 * restores the admin's previous active org (so they don't land on /onboarding
 * with an orphaned default), deletes the temporary membership, and ends the
 * session. Idempotent; safe to call often. Scope to one admin when
 * `adminUserId` is given (the start path), else global (cron).
 */
export async function sweepExpiredImpersonations(
  now: number = Date.now(),
  adminUserId?: string,
): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date(now).toISOString();

  let q = admin
    .from('platform_impersonation_sessions')
    .select('id, admin_user_id, target_organization_id, previous_organization_id')
    .is('ended_at', null)
    .lt('expires_at', nowIso);
  if (adminUserId) q = q.eq('admin_user_id', adminUserId);
  const { data } = await q;

  for (const row of (data ?? []) as Array<{
    id: string;
    admin_user_id: string;
    target_organization_id: string;
    previous_organization_id: string | null;
  }>) {
    // Restore active org ONLY if it still points at the impersonated org (don't
    // clobber a deliberate later switch).
    await admin
      .from('user_profiles')
      .update({ default_organization_id: row.previous_organization_id })
      .eq('id', row.admin_user_id)
      .eq('default_organization_id', row.target_organization_id);
    // Delete only the impersonation grant (never a real membership).
    await admin
      .from('organization_members')
      .delete()
      .eq('organization_id', row.target_organization_id)
      .eq('user_id', row.admin_user_id)
      .not('impersonation_expires_at', 'is', null);
    await admin
      .from('platform_impersonation_sessions')
      .update({ ended_at: nowIso })
      .eq('id', row.id);
  }
}

/** The admin's current active (not ended, not expired) impersonation, if any. */
export async function getActiveImpersonation(
  adminUserId: string,
  now: number = Date.now(),
): Promise<ActiveImpersonation | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('platform_impersonation_sessions')
    .select('id, target_organization_id, expires_at')
    .eq('admin_user_id', adminUserId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as { id: string; target_organization_id: string; expires_at: string };
  if (Date.parse(row.expires_at) <= now) return null; // expired → not active
  return {
    sessionId: row.id,
    targetOrganizationId: row.target_organization_id,
    expiresAt: row.expires_at,
  };
}

export type StartActingAsResult =
  | { ok: true; alreadyMember: boolean }
  | { ok: false; reason: 'org_not_found' };

export interface StartActingAsInput {
  adminUserId: string;
  adminEmail: string;
  organizationId: string;
  now?: number;
}

export async function startActingAs(input: StartActingAsInput): Promise<StartActingAsResult> {
  const now = input.now ?? Date.now();
  const admin = createAdminClient();

  // Defensive: tear down any stale grants for this admin first.
  await sweepExpiredImpersonations(now, input.adminUserId);
  // Also end any *active* prior impersonation (one at a time) so we never
  // leave two grants outstanding.
  await stopActingAs({ adminUserId: input.adminUserId, adminEmail: input.adminEmail, now, silent: true });

  const { data: org } = await admin
    .from('organizations')
    .select('id, name')
    .eq('id', input.organizationId)
    .maybeSingle();
  if (!org) return { ok: false, reason: 'org_not_found' };

  // Already a REAL member? Then they don't need a grant — just switch.
  const { data: existing } = await admin
    .from('organization_members')
    .select('id, impersonation_expires_at')
    .eq('organization_id', input.organizationId)
    .eq('user_id', input.adminUserId)
    .maybeSingle();
  const alreadyRealMember = Boolean(
    existing && (existing as { impersonation_expires_at: string | null }).impersonation_expires_at === null,
  );

  // Capture the admin's current active org to restore on exit.
  const { data: profile } = await admin
    .from('user_profiles')
    .select('default_organization_id')
    .eq('id', input.adminUserId)
    .maybeSingle();
  const previousOrgId = (profile as { default_organization_id: string | null } | null)?.default_organization_id ?? null;

  const expiresAtIso = new Date(now + IMPERSONATION_TTL_MS).toISOString();

  if (!alreadyRealMember) {
    // Insert (or refresh) the temporary owner grant. upsert on the unique
    // (organization_id, user_id) so a leftover row is reused, not duplicated.
    const { error: memErr } = await admin.from('organization_members').upsert(
      {
        organization_id: input.organizationId,
        user_id: input.adminUserId,
        role: 'owner',
        accepted_at: new Date(now).toISOString(),
        impersonation_expires_at: expiresAtIso,
      },
      { onConflict: 'organization_id,user_id' },
    );
    if (memErr) throw new Error(`impersonation grant: ${memErr.message}`);
  }

  // Record the session (restore handle + banner + audit).
  const { error: sessErr } = await admin.from('platform_impersonation_sessions').insert({
    admin_user_id: input.adminUserId,
    target_organization_id: input.organizationId,
    previous_organization_id: previousOrgId,
    expires_at: expiresAtIso,
  });
  if (sessErr) throw new Error(`impersonation session: ${sessErr.message}`);

  // Switch the admin's active org to the target.
  await admin
    .from('user_profiles')
    .update({ default_organization_id: input.organizationId })
    .eq('id', input.adminUserId);

  await recordPlatformAudit({
    actorUserId: input.adminUserId,
    actorEmail: input.adminEmail,
    action: 'acted_as_start',
    targetOrganizationId: input.organizationId,
    detail: { alreadyMember: alreadyRealMember, expiresAt: expiresAtIso },
  });

  return { ok: true, alreadyMember: alreadyRealMember };
}

export interface StopActingAsInput {
  adminUserId: string;
  adminEmail: string;
  now?: number;
  /** When true, don't write an audit row (used internally by start to clear a prior session). */
  silent?: boolean;
}

export async function stopActingAs(input: StopActingAsInput): Promise<{ stopped: boolean }> {
  const now = input.now ?? Date.now();
  const admin = createAdminClient();

  // Find the active session (if any).
  const { data: session } = await admin
    .from('platform_impersonation_sessions')
    .select('id, target_organization_id, previous_organization_id')
    .eq('admin_user_id', input.adminUserId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!session) return { stopped: false };
  const s = session as {
    id: string;
    target_organization_id: string;
    previous_organization_id: string | null;
  };

  // Delete ONLY the impersonation grant (never a real membership): scoped to
  // impersonation_expires_at not null.
  await admin
    .from('organization_members')
    .delete()
    .eq('organization_id', s.target_organization_id)
    .eq('user_id', input.adminUserId)
    .not('impersonation_expires_at', 'is', null);

  // Restore the admin's previous active org.
  await admin
    .from('user_profiles')
    .update({ default_organization_id: s.previous_organization_id })
    .eq('id', input.adminUserId);

  // Mark the session ended.
  await admin
    .from('platform_impersonation_sessions')
    .update({ ended_at: new Date(now).toISOString() })
    .eq('id', s.id);

  if (!input.silent) {
    await recordPlatformAudit({
      actorUserId: input.adminUserId,
      actorEmail: input.adminEmail,
      action: 'acted_as_end',
      targetOrganizationId: s.target_organization_id,
      detail: {},
    });
  }

  return { stopped: true };
}
