'use client';

import { Pencil, Send, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { capture } from '@/lib/analytics';
import { updatePoStatusAction } from '@/server/actions/purchase-orders';

/**
 * The status actions of a purchase order's page: Edit and Mark as ordered on a
 * draft, Cancel PO until it is cancelled or received. Every reader sees them;
 * the server refuses those who may not (unchanged).
 *
 * `part` splits them for the page header's hierarchy (DESIGN-SPEC 6.2: one
 * ink-filled button, the commit, after the secondary ones): `secondary` draws
 * Edit and Cancel PO, `commit` draws Mark as ordered, and the default `all`
 * draws the three in their old order. Each button keeps its own busy state,
 * as before.
 */
export function PoActions({
  poId,
  status,
  part = 'all',
}: {
  poId: string;
  status: string;
  part?: 'all' | 'secondary' | 'commit';
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function setStatus(next: 'draft' | 'ordered' | 'cancelled') {
    setBusy(next);
    const res = await updatePoStatusAction(poId, next);
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    // Product analytics (no-op until PostHog is configured).
    if (next === 'ordered') {
      capture('purchase_order_ordered', { po_id: poId });
    }
    toast.success(`Purchase order marked as ${next}.`);
    router.refresh();
  }

  const secondary = part !== 'commit';
  const commit = part !== 'secondary';

  return (
    <>
      {secondary && status === 'draft' && (
        <Button variant="outline" asChild>
          <Link href={`/dashboard/purchase-orders/${poId}/edit`}>
            <Pencil className="h-4 w-4" /> Edit
          </Link>
        </Button>
      )}
      {commit && status === 'draft' && (
        <Button
          variant="default"
          disabled={busy === 'ordered'}
          onClick={() => setStatus('ordered')}
        >
          <Send className="h-4 w-4" /> Mark as ordered
        </Button>
      )}
      {secondary && status !== 'cancelled' && status !== 'received' && (
        <Button
          variant="outline"
          disabled={busy === 'cancelled'}
          onClick={() => setStatus('cancelled')}
        >
          <X className="h-4 w-4" /> Cancel PO
        </Button>
      )}
    </>
  );
}
