import Link from 'next/link';
import { Lock, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

/**
 * The shell's state card: what a page shows IN PLACE of its content when the
 * person cannot use it (a module turned off, a permission they lack). One look
 * for every such page (DESIGN-SPEC 6.9 empty state on the card tokens): a
 * radius-8 hairline card, a quiet icon on the inset surface, the page's own
 * title as its one h1, the explanation in ink-3, then what to do.
 *
 * Used by ModuleNotEnabled, PoAccessDenied and the PO imports gate. Each
 * passes its own words; which pages explain and which redirect is decided by
 * the pages and layouts, never here.
 *
 * Interim (PLAN P2.3, gap-fill 2026-10-18): P2.6's patterns/state-panel.tsx is
 * the one state component. Until it merges this card draws the same thing
 * StatePanel draws at size "page" with a level-1 heading (the same box,
 * padding, icon disc, heading and text sizes), so the switch to it is a
 * no-op on screen. This file keeps no other state look.
 */
export function AccessStateCard({
  icon: Icon = Lock,
  title,
  description,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description: React.ReactNode;
  /** The next step: a button, or a line saying who can help. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    // The page's own gutters: the card stands in for a whole page.
    <div className={cn('w-full px-4 py-16 sm:px-8 sm:py-24', className)}>
      <div className="border-border bg-card mx-auto flex min-h-[280px] w-full min-w-0 max-w-2xl flex-col items-center justify-center gap-3 rounded-lg border px-6 py-12 text-center">
        <div
          aria-hidden="true"
          className="bg-sunk text-muted-foreground flex size-11 items-center justify-center rounded-full"
        >
          <Icon className="size-5" strokeWidth={1.75} />
        </div>
        <h1 className="text-foreground max-w-md font-display text-[20px] font-medium leading-[30px] tracking-[-0.02em]">
          {title}
        </h1>
        <p className="text-muted-foreground max-w-md text-[13.5px] leading-[20.25px]">
          {description}
        </p>
        {children ? (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

interface ModuleNotEnabledProps {
  moduleId: ModuleId;
  canManage: boolean;
}

/**
 * Rendered by a module's dashboard page when the module is disabled for the
 * org. Shown in place of the normal page content — no data fetch happens.
 */
export function ModuleNotEnabled({ moduleId, canManage }: ModuleNotEnabledProps) {
  const title = MODULE_REGISTRY[moduleId].title;
  return (
    <AccessStateCard
      title={<>{title} isn&apos;t enabled</>}
      description={<>This module isn&apos;t turned on for your organization.</>}
    >
      {canManage ? (
        <Button asChild variant="gradient">
          <Link href="/dashboard/settings/modules">Enable in Settings → Modules</Link>
        </Button>
      ) : (
        <p className="text-muted-foreground text-[13.5px]">Ask an owner or admin to enable it.</p>
      )}
    </AccessStateCard>
  );
}
