import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit } from '@/server/services/audit';
import { putConnectionSecret } from '@/server/connectors/secret-store';

import { exchangeCode } from '@/server/connectors/quickbooks/oauth';

import { hasPermission, type Role } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SETTINGS_PATH = '/dashboard/settings/integrations';

/**
 * QuickBooks Online OAuth callback. Runs under the user session.
 *
 * Lifecycle:
 *  1. Verify the returned `state` against the PENDING org_connections row. The
 *     lookup uses the RLS-scoped user client, so a match proves both that the
 *     state is genuine AND that the user is a member of the owning org.
 *  2. Enforce the integrations module is enabled + the user holds
 *     `integrations:manage` for that org.
 *  3. Exchange the auth `code` for tokens (capturing `realmId`).
 *  4. Write the token blob to Supabase Vault via the SERVICE-ROLE admin client
 *     (connector_secret_* are revoked from `authenticated`).
 *  5. Flip the connection to `active`, stamp `external_account_id=realmId` +
 *     `secret_id`, clear `oauth_state`.
 *  6. Audit `integration.connected` and 302 back to the settings page.
 *
 * SECRET INVARIANT: tokens are written to Vault with the admin client only.
 * They never appear in the redirect URL, logs, or any client-readable column —
 * org_connections stores only the `secret_id` Vault handle.
 *
 * PRODUCT INVARIANT: one-way export only. This handler obtains the tokens that
 * let the connector PUSH to QBO; nothing here reads QBO data into StockPilot.
 */
export async function GET(req: Request) {
  const appUrl = env.NEXT_PUBLIC_APP_URL;

  const redirectWithError = (code: string) => {
    const url = new URL(SETTINGS_PATH, appUrl);
    url.searchParams.set('error', code);
    return NextResponse.redirect(url, { status: 302 });
  };

  // The user must be signed in to complete a connect they themselves started.
  // NOTE: /api/* routes are NOT covered by the proxy that sets (and strips)
  // x-stockpilot-user-id, so getServerSession() — which trusts that header — is
  // both spoofable AND empty here. Validate the cookie session directly with
  // auth.getUser(), the same way every other /api route does.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/signin', appUrl), { status: 302 });
  }

  const params = new URL(req.url).searchParams;

  // Intuit appends ?error=access_denied when the user declines the consent.
  if (params.get('error')) {
    return redirectWithError('access_denied');
  }

  const code = params.get('code');
  const state = params.get('state');
  const realmId = params.get('realmId');
  if (!code || !state || !realmId) {
    return redirectWithError('invalid_request');
  }

  try {
    // 1. Verify state against the PENDING row. RLS scopes this to the user's
    //    own orgs, so a hit proves both the CSRF state and org membership.
    const { data: conn, error: connErr } = await supabase
      .from('org_connections')
      .select('id, organization_id, status, oauth_state')
      .eq('provider_id', 'quickbooks')
      .eq('oauth_state', state)
      .eq('status', 'pending')
      .maybeSingle();
    if (connErr) {
      void reportError(connErr, { tag: 'qbo.callback.lookup' });
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
      .eq('user_id', user.id)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    const role = (member as { role: Role } | null)?.role;
    if (!role || !hasPermission(role, 'integrations:manage')) {
      return redirectWithError('forbidden');
    }

    // 3. Exchange the auth code for tokens + realmId.
    const tokens = await exchangeCode(code, realmId);

    // 4. Persist the token blob to Vault via the SERVICE-ROLE admin client. The
    //    user client (authenticated role) is NOT granted the secret RPCs. The
    //    secret name keys on the connection UUID (unique per org+provider).
    const admin = createAdminClient();
    const secretId = await putConnectionSecret(admin as never, `connector:${connectionId}`, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });

    // 5. Activate the connection. external_account_id holds the QBO realmId; the
    //    token itself stays in Vault, only the secret_id handle is stored.
    const { error: updateErr } = await admin
      .from('org_connections')
      .update({
        status: 'active',
        external_account_id: tokens.realmId,
        secret_id: secretId,
        oauth_state: null,
        last_connected_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', connectionId);
    if (updateErr) {
      void reportError(updateErr, { tag: 'qbo.callback.activate' });
      return redirectWithError('internal_error');
    }

    // 6. Audit. Pass an explicit minimal ServiceContext so audit() doesn't fall
    //    back to withContext() (which throws NEXT_REDIRECT in an API route).
    void audit(
      {
        event: 'integration.connected',
        entityType: 'org_connection',
        entityId: connectionId,
        extra: { provider: 'quickbooks' },
      },
      {
        organizationId,
        userId: user.id,
        role,
        supabase,
        mfaRequired: false,
        mfaSatisfied: true,
        enabledModules: new Set(['integrations']),
      },
    );

    const done = new URL(SETTINGS_PATH, appUrl);
    done.searchParams.set('connected', 'quickbooks');
    return NextResponse.redirect(done, { status: 302 });
  } catch (err) {
    // Never leak token material — log via the reporter (which scrubs) and send
    // the user back with a generic error code.
    void reportError(err, { tag: 'qbo.callback' });
    return redirectWithError('connect_failed');
  }
}
