import Link from 'next/link';

import { StatePanel } from '@/components/patterns/state-panel';
import { Button } from '@/components/ui/button';
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

interface ModuleNotEnabledProps {
  moduleId: ModuleId;
  canManage: boolean;
}

/**
 * Rendered by a module's dashboard page when the module is disabled for the
 * org. Shown in place of the normal page content — no data fetch happens.
 *
 * The look is P2.6's StatePanel, the one state component (PLAN P2.6, "One
 * owner per pattern"), at page size with its title as the page's only h1.
 * This file keeps the words, the next step and the page's gutters around the
 * panel (the shell's main has no padding of its own); PoAccessDenied and the
 * PO imports gate draw theirs the same way.
 */
export function ModuleNotEnabled({ moduleId, canManage }: ModuleNotEnabledProps) {
  const title = MODULE_REGISTRY[moduleId].title;
  return (
    <div className="w-full px-4 py-16 sm:px-8 sm:py-24">
      <StatePanel
        kind="module-off"
        size="page"
        headingLevel={1}
        title={<>{title} isn&apos;t enabled</>}
        description={<>This module isn&apos;t turned on for your organization.</>}
        action={
          canManage ? (
            <Button asChild variant="gradient">
              <Link href="/dashboard/settings/modules">Enable in Settings → Modules</Link>
            </Button>
          ) : (
            <p className="text-muted-foreground text-[13.5px]">
              Ask an owner or admin to enable it.
            </p>
          )
        }
      />
    </div>
  );
}
