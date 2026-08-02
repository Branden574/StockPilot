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
 * Best-effort but NOT silent: a failed audit insert is reported and never
 * throws, so it can't break the action it's logging, but `recordPlatformAudit`
 * RETURNS whether the row landed. The owner's account-disable brief requires
 * every disable, revocation and re-enable to be auditable, so a caller that
 * carries that guarantee (account-status.ts) must be able to tell that the row
 * is missing and report the operation as partial rather than as a clean
 * success. Callers that don't care simply ignore the boolean — the pre-existing
 * `await recordPlatformAudit(...)` sites behave exactly as before.
 * (Reads for the Audit screen live in `listPlatformAudit` below and DO surface
 * errors.)
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

/** @returns true when the audit row landed, false when it was reported instead. */
export async function recordPlatformAudit(input: RecordPlatformAuditInput): Promise<boolean> {
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
    return true;
  } catch (e) {
    await reportError(e, {
      tag: 'platform-audit.record',
      extra: { action: input.action, targetOrg: input.targetOrganizationId ?? null },
    });
    return false;
  }
}

export interface PlatformAuditRow {
  id: string;
  actorEmail: string;
  action: PlatformAuditAction;
  targetOrganizationId: string | null;
  targetUserId: string | null;
  /**
   * The target's email, resolved at read time. Null when the row names no user
   * or the lookup could not answer — the screen falls back to the uuid, which
   * is still reviewable.
   *
   * Resolved rather than denormalised into the row: `platform_admin_audit` is
   * append-only, and copying an email into it would freeze a value that can
   * legitimately change afterwards.
   */
  targetUserEmail: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/**
 * The human-readable reason a row carries, or null.
 *
 * `detail` is free-form jsonb written by a dozen different callers, so the cell
 * that renders it needs one predicate rather than an inline
 * `detail.reason as string` that would print `undefined` or `[object Object]`
 * the first time a caller writes something else in that key.
 */
export function auditDetailReason(detail: Record<string, unknown>): string | null {
  const reason = detail.reason;
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether this row records a press that lost the race to a peer admin's
 * concurrent transition (see account-status.ts CONVERGENCE). `action` alone
 * (e.g. `user_disabled`) cannot tell that apart from a real disable — both
 * write the same action value — so a query or a screen that wants to
 * exclude superseded presses needs this predicate rather than reaching into
 * `detail.superseded` ad hoc, the same reasoning `auditDetailReason` above
 * already applies to `detail.reason`.
 */
export function auditDetailSuperseded(detail: Record<string, unknown>): boolean {
  return detail.superseded === true;
}

/**
 * Reads the audit feed for the Audit screen (Phase 4). Optionally filter by
 * target org. Service-role read; the caller must already have passed
 * `requirePlatformAdmin()`.
 *
 * The owner's account-disable brief requires a disable and a re-enable to be
 * REVIEWABLE by a god admin, not merely recorded. The end-to-end run found the
 * screen showing neither the target user nor the reason even though the row
 * carried both, so an operator could see that someone had disabled someone. The
 * target email is resolved here, in ONE batched lookup for the whole page, so
 * the page component stays a renderer.
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

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const targetIds = [
    ...new Set(
      rows
        .map((r) => r.target_user_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const emailById = await targetEmails(admin, targetIds);

  return rows.map((r) => {
    const targetUserId = (r.target_user_id as string | null) ?? null;
    return {
      id: r.id as string,
      actorEmail: r.actor_email as string,
      action: r.action as PlatformAuditAction,
      targetOrganizationId: (r.target_organization_id as string | null) ?? null,
      targetUserId,
      targetUserEmail: targetUserId ? (emailById.get(targetUserId) ?? null) : null,
      detail: (r.detail as Record<string, unknown> | null) ?? {},
      createdAt: r.created_at as string,
    };
  });
}

/**
 * One `in (...)` for the whole page, never one lookup per row.
 *
 * Degrades to an empty map rather than throwing: a name column that cannot be
 * filled must never blank out the audit trail itself. The page renders the uuid
 * in that case, which is what it did before this existed.
 */
async function targetEmails(
  admin: ReturnType<typeof createAdminClient>,
  ids: string[],
): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  if (ids.length === 0) return byId;

  const { data, error } = await admin.from('user_profiles').select('id, email').in('id', ids);
  if (error) {
    await reportError(new Error(error.message), {
      tag: 'platform-audit.target-emails',
      extra: { count: ids.length },
    });
    return byId;
  }
  for (const row of (data ?? []) as Array<{ id?: unknown; email?: unknown }>) {
    if (typeof row.id === 'string' && typeof row.email === 'string') byId.set(row.id, row.email);
  }
  return byId;
}
