import 'server-only';

import { headers } from 'next/headers';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { insertAuditRowReported, type AuditEvent } from '@/server/services/audit';

/*
 * The auth audit helpers, moved verbatim out of server/actions/auth.ts so the
 * authenticator code checks in server/actions/mfa.ts and mfa-recovery.ts
 * (through lib/auth/mfa-code-attempts.ts) and the phone routes
 * POST /api/v1/auth/signed-in and signed-out write their rows the same way.
 *
 * Server code only: `import 'server-only'` and never 'use server'. Exported
 * from a 'use server' module, emitAuthAudit would be a Server Action, an
 * endpoint anyone could call to write Audit log rows in any organization's
 * name. auth-audit.guard.test.ts and lib/auth/mfa-code-attempts.test.ts pin
 * this.
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

type ResolveStep = 'client' | 'profile' | 'default_membership' | 'any_membership';

/**
 * Reports a read the resolver could not use: the step and the error code
 * only (for a thrown error, its name), never the message, which can quote
 * request details.
 */
function reportUnresolved(step: ResolveStep, failure: unknown): void {
  const code =
    failure && typeof failure === 'object' && 'code' in failure
      ? String((failure as { code: unknown }).code ?? '') || null
      : failure instanceof Error
        ? failure.name
        : null;
  void reportError(new Error('Audit organization read failed'), {
    tag: 'audit.organization_unresolved',
    level: 'warning',
    extra: { step, code },
  });
}

/**
 * Runs one read. A read that answers an error, or throws, is reported and
 * answers null, so the caller goes on to its next read.
 */
async function readOrReport<T>(
  step: ResolveStep,
  read: () => PromiseLike<{ data: T | null; error: unknown }>,
): Promise<T | null> {
  try {
    const { data, error } = await read();
    if (error) {
      reportUnresolved(step, error);
      return null;
    }
    return data ?? null;
  } catch (e) {
    reportUnresolved(step, e);
    return null;
  }
}

/**
 * Resolves the organization (and role) an audit row about this person is
 * filed under, for a row written outside an organization context: sign-in,
 * sign-out, password reset, recovery codes, email change.
 *
 * The profile's default organization is a preference the person sets on
 * their own row, never proof of membership. It is used only when it is an
 * ACCEPTED membership of this person; otherwise the person's oldest accepted
 * membership (the tie-break of every other membership resolver, 0355);
 * otherwise none. A row with no organization is still written
 * (audit_logs.organization_id is nullable) and is in no organization's log.
 *
 * A read that fails or throws is reported (audit.organization_unresolved) and
 * the next read runs. Both membership reads ask only for this person's
 * accepted rows, so whatever they answer is one of the person's memberships.
 * The answer is no organization only when every read failed or found nothing.
 * Never throws. Uses the admin client because the user may be on a
 * freshly-issued or recovery session with limited RLS context.
 */
export async function resolveDefaultOrgAndRole(
  userId: string,
): Promise<{ organizationId: string | null; role: string | null }> {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    reportUnresolved('client', e);
    return { organizationId: null, role: null };
  }

  const profile = await readOrReport<{ default_organization_id: string | null }>('profile', () =>
    admin.from('user_profiles').select('default_organization_id').eq('id', userId).maybeSingle(),
  );
  const defaultOrgId = profile?.default_organization_id ?? null;

  if (defaultOrgId) {
    const member = await readOrReport<{ organization_id: string; role: string }>(
      'default_membership',
      () =>
        admin
          .from('organization_members')
          .select('organization_id, role')
          .eq('user_id', userId)
          .eq('organization_id', defaultOrgId)
          .not('accepted_at', 'is', null)
          .maybeSingle(),
    );
    if (member) return { organizationId: member.organization_id, role: member.role };
  }

  const anyMember = await readOrReport<{ organization_id: string; role: string }>(
    'any_membership',
    () =>
      admin
        .from('organization_members')
        .select('organization_id, role')
        .eq('user_id', userId)
        .not('accepted_at', 'is', null)
        // Oldest first: the same tie-break as every other membership resolver (0355).
        .order('created_at', { ascending: true })
        .order('organization_id', { ascending: true })
        .limit(1)
        .maybeSingle(),
  );
  return {
    organizationId: anyMember?.organization_id ?? null,
    role: anyMember?.role ?? null,
  };
}
