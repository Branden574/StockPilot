import 'server-only';

import { reportError } from '@/lib/error-reporter';
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
  const { data, error } = await q;
  // Fail closed: a DB blip must not leave expired grants un-swept (a stale
  // owner membership outliving its TTL is a privilege-escalation risk).
  if (error) throw new Error(error.message);

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
    // Delete only the impersonation grant (never a real membership). A delete
    // that fails is reported and its session stays open, so the next sweep
    // tries it again; the other sessions are still swept.
    const { error: grantErr } = await admin
      .from('organization_members')
      .delete()
      .eq('organization_id', row.target_organization_id)
      .eq('user_id', row.admin_user_id)
      .not('impersonation_expires_at', 'is', null);
    if (grantErr) {
      await reportError(new Error(grantErr.message), {
        tag: 'platform.impersonation.sweep-grant-delete',
        extra: { sessionId: row.id },
      });
      continue;
    }
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
  const { data, error } = await admin
    .from('platform_impersonation_sessions')
    .select('id, target_organization_id, expires_at')
    .eq('admin_user_id', adminUserId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // Fail closed: a swallowed error would hide an active impersonation banner,
  // letting an admin keep acting as an org without the UI warning them.
  if (error) throw new Error(error.message);
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
  | { ok: false; reason: 'org_not_found' | 'org_unreadable' };

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

  // A read that answers an error is reported and says so; it is never "not found".
  const { data: org, error: orgErr } = await admin
    .from('organizations')
    .select('id, name')
    .eq('id', input.organizationId)
    .maybeSingle();
  if (orgErr) {
    await reportError(new Error(orgErr.message), {
      tag: 'platform.impersonation.org-read',
      extra: { organizationId: input.organizationId },
    });
    return { ok: false, reason: 'org_unreadable' };
  }
  if (!org) return { ok: false, reason: 'org_not_found' };

  // Already a REAL member? Then they don't need a grant — just switch. Fail
  // closed: a read that answers an error is not "not a member"; the grant
  // below is written only once the membership is known, so a real membership
  // is never touched.
  const { data: existing, error: existingErr } = await admin
    .from('organization_members')
    .select('id, impersonation_expires_at')
    .eq('organization_id', input.organizationId)
    .eq('user_id', input.adminUserId)
    .maybeSingle();
  if (existingErr) throw new Error(`impersonation membership read: ${existingErr.message}`);
  const alreadyRealMember = Boolean(
    existing && (existing as { impersonation_expires_at: string | null }).impersonation_expires_at === null,
  );

  // Capture the admin's current active org to restore on exit. Fail closed
  // too: a read that answers an error is not "no active org".
  const { data: profile, error: profileErr } = await admin
    .from('user_profiles')
    .select('default_organization_id')
    .eq('id', input.adminUserId)
    .maybeSingle();
  if (profileErr) throw new Error(`impersonation profile read: ${profileErr.message}`);
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

  // Find the active session (if any). Fail closed, as getActiveImpersonation
  // does: a read that answers an error is not "no session"; the action reports
  // it and the Exit button shows an error instead of "Stopped".
  const { data: session, error: sessionErr } = await admin
    .from('platform_impersonation_sessions')
    .select('id, target_organization_id, previous_organization_id')
    .eq('admin_user_id', input.adminUserId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sessionErr) throw new Error(`impersonation session read: ${sessionErr.message}`);
  if (!session) return { stopped: false };
  const s = session as {
    id: string;
    target_organization_id: string;
    previous_organization_id: string | null;
  };

  // Delete ONLY the impersonation grant (never a real membership): scoped to
  // impersonation_expires_at not null. A delete that fails throws before the
  // profile restore and the session end, so nothing else is written and the
  // session can still be swept.
  const { error: grantErr } = await admin
    .from('organization_members')
    .delete()
    .eq('organization_id', s.target_organization_id)
    .eq('user_id', input.adminUserId)
    .not('impersonation_expires_at', 'is', null);
  if (grantErr) throw new Error(`impersonation grant delete: ${grantErr.message}`);

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
