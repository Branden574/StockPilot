import 'server-only';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Platform-admin audit trail (migration 0175 — `platform_admin_audit`).
 *
 * Every god-mode action in the Super-Admin Console records a row here:
 * who did it (actor), what (action), against which org/user, and any
 * detail. The table has RLS ON with NO policies, so it's written/read
 * ONLY through the service-role admin client behind the platform-admin
 * gate — never reachable by the anon/authed clients.
 *
 * Best-effort: a failed audit insert is reported but never throws, so it
 * can't break the action it's logging. (Reads for the Audit screen live
 * in `listPlatformAudit` below and DO surface errors.)
 */

export type PlatformAuditAction =
  | 'viewed_org'
  | 'acted_as_start'
  | 'acted_as_end'
  | 'billing_changed'
  | 'password_reset_sent'
  | 'org_provisioned'
  | 'ticket_updated'
  | 'deletion_passphrase_set'
  | 'org_deleted'
  /** Temporary platform-wide account disable (migration 0308). */
  | 'user_disabled'
  | 'user_reenabled';

export interface RecordPlatformAuditInput {
  actorUserId: string;
  actorEmail: string;
  action: PlatformAuditAction;
  targetOrganizationId?: string | null;
  targetUserId?: string | null;
  detail?: Record<string, unknown>;
}

export async function recordPlatformAudit(input: RecordPlatformAuditInput): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('platform_admin_audit').insert({
      actor_user_id: input.actorUserId,
      actor_email: input.actorEmail,
      action: input.action,
      target_organization_id: input.targetOrganizationId ?? null,
      target_user_id: input.targetUserId ?? null,
      detail: input.detail ?? {},
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    await reportError(e, {
      tag: 'platform-audit.record',
      extra: { action: input.action, targetOrg: input.targetOrganizationId ?? null },
    });
  }
}

export interface PlatformAuditRow {
  id: string;
  actorEmail: string;
  action: PlatformAuditAction;
  targetOrganizationId: string | null;
  targetUserId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/**
 * Reads the audit feed for the Audit screen (Phase 4). Optionally filter by
 * target org. Service-role read; the caller must already have passed
 * `requirePlatformAdmin()`.
 */
export async function listPlatformAudit(
  opts: { organizationId?: string; limit?: number } = {},
): Promise<PlatformAuditRow[]> {
  const admin = createAdminClient();
  let q = admin
    .from('platform_admin_audit')
    .select('id, actor_email, action, target_organization_id, target_user_id, detail, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  if (opts.organizationId) q = q.eq('target_organization_id', opts.organizationId);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    actorEmail: r.actor_email as string,
    action: r.action as PlatformAuditAction,
    targetOrganizationId: (r.target_organization_id as string | null) ?? null,
    targetUserId: (r.target_user_id as string | null) ?? null,
    detail: (r.detail as Record<string, unknown> | null) ?? {},
    createdAt: r.created_at as string,
  }));
}
