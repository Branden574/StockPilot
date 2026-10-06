'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { recurringPoSeedHref, storeRecurringPoSeed } from '@/lib/purchase-orders/recurring-seed';
import { seedRecurringTemplateFromPoAction } from '@/server/actions/recurring-pos';

interface Props {
  poId: string;
}

/**
 * Appears on the PO detail page. Fetches the seed payload from the server
 * action, stores it under this PO's id and opens
 * /dashboard/purchase-orders/recurring?from=<poId>, where the create form
 * opens filled in with it (lib/purchase-orders/recurring-seed.ts).
 */
export function MakeRecurringButton({ poId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function handle() {
    setBusy(true);
    const res = await seedRecurringTemplateFromPoAction(poId);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    const { linesLeftOff, ...seed } = res.data;
    // The recurring page takes the seed from this tab's sessionStorage
    // (RecurringTemplatesSeedLoader). If the browser refuses to store it,
    // that page would open without it: say so and stay here instead.
    if (!storeRecurringPoSeed(poId, seed)) {
      toast.error(
        "This browser blocked passing the purchase order's details to Recurring purchase orders. Allow site data for StockPilot and try again.",
      );
      return;
    }
    // Lines whose item was deleted, or that are a kit's pre-assembled stock,
    // can never be ordered, so the seed leaves them out; say so rather than
    // dropping them without a word.
    if (linesLeftOff > 0) {
      toast.info(
        `${linesLeftOff} line${linesLeftOff === 1 ? ' was' : 's were'} left out: the item was deleted or is a pre-assembled kit, which is never ordered.`,
      );
    }
    router.push(recurringPoSeedHref(poId));
  }

  return (
    <Button variant="outline" size="sm" onClick={handle} disabled={busy}>
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <RefreshCw className="h-4 w-4" />
      )}
      Make recurring
    </Button>
  );
}
