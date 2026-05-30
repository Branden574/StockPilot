import Link from 'next/link';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { RentalsListTable } from '@/components/rentals/rentals-list-table';
import { RentalsTabs } from '@/components/rentals/rentals-tabs';
import { Button } from '@/components/ui/button';
import { requireOrgContext } from '@/lib/auth/session';
import { InventoryService } from '@/server/services/inventory';
import { RentalsService } from '@/server/services/rentals';
import { hasPermission } from '@stockpilot/core';
import { cn } from '@/lib/utils';

type StatusParam = 'out' | 'overdue' | 'returned' | 'cancelled' | 'all';

const VALID_STATUSES: Set<StatusParam> = new Set([
  'out',
  'overdue',
  'returned',
  'cancelled',
  'all',
]);

const SUB_TABS: Array<{ id: StatusParam; label: string }> = [
  { id: 'out', label: 'Out' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'returned', label: 'Returned' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];

function parseStatus(value: string | undefined): StatusParam {
  return value && VALID_STATUSES.has(value as StatusParam)
    ? (value as StatusParam)
    : 'out';
}

export default async function RentalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('rentals');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="rentals" canManage={moduleAccess.canManage} />;
  }
  const ctx = await requireOrgContext();
  // Viewers without rentals:create can still read (RLS allows any org member
  // with warehouse access); we just hide create/action buttons.
  const params = await searchParams;
  const status = parseStatus(params.status);
  const canCreate = hasPermission(ctx.role, 'rentals:create');

  const [rentalsSvc, inventorySvc] = await Promise.all([
    RentalsService.forCurrentUser(),
    InventoryService.forCurrentUser(),
  ]);

  const { rentals } = await rentalsSvc.list({ status });

  // Build a name map for the first-line item summary in each row.
  const allItemIds = [...new Set(rentals.flatMap((r) => r.lines.map((l) => l.item_id)))];
  const itemRows = allItemIds.length > 0 ? await inventorySvc.byIds(allItemIds) : [];
  const itemNames = new Map(itemRows.map((i) => [i.id, i.name]));

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rentals</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Track items checked out to staff, vendors, and event coordinators.
          </p>
        </div>
        {canCreate && (
          <Button asChild variant="gradient">
            <Link href="/dashboard/rentals/new">+ New rental</Link>
          </Button>
        )}
      </div>

      {/* Section tabs: Activity | Items */}
      <RentalsTabs activeTab="activity" />

      {/* Sub-tabs: Out | Overdue | Returned | Cancelled | All */}
      <div className="flex items-center gap-1 mt-4 mb-6 overflow-x-auto pb-0.5">
        {SUB_TABS.map((tab) => {
          const isActive = tab.id === status;
          return (
            <Link
              key={tab.id}
              href={`/dashboard/rentals?status=${tab.id}`}
              className={cn(
                'flex-none whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors',
                isActive
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {/* Table */}
      <RentalsListTable
        rentals={rentals}
        viewerRole={ctx.role}
        itemNames={itemNames}
      />
    </div>
  );
}
