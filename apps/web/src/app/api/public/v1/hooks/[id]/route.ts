import { NextResponse } from 'next/server';

import { authorizePublicApi } from '@/lib/auth/public-api';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public API — unsubscribe an automation webhook.
 * Auth: `Authorization: Bearer sk_live_…` with the `webhooks:manage` scope.
 *
 * DELETE /api/public/v1/hooks/:id  → remove this org's webhook subscription.
 *
 * Idempotent: deleting an already-gone hook still returns 200 (Zapier/Make/n8n
 * call unsubscribe defensively). Org-scoped — a key can only delete its org's
 * endpoints.
 *
 * Intentionally does NOT require the `integrations` module (unlike subscribe/
 * list): unsubscribe must keep working after a downgrade so clients can always
 * clean up dangling subscriptions. It's still scope-gated + org-scoped.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePublicApi(req, 'webhooks:manage');
  if ('res' in auth) return auth.res;
  const { ctx } = auth;
  const { id } = await params;

  const admin = createAdminClient();
  const { error } = await admin
    .from('integration_endpoints')
    .delete()
    .eq('organization_id', ctx.organizationId)
    .eq('id', id)
    .eq('type', 'webhook');
  if (error) return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
