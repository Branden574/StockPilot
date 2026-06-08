import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ApiKeysPanel } from '@/components/settings/api-keys-panel';
import { IntegrationsPanel } from '@/components/settings/integrations-panel';
import { WebhooksPanel } from '@/components/settings/webhooks-panel';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ApiKeysService } from '@/server/services/api-keys';
import { ConnectionsService } from '@/server/services/connections';
import { IntegrationEndpointsService } from '@/server/services/integration-events';

import { hasPermission, isAdminRole } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Integrations — Settings' };

export default async function IntegrationsSettingsPage() {
  const ctx = await requireOrgContext();

  // This page hosts TWO independently-gated cards:
  //   - QuickBooks (the `integrations` module + `integrations:manage`)
  //   - EasyPost   (the off-by-default `shipping` module + `shipping:manage`)
  // An org may have only ONE of the two modules enabled, so the route must be
  // reachable when the caller can manage EITHER surface. We resolve both
  // module-access checks up front and combine them.
  const [integrationsAccess, shippingAccess, apiAccessAccess] = await Promise.all([
    checkModuleAccess('integrations'),
    checkModuleAccess('shipping'),
    checkModuleAccess('api_access'),
  ]);

  const showQbo =
    integrationsAccess.enabled && hasPermission(ctx.role, 'integrations:manage');
  // EasyPost (shipping) is a separate, off-by-default module gated on
  // `shipping:manage`. Only surface its card when the shipping module is on AND
  // the caller can manage it — otherwise hide it entirely (the connect action
  // is the server-side source of truth regardless).
  const showEasyPost = shippingAccess.enabled && hasPermission(ctx.role, 'shipping:manage');
  // Public API keys: the `api_access` premium module + admin role (matches the
  // ApiKeysService gate + RLS floor).
  const showApiKeys = apiAccessAccess.enabled && isAdminRole(ctx.role);

  // Permission gate FIRST — only owners/admins manage integrations. The tile
  // on /dashboard/settings is gated the same way; this redirect is the
  // server-side backstop for a direct URL hit. Reachable if the caller can
  // manage ANY surface.
  if (
    !hasPermission(ctx.role, 'integrations:manage') &&
    !hasPermission(ctx.role, 'shipping:manage') &&
    !showApiKeys
  ) {
    redirect('/dashboard');
  }

  // Both modules are OFF by default. Show the standard ModuleNotEnabled state
  // (with the Enable-in-Modules CTA) when NEITHER is enabled, rather than
  // loading connection data the org can't use. Name `integrations` (the primary
  // owner of this surface) in the CTA; if only shipping should be on, the
  // Modules page is one tap away from the same CTA.
  if (!integrationsAccess.enabled && !shippingAccess.enabled && !apiAccessAccess.enabled) {
    return <ModuleNotEnabled moduleId="integrations" canManage={integrationsAccess.canManage} />;
  }

  // Connections (QBO/EasyPost) load ONLY when integrations OR shipping is on —
  // an api_access-only org has neither, and ConnectionsService.list() gates on
  // those modules (it would throw). Default empty so the IntegrationsPanel
  // renders no cards in that case.
  type ConnRow = Awaited<ReturnType<ConnectionsService['list']>>['connections'][number];
  let qbo: ConnRow | null = null;
  let easypost: ConnRow | null = null;
  let health: Awaited<ReturnType<ConnectionsService['list']>>['health'] = [];
  let failedSyncs: Awaited<ReturnType<ConnectionsService['listFailedSyncs']>>['rows'] | null = null;
  if (integrationsAccess.enabled || shippingAccess.enabled) {
    const svc = await ConnectionsService.forCurrentUser();
    const listed = await svc.list();
    health = listed.health;
    qbo = showQbo ? listed.connections.find((c) => c.providerId === 'quickbooks') ?? null : null;
    easypost = showEasyPost
      ? listed.connections.find((c) => c.providerId === 'easypost') ?? null
      : null;
    // Operator dead-letter view (spans both providers) — only when a card shows.
    if (showQbo || showEasyPost) failedSyncs = (await svc.listFailedSyncs()).rows;
  }

  // Webhooks & alerts live under the same `integrations` module + manage perm as
  // the QBO card. Only load endpoints when the caller can see the panel.
  const showWebhooks =
    integrationsAccess.enabled && hasPermission(ctx.role, 'integrations:manage');
  const webhookEndpoints = showWebhooks
    ? await IntegrationEndpointsService.forCurrentUser().then((s) => s.list())
    : [];
  const apiKeys = showApiKeys
    ? await ApiKeysService.forCurrentUser().then((s) => s.list())
    : [];

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect StockPilot to your accounting tools. Exports are one-way — StockPilot pushes to
          the integration and never reads your data back.
        </p>
      </div>

      <IntegrationsPanel
        showQuickBooks={showQbo}
        status={qbo?.status ?? null}
        externalAccountId={qbo?.externalAccountId ?? null}
        lastConnectedAt={qbo?.lastConnectedAt ?? null}
        lastSyncedAt={qbo?.lastSyncedAt ?? null}
        lastError={qbo?.lastError ?? null}
        accountIds={qbo?.accountIds ?? {}}
        health={health}
        easyPost={
          showEasyPost
            ? {
                status: easypost?.status ?? null,
                mode: (easypost?.settings.mode as string | undefined) ?? null,
                lastConnectedAt: easypost?.lastConnectedAt ?? null,
                lastError: easypost?.lastError ?? null,
              }
            : null
        }
        failedSyncs={failedSyncs}
      />

      {showWebhooks && <WebhooksPanel endpoints={webhookEndpoints} />}
      {showApiKeys && <ApiKeysPanel apiKeys={apiKeys} />}
    </div>
  );
}
