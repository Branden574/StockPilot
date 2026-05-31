import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { IntegrationsPanel } from '@/components/settings/integrations-panel';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ConnectionsService } from '@/server/services/connections';

import { hasPermission } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Integrations — Settings' };

export default async function IntegrationsSettingsPage() {
  const ctx = await requireOrgContext();

  // This page hosts TWO independently-gated cards:
  //   - QuickBooks (the `integrations` module + `integrations:manage`)
  //   - EasyPost   (the off-by-default `shipping` module + `shipping:manage`)
  // An org may have only ONE of the two modules enabled, so the route must be
  // reachable when the caller can manage EITHER surface. We resolve both
  // module-access checks up front and combine them.
  const [integrationsAccess, shippingAccess] = await Promise.all([
    checkModuleAccess('integrations'),
    checkModuleAccess('shipping'),
  ]);

  const showQbo =
    integrationsAccess.enabled && hasPermission(ctx.role, 'integrations:manage');
  // EasyPost (shipping) is a separate, off-by-default module gated on
  // `shipping:manage`. Only surface its card when the shipping module is on AND
  // the caller can manage it — otherwise hide it entirely (the connect action
  // is the server-side source of truth regardless).
  const showEasyPost = shippingAccess.enabled && hasPermission(ctx.role, 'shipping:manage');

  // Permission gate FIRST — only owners/admins manage integrations. The tile
  // on /dashboard/settings is gated the same way; this redirect is the
  // server-side backstop for a direct URL hit. Reachable if the caller can
  // manage EITHER surface.
  if (!hasPermission(ctx.role, 'integrations:manage') && !hasPermission(ctx.role, 'shipping:manage')) {
    redirect('/dashboard');
  }

  // Both modules are OFF by default. Show the standard ModuleNotEnabled state
  // (with the Enable-in-Modules CTA) when NEITHER is enabled, rather than
  // loading connection data the org can't use. Name `integrations` (the primary
  // owner of this surface) in the CTA; if only shipping should be on, the
  // Modules page is one tap away from the same CTA.
  if (!integrationsAccess.enabled && !shippingAccess.enabled) {
    return <ModuleNotEnabled moduleId="integrations" canManage={integrationsAccess.canManage} />;
  }

  // list() is allowed when integrations OR shipping is enabled; it returns ALL
  // org_connections regardless of provider, and we pick out each card's row
  // only when that card is shown.
  const svc = await ConnectionsService.forCurrentUser();
  const { connections, health } = await svc.list();
  const qbo = showQbo ? connections.find((c) => c.providerId === 'quickbooks') ?? null : null;
  const easypost = showEasyPost
    ? connections.find((c) => c.providerId === 'easypost') ?? null
    : null;

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
      />
    </div>
  );
}
