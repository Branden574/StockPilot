import 'server-only';

import { headers } from 'next/headers';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { insertAuditRowReported, type AuditEvent } from '@/server/services/audit';

/*
 * The auth audit helpers, moved verbatim out of server/actions/auth.ts so the
 * authenticator code checks in server/actions/mfa.ts and mfa-recovery.ts
 * (through lib/auth/mfa-code-attempts.ts) write their rows the same way.
 *
 * Server code only: `import 'server-only'` and never 'use server'. Exported
 * from a 'use server' module, emitAuthAudit would be a Server Action, an
 * endpoint anyone could call to write Audit log rows in any organization's
 * name. lib/auth/mfa-code-attempts.test.ts pins this.
 */

/**
 * Writes an auth-lifecycle audit row directly via the admin client.
 *
 * The standard `audit()` helper requires a ServiceContext, and its
 * `withContext()` fallback throws NEXT_REDIRECT for org-less callers —
 * which would corrupt the control flow of a sign-in (no resolved org
 * yet) or a sign-in-failure (no authenticated user). This direct helper
 * writes the event with whatever attribution we have, tags IP/UA from
 * the request headers, and never throws.
 *
 * organization_id and user_id are both nullable on audit_logs (see
 * migration 0002_inventory.sql), so a sign-in-failure with both null
 * is still a valid forensic row.
 */
export async function emitAuthAudit(params: {
  event: AuditEvent;
  userId?: string | null;
  organizationId?: string | null;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    const h = await headers();
    const ip =
      h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent') ?? null;

    // Reads the INSERT's own result: supabase-js returns a refused write as
    // { error } rather than throwing, so the catch below never saw one.
    await insertAuditRowReported({
      organization_id: params.organizationId ?? null,
      user_id: params.userId ?? null,
      event: params.event,
      ip,
      user_agent: userAgent,
      metadata: {
        entity_type: 'user',
        entity_id: params.userId ?? null,
        warehouse_id: null,
        before: null,
        after: null,
        reason: null,
        ...(params.extra ?? {}),
      },
    });
  } catch (e) {
    // Best-effort — never let a logging failure break an auth action.
    void reportError(e, {
      tag: 'audit.auth_emit_failed',
      level: 'warning',
      extra: { event: params.event },
    });
  }
}

/**
 * Resolves a user's default organization + role for audit attribution
 * and ServiceContext construction. Returns nulls if the lookup fails —
 * the audit row is still written (organization_id is nullable). Uses
 * the admin client because the user may be on a freshly-issued or
 * recovery session with limited RLS context.
 */
export async function resolveDefaultOrgAndRole(
  userId: string,
): Promise<{ organizationId: string | null; role: string | null }> {
  try {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('user_profiles')
      .select('default_organization_id')
      .eq('id', userId)
      .maybeSingle();
    const defaultOrgId =
      (profile as { default_organization_id: string | null } | null)
        ?.default_organization_id ?? null;

    if (defaultOrgId) {
      const { data: member } = await admin
        .from('organization_members')
        .select('organization_id, role')
        .eq('user_id', userId)
        .eq('organization_id', defaultOrgId)
        .not('accepted_at', 'is', null)
        .maybeSingle();
      const row = member as { organization_id: string; role: string } | null;
      if (row) return { organizationId: row.organization_id, role: row.role };
    }

    const { data: anyMember } = await admin
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      // Oldest first: the same tie-break as every other membership resolver (0355).
      .order('created_at', { ascending: true })
      .order('organization_id', { ascending: true })
      .limit(1)
      .maybeSingle();
    const row = anyMember as { organization_id: string; role: string } | null;
    return {
      organizationId: row?.organization_id ?? null,
      role: row?.role ?? null,
    };
  } catch {
    return { organizationId: null, role: null };
  }
}
