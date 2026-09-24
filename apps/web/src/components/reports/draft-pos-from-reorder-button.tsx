'use client';

import { FileStack, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { createDraftPosFromReorderForecastAction } from '@/server/actions/purchase-orders';

/**
 * "Draft PO from reorder suggestions" button for the reorder-forecast
 * report. Calls the server action that groups below-par items by supplier
 * into editable DRAFT purchase orders, then routes the user to the drafts
 * for review. Drafts are NOT auto-sent. Items already on an open PO are
 * skipped by the action, and the toast says how many.
 *
 * Disabled when `itemCount` is 0 (nothing below par, or on the Planning page
 * nothing below par that is not already on order).
 */
export function DraftPosFromReorderButton({ itemCount }: { itemCount: number }) {
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
    const { createdPoIds, unassignedCount, supplierFailures, supplierCount, skippedOnOpenPo } =
      r.data;
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
    const parts: string[] = [
      `Created ${created} draft PO${created === 1 ? '' : 's'} across ${supplierCount} supplier${supplierCount === 1 ? '' : 's'}`,
    ];
    if (unassignedCount > 0) {
      parts.push(`${unassignedCount} item${unassignedCount === 1 ? '' : 's'} on an unassigned draft (set a supplier)`);
    }
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
    <Button onClick={run} disabled={busy || itemCount === 0}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileStack className="h-4 w-4" />}
      Draft PO from suggestions
    </Button>
  );
}
