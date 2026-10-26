import { checkModuleAccess } from '@/lib/modules/module-gate';
import { effectiveNavLabel } from '@/lib/nav-labels';
import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader } from '@/components/patterns/page-header';
import { LocalDateTime } from '@/components/ui/local-datetime';
import { ConnectionsService } from '@/server/services/connections';
import { ZendeskConnectCard } from '@/components/zendesk/zendesk-connect-card';
import { ZendeskQuickAccess } from '@/components/zendesk/zendesk-quick-access';
import { ZendeskLogo } from '@/components/dashboard/zendesk-logo';
import { withContext } from '@/server/services/context';

import { can } from '@stockpilot/core';

export const dynamic = 'force-dynamic';

export default async function ZendeskPage() {
  const access = await checkModuleAccess('zendesk');
  if (!access.enabled) return <ModuleUnavailable moduleId="zendesk" access={access} />;

  const ctx = await withContext();
  const canManage = can(ctx, 'integrations:manage');

  const svc = await ConnectionsService.forCurrentUser();
  const [conn, title] = await Promise.all([
    svc.getZendeskConnection(),
    // The heading follows a Settings > Navigation rename of Zendesk (PLAN
    // rule 10), from the request-cached org row the layout already holds;
    // an unreadable row keeps the page's own heading.
    effectiveNavLabel('/dashboard/zendesk', 'Zendesk').catch(() => 'Zendesk'),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      {/* The subline promised "(soon) an in-app agent console"; the web has
          no console, and the redesign promises nothing that is not there
          (CONFLICTS D23). */}
      <PageHeader
        media={
          <span className="border-border bg-card flex size-11 items-center justify-center rounded-lg border">
            <ZendeskLogo size={24} className="text-foreground" />
          </span>
        }
        title={title}
        subline="Support tickets."
      />

      <DetailSection title="Connection">
        {conn?.status === 'active' ? (
          <p className="text-muted-foreground text-[13.5px]">
            Connected{conn.subdomain ? ` to ${conn.subdomain}.zendesk.com` : ''}
            {/* The browser's own zone and clock: on the server this read
                UTC (Vercel), a different wall-clock time for the viewer. */}
            {conn.lastConnectedAt ? (
              <LocalDateTime iso={conn.lastConnectedAt} prefix=" · since " />
            ) : null}
            .
          </p>
        ) : (
          <p className="text-muted-foreground text-[13.5px]">
            {conn?.lastError ? `Last error: ${conn.lastError}` : 'Not connected yet.'}
          </p>
        )}
        {canManage ? (
          <div className="mt-4">
            <ZendeskConnectCard status={conn?.status ?? null} subdomain={conn?.subdomain ?? null} />
          </div>
        ) : (
          <p className="text-muted-foreground mt-3 text-[12.5px]">Ask an admin to connect Zendesk.</p>
        )}
      </DetailSection>

      <DetailSection title="Open your Zendesk">
        <p className="text-muted-foreground mb-4 text-[13.5px]">
          View and work your tickets in the full Zendesk agent interface, signed in with your
          normal Zendesk login — no API key needed.
        </p>
        <ZendeskQuickAccess subdomain={conn?.subdomain ?? null} canManage={canManage} />
      </DetailSection>
    </div>
  );
}
