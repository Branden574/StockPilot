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
  // Permission gate FIRST — only owners/admins manage integrations. The tile
  // on /dashboard/settings is gated the same way; this redirect is the
  // server-side backstop for a direct URL hit.
  if (!hasPermission(ctx.role, 'integrations:manage')) {
    redirect('/dashboard');
  }

  // The integrations module is OFF by default. Show the standard
  // ModuleNotEnabled state (with the Enable-in-Modules CTA) when it's off,
  // rather than loading connection data the org can't use.
  const moduleAccess = await checkModuleAccess('integrations');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="integrations" canManage={moduleAccess.canManage} />;
  }

  const svc = await ConnectionsService.forCurrentUser();
  const { connections, health } = await svc.list();
  const qbo = connections.find((c) => c.providerId === 'quickbooks') ?? null;

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
        status={qbo?.status ?? null}
        externalAccountId={qbo?.externalAccountId ?? null}
        lastConnectedAt={qbo?.lastConnectedAt ?? null}
        lastSyncedAt={qbo?.lastSyncedAt ?? null}
        lastError={qbo?.lastError ?? null}
        accountIds={qbo?.accountIds ?? {}}
        health={health}
      />
    </div>
  );
}
