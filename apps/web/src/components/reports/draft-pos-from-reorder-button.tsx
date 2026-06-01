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
 * for review. Drafts are NOT auto-sent.
 *
 * Disabled when there is nothing below par.
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
    const { createdPoIds, unassignedCount, supplierFailures, supplierCount } = r.data;
    const created = createdPoIds.length;
    if (created === 0) {
      toast.error(
        supplierFailures.length > 0
          ? `Couldn't create any draft POs. ${supplierFailures[0]?.error ?? 'Try again.'}`
          : 'Nothing to reorder — no items are below their reorder point.',
      );
      return;
    }
    const parts: string[] = [
      `Created ${created} draft PO${created === 1 ? '' : 's'} across ${supplierCount} supplier${supplierCount === 1 ? '' : 's'}`,
    ];
    if (unassignedCount > 0) {
      parts.push(`${unassignedCount} item${unassignedCount === 1 ? '' : 's'} on an unassigned draft (set a supplier)`);
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
