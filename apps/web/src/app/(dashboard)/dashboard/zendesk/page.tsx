import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ConnectionsService } from '@/server/services/connections';
import { ZendeskConnectCard } from '@/components/zendesk/zendesk-connect-card';
import { ZendeskLogo } from '@/components/dashboard/zendesk-logo';
import { withContext } from '@/server/services/context';

import { hasPermission } from '@stockpilot/core';

export const dynamic = 'force-dynamic';

export default async function ZendeskPage() {
  const access = await checkModuleAccess('zendesk');
  if (!access.enabled) return <ModuleNotEnabled moduleId="zendesk" canManage={access.canManage} />;

  const ctx = await withContext();
  const canManage = hasPermission(ctx.role, 'integrations:manage');

  const svc = await ConnectionsService.forCurrentUser();
  const conn = await svc.getZendeskConnection();

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center gap-3">
        <ZendeskLogo size={28} className="text-foreground" />
        <div>
          <h1 className="font-display text-2xl">Zendesk</h1>
          <p className="text-muted-foreground text-sm">Support tickets + (soon) an in-app agent console.</p>
        </div>
      </header>

      <section className="bg-card rounded-xl border p-4">
        <h2 className="text-sm font-medium">Connection</h2>
        {conn?.status === 'active' ? (
          <p className="text-muted-foreground mt-1 text-sm">
            Connected{conn.subdomain ? ` to ${conn.subdomain}.zendesk.com` : ''}
            {conn.lastConnectedAt ? ` · since ${new Date(conn.lastConnectedAt).toLocaleString()}` : ''}.
          </p>
        ) : (
          <p className="text-muted-foreground mt-1 text-sm">
            {conn?.lastError ? `Last error: ${conn.lastError}` : 'Not connected yet.'}
          </p>
        )}
        {canManage ? (
          <div className="mt-3">
            <ZendeskConnectCard status={conn?.status ?? null} subdomain={conn?.subdomain ?? null} />
          </div>
        ) : (
          <p className="text-muted-foreground mt-3 text-xs">Ask an admin to connect Zendesk.</p>
        )}
      </section>

      <section className="bg-card rounded-xl border p-4">
        <h2 className="text-sm font-medium">Agent console</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Coming next: view and reply to tickets, set status/priority/assignee, search, and macros — with the
          requesting order &amp; inventory context side-by-side, right here in StockPilot. Once connected, these
          events automatically open tickets: new returns, public order requests, and order problems.
        </p>
      </section>
    </div>
  );
}
