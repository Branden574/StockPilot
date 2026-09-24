'use client';

import { FileStack, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { createDraftPosFromReorderForecastAction } from '@/server/actions/purchase-orders';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The first clause of the success toast, from what was actually created.
 * The action makes one draft per supplier plus, when some below-par items
 * have no supplier, ONE draft for all of those (`unassignedCount` items; 0
 * when that draft was not created). Counting suppliers from the drafts
 * created, not from the suppliers attempted, keeps a failed supplier out of
 * the count, and a run that drafted only no-supplier items reads as such
 * instead of "Created 1 draft PO across 0 suppliers". Not exported: this is
 * a 'use client' module (a plain function exported from one cannot be called
 * from the server), and the tests reach it through the toast.
 */
function draftsCreatedHeadline(created: number, unassignedCount: number): string {
  const unassignedDrafts = unassignedCount > 0 ? 1 : 0;
  const supplierDrafts = Math.max(0, created - unassignedDrafts);
  const noSupplierPart = `${plural(unassignedCount, 'item', 'items')} with no supplier yet (set one on the draft)`;
  if (supplierDrafts === 0) {
    return `Created 1 draft PO for ${noSupplierPart}`;
  }
  const supplierPart = `${plural(supplierDrafts, 'draft PO', 'draft POs')} across ${plural(supplierDrafts, 'supplier', 'suppliers')}`;
  if (unassignedDrafts === 0) return `Created ${supplierPart}`;
  return `Created ${created} draft POs: ${supplierDrafts} across ${plural(supplierDrafts, 'supplier', 'suppliers')} and 1 for ${noSupplierPart}`;
}

/**
 * "Draft PO from reorder suggestions" button for the reorder-forecast
 * report. Calls the server action that groups below-par items by supplier
 * into editable DRAFT purchase orders, then routes the user to the drafts
 * for review. Drafts are NOT auto-sent. Items already on an open PO are
 * skipped by the action, and the toast says how many.
 *
 * Disabled when `itemCount` is 0 (nothing below par, or on the Planning page
 * nothing below par that is not already on order), unless `countIsPartial`:
 * then the count covers only part of the catalog (the Planning page ranks at
 * most PLANNING_MAX_ITEMS items) while the action checks every item, so a 0
 * proves nothing and the button stays usable. The action answers "Nothing to
 * reorder" itself when that is true.
 */
export function DraftPosFromReorderButton({
  itemCount,
  countIsPartial = false,
}: {
  itemCount: number;
  countIsPartial?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function run() {
    setBusy(true);
    const r = await createDraftPosFromReorderForecastAction();
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    const { createdPoIds, unassignedCount, supplierFailures, skippedOnOpenPo } = r.data;
    const created = createdPoIds.length;
    if (created === 0) {
      if (supplierFailures.length > 0) {
        toast.error(`Couldn't create any draft POs. ${supplierFailures[0]?.error ?? 'Try again.'}`);
      } else if (skippedOnOpenPo > 0) {
        // Nothing failed: every below-par item is already on order.
        toast.info(
          skippedOnOpenPo === 1
            ? 'The 1 below-par item is already on an open purchase order.'
            : `All ${skippedOnOpenPo} below-par items are already on open purchase orders.`,
        );
      } else {
        toast.error('Nothing to reorder — no items are below their reorder point.');
      }
      return;
    }
    const parts: string[] = [draftsCreatedHeadline(created, unassignedCount)];
    if (skippedOnOpenPo > 0) {
      parts.push(`${skippedOnOpenPo} already on open POs (skipped)`);
    }
    if (supplierFailures.length > 0) {
      const names = supplierFailures.map((f) => f.supplierName).join(', ');
      parts.push(`failed: ${names}`);
    }
    toast.success(`${parts.join(' · ')}. Review before sending.`);
    // Route to the created drafts for review/edit. Single draft -> straight
    // to it; multiple -> the drafts list filtered to status=draft.
    if (createdPoIds.length === 1) {
      router.push(`/dashboard/purchase-orders/${createdPoIds[0]}`);
    } else {
      router.push('/dashboard/purchase-orders?status=draft');
    }
    router.refresh();
  }

  return (
    <Button onClick={run} disabled={busy || (itemCount === 0 && !countIsPartial)}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileStack className="h-4 w-4" />}
      Draft PO from suggestions
    </Button>
  );
}
