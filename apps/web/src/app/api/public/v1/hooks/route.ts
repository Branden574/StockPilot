import { randomBytes } from 'node:crypto';

import { NextResponse } from 'next/server';

import { authorizePublicApi } from '@/lib/auth/public-api';
import { createAdminClient } from '@/lib/supabase/admin';
import { PUBLIC_HOOK_EVENT_TYPES } from '@/server/services/integration-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A single org can register at most this many automation webhooks. A generous
// ceiling that still bounds a runaway/abusive key.
const MAX_HOOKS_PER_ORG = 100;

/**
 * Public API — automation webhook subscriptions (Zapier/Make/n8n REST hooks).
 * Auth: `Authorization: Bearer sk_live_…` with the `webhooks:manage` scope.
 *
 * GET  /api/public/v1/hooks            → list this org's automation webhooks.
 * POST /api/public/v1/hooks            → subscribe { target_url, event_types }.
 *
 * A subscription is just an `integration_endpoints` row (type='webhook'), so it
 * rides the existing delivery engine: SSRF-guarded `safeFetch`, HMAC-SHA256
 * signing (the returned `secret`), retry + dead-letter. Org-scoped throughout.
 */
export async function GET(req: Request) {
  const auth = await authorizePublicApi(req, 'webhooks:manage');
  if ('res' in auth) return auth.res;
  const { ctx } = auth;

  const guard = await requireIntegrationsModule(ctx.organizationId);
  if (guard) return guard;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('integration_endpoints')
    .select('id, url, event_types, enabled, created_at')
    .eq('organization_id', ctx.organizationId)
    .eq('type', 'webhook')
    .order('created_at', { ascending: false })
    .limit(MAX_HOOKS_PER_ORG);
  if (error) return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: Request) {
  const auth = await authorizePublicApi(req, 'webhooks:manage');
  if ('res' in auth) return auth.res;
  const { ctx } = auth;

  const guard = await requireIntegrationsModule(ctx.organizationId);
  if (guard) return guard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const { target_url, event_types } = (body ?? {}) as {
    target_url?: unknown;
    event_types?: unknown;
  };

  // Validate the target URL: must be a well-formed https URL. Delivery is
  // additionally SSRF-guarded by safeFetch, but reject obvious junk up front.
  if (typeof target_url !== 'string') {
    return NextResponse.json({ error: 'target_url is required.' }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(target_url);
  } catch {
    return NextResponse.json({ error: 'target_url must be a valid URL.' }, { status: 400 });
  }
  if (parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'target_url must use https://.' }, { status: 400 });
  }

  // Validate event types against the known catalog (drop unknowns; require ≥1).
  const requested = Array.isArray(event_types) ? event_types : [];
  // PUBLIC_HOOK_EVENT_TYPES excludes the security.* forensic feed — an API key
  // must not be able to stream member emails/IPs/MFA events to an external URL.
  const valid = new Set(PUBLIC_HOOK_EVENT_TYPES);
  const events = requested.filter((e): e is string => typeof e === 'string' && valid.has(e));
  if (events.length === 0) {
    return NextResponse.json(
      {
        error: 'event_types must include at least one supported event.',
        known_events: PUBLIC_HOOK_EVENT_TYPES,
      },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Bound the number of subscriptions per org.
  const { count } = await admin
    .from('integration_endpoints')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ctx.organizationId)
    .eq('type', 'webhook');
  if ((count ?? 0) >= MAX_HOOKS_PER_ORG) {
    return NextResponse.json(
      { error: `Webhook limit reached (${MAX_HOOKS_PER_ORG}). Delete unused subscriptions first.` },
      { status: 409 },
    );
  }

  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  const { data, error } = await admin
    .from('integration_endpoints')
    .insert({
      organization_id: ctx.organizationId,
      type: 'webhook',
      url: target_url,
      secret,
      event_types: events,
      description: 'Automation subscription (Zapier / Make / n8n)',
      created_by: null,
    })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: 'internal_error' }, { status: 500 });

  // Return the secret ONCE so the consumer can verify the HMAC signature header
  // (`t=…,v1=…`) on every delivery.
  return NextResponse.json(
    { id: (data as { id: string }).id, secret, event_types: events },
    { status: 201 },
  );
}

/**
 * Webhooks live in the `integrations` module; require it (separate from the
 * `api_access` module the key itself already gates on). Returns a 403 response
 * to short-circuit, or null when enabled.
 */
async function requireIntegrationsModule(organizationId: string): Promise<NextResponse | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('organization_modules')
    .select('enabled')
    .eq('organization_id', organizationId)
    .eq('module_id', 'integrations')
    .maybeSingle();
  if (!(data as { enabled?: boolean } | null)?.enabled) {
    return NextResponse.json(
      { error: 'The Integrations module is not enabled for this organization.' },
      { status: 403 },
    );
  }
  return null;
}
