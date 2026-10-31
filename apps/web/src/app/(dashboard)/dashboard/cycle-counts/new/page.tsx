import Link from 'next/link';
import { redirect } from 'next/navigation';

import { NewCycleCount } from '@/components/cycle-counts/new-cycle-count';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { Button } from '@/components/ui/button';
import { requireOrgContext } from '@/lib/auth/session';
import { getModulesForRequest } from '@/lib/dashboard/request-cache';
import { createClient } from '@/lib/supabase/server';
import { fetchCountAssignees, type CountAssignee } from '@/server/lib/count-assignees';
import { WarehousesService } from '@/server/services/warehouses';

import { can, COUNT_START_MANAGER_ONLY_COPY, countStartManagerOnly } from '@stockpilot/core';

/** The page area (DESIGN-SPEC 4 and 5.3), the same box the list page and the
 *  shell's loading skeleton draw. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function NewCycleCountPage() {
  // Submit asserts stock:adjust. Without this gate viewers/staff
  // would land on the form and only learn they can't submit when
  // they click Start. Matches the sibling /cycle-counts list page.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'stock:adjust')) {
    redirect('/dashboard');
  }

  // Only a manager with cycle_counts:assign and stock:adjust can start a count
  // (B42; the server's assertCountStartFloors). Staff hold stock:adjust, so
  // they passed the gate above, filled in the form and learned at Start, from
  // the raw words "Missing permission: cycle_counts:assign", that it is
  // refused. The command palette and the n c shortcut still lead here, so the
  // page says why, with the way back, and reads nothing more.
  if (countStartManagerOnly({ role: ctx.role, permissions: ctx.permissions })) {
    return (
      <div className={PAGE}>
        <PageHeader
          back={
            <PageHeaderBackLink href="/dashboard/cycle-counts">
              ← Back to cycle counts
            </PageHeaderBackLink>
          }
          title="Start a count"
          className="max-w-[880px]"
        />
        <StatePanel
          kind="forbidden"
          title={COUNT_START_MANAGER_ONLY_COPY}
          className="w-full max-w-[880px]"
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/cycle-counts">Back to cycle counts</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const warehousesSvc = await WarehousesService.forCurrentUser();
  const [warehouses, supabase, enabledModules] = await Promise.all([
    warehousesSvc.listNames(),
    createClient(),
    // Gates the "Product groups" scope. An org without the sports module sees
    // the picker exactly as it was.
    getModulesForRequest(ctx.organizationId),
  ]);
  const sportsEnabled = enabledModules.has('sports');

  // Manager+ can assign a count to a teammate at creation time. Only
  // fetch the member list when they actually can (mirrors the detail page).
  const canAssign = can(ctx, 'cycle_counts:assign');
  let members: CountAssignee[] = [];
  if (canAssign) {
    // One member source for every count assignee picker (count-assignees.ts).
    // A failed read shows no members here, as it always did.
    members = await fetchCountAssignees(supabase, ctx.organizationId).catch(() => []);
  }

  return (
    <div className={PAGE}>
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/cycle-counts">
            ← Back to cycle counts
          </PageHeaderBackLink>
        }
        title="Start a count"
        subline="Pick the exact items to count below, or snapshot a whole warehouse. Starting the count records each item's current quantity-on-hand so we can compute variance later."
        className="max-w-[880px]"
      />
      {/* One form card at a reading width (the shared form pattern): the scope
          switch, then the picker and its review, or the whole-warehouse form. */}
      <section
        aria-labelledby="start-count-scope"
        className="border-border bg-card text-card-foreground w-full max-w-[880px] rounded-lg border"
      >
        <div className="border-border border-b px-[18px] py-3.5">
          <h2 id="start-count-scope" className="text-[13.5px] font-medium leading-5">
            Scope
          </h2>
        </div>
        <div className="p-[18px]">
          <NewCycleCount
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            members={members}
            canAssign={canAssign}
            sportsEnabled={sportsEnabled}
          />
        </div>
      </section>
    </div>
  );
}
