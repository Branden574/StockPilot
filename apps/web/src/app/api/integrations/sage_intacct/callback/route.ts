import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { getServerSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit } from '@/server/services/audit';
import { putConnectionSecret } from '@/server/connectors/secret-store';

import { exchangeCode } from '@/server/connectors/sage-intacct/oauth';

import { hasPermission, type Role } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SETTINGS_PATH = '/dashboard/settings/integrations';

/**
 * Sage Intacct OAuth callback. Mirrors the QuickBooks callback's lifecycle
 * one-for-one (state verify under RLS → module + permission gates → code
 * exchange → Vault write via service role → activate → audit → 302). The only
 * provider differences: Intacct has no `realmId` query param (the company
 * context rides the token; `external_account_id` stores the company id when
 * the token response carries one), and consent denial arrives as a standard
 * OAuth `error` param.
 *
 * SECRET INVARIANT: tokens are written to Vault with the admin client only —
 * never in the redirect URL, logs, or any client-readable column.
 */
export async function GET(req: Request) {
  const appUrl = env.NEXT_PUBLIC_APP_URL;

  const redirectWithError = (code: string) => {
    const url = new URL(SETTINGS_PATH, appUrl);
    url.searchParams.set('error', code);
    return NextResponse.redirect(url, { status: 302 });
  };

  const session = await getServerSession();
  if (!session) {
    return NextResponse.redirect(new URL('/signin', appUrl), { status: 302 });
  }

  const params = new URL(req.url).searchParams;

  if (params.get('error')) {
    return redirectWithError('access_denied');
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) {
    return redirectWithError('invalid_request');
  }

  try {
    const supabase = await createClient();

    // 1. Verify state against the PENDING row. RLS scopes this to the user's
    //    own orgs, so a hit proves both the CSRF state and org membership.
    const { data: conn, error: connErr } = await supabase
      .from('org_connections')
      .select('id, organization_id, status, oauth_state')
      .eq('provider_id', 'sage_intacct')
      .eq('oauth_state', state)
      .eq('status', 'pending')
      .maybeSingle();
    if (connErr) {
      void reportError(connErr, { tag: 'intacct.callback.lookup' });
      return redirectWithError('internal_error');
    }
    if (!conn) {
      return redirectWithError('invalid_state');
    }

    const connectionId = (conn as { id: string }).id;
    const organizationId = (conn as { organization_id: string }).organization_id;

    // 2a. The integrations module must be enabled for this org.
    const { data: moduleRow } = await supabase
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', organizationId)
      .eq('module_id', 'integrations')
      .eq('enabled', true)
      .maybeSingle();
    if (!moduleRow) {
      return redirectWithError('module_disabled');
    }

    // 2b. The user must hold integrations:manage in this org.
    const { data: member } = await supabase
      .from('organization_members')
      .select('role')
      .eq('organization_id', organizationId)
      .eq('user_id', session.userId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    const role = (member as { role: Role } | null)?.role;
    if (!role || !hasPermission(role, 'integrations:manage')) {
      return redirectWithError('forbidden');
    }

    // 3. Exchange the auth code for tokens (+ company id when present).
    const tokens = await exchangeCode(code);

    // 4. Persist the token blob to Vault via the SERVICE-ROLE admin client.
    const admin = createAdminClient();
    const secretId = await putConnectionSecret(admin as never, `connector:${connectionId}`, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });

    // 5. Activate the connection.
    const { error: updateErr } = await admin
      .from('org_connections')
      .update({
        status: 'active',
        external_account_id: tokens.companyId,
        secret_id: secretId,
        oauth_state: null,
        last_connected_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', connectionId);
    if (updateErr) {
      void reportError(updateErr, { tag: 'intacct.callback.activate' });
      return redirectWithError('internal_error');
    }

    // 6. Audit with an explicit minimal ServiceContext (no withContext() in an
    //    API route — it throws NEXT_REDIRECT).
    void audit(
      {
        event: 'integration.connected',
        entityType: 'org_connection',
        entityId: connectionId,
        extra: { provider: 'sage_intacct' },
      },
      {
        organizationId,
        userId: session.userId,
        role,
        supabase,
        mfaRequired: false,
        mfaSatisfied: true,
        enabledModules: new Set(['integrations']),
      },
    );

    const done = new URL(SETTINGS_PATH, appUrl);
    done.searchParams.set('connected', 'sage_intacct');
    return NextResponse.redirect(done, { status: 302 });
  } catch (err) {
    void reportError(err, { tag: 'intacct.callback' });
    return redirectWithError('connect_failed');
  }
}
