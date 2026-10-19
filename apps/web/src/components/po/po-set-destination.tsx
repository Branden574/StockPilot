'use client';

import { Loader2, Warehouse } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { setPoDestinationWarehouseAction } from '@/server/actions/purchase-orders';

interface Props {
  poId: string;
  warehouses: Array<{ id: string; name: string }>;
  /**
   * True when the PO HAS a destination location but it isn't linked to a
   * warehouse (so receiving can't resolve a target). Distinct from the
   * no-destination-at-all case purely for the explanatory copy.
   */
  hasUnreceivableDestination?: boolean;
}

/**
 * Inline picker that shows when a PO can't resolve a receiving warehouse —
 * either no destination is set, or its destination location has no warehouse.
 * Receiving is gated on a warehouse, so without this the user is stuck.
 * On change → resolves a location for the chosen warehouse on the server
 * (auto-creates one if needed) → page refreshes → Receive button appears.
 */
export function PoSetDestination({ poId, warehouses, hasUnreceivableDestination }: Props) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function save() {
    if (!warehouseId) {
      toast.error('Pick a destination warehouse first.');
      return;
    }
    setBusy(true);
    const r = await setPoDestinationWarehouseAction({ poId, warehouseId });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Destination set. The Receive button is now available.');
    router.refresh();
  }

  // A quiet caution banner under the page header (the caution wash with its
  // hairline, words in ink, the icon in the caution tone), in both themes:
  // the old fixed-amber tint was all but invisible in dark.
  if (warehouses.length === 0) {
    return (
      <div className={cn(BANNER, 'flex items-start gap-2.5')}>
        <Warehouse aria-hidden className="text-warning mt-0.5 h-4 w-4 shrink-0" />
        <p>
          This PO has no destination warehouse and no warehouses exist yet. Create one in Admin →
          Warehouses, then come back here.
        </p>
      </div>
    );
  }

  return (
    <div className={BANNER}>
      <div className="flex items-start gap-2.5">
        <Warehouse aria-hidden className="text-warning mt-0.5 h-4 w-4 shrink-0" />
        <p>
          {hasUnreceivableDestination ? (
            <>
              <strong className="font-medium">
                This PO&apos;s destination isn&apos;t linked to a warehouse.
              </strong>{' '}
              Received stock has nowhere to go, so the Receive button is hidden. Pick a warehouse
              below to fix it.
            </>
          ) : (
            <>
              <strong className="font-medium">No destination set.</strong> Pick a warehouse so
              receiving can post stock against this PO.
            </>
          )}
        </p>
      </div>
      {/* The secondary button: on a draft the page's one ink button is Mark as
          ordered, which shows beside this banner. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 sm:pl-[26px]">
        <Select value={warehouseId} onValueChange={setWarehouseId}>
          <SelectTrigger className="w-full sm:w-[280px]">
            <SelectValue placeholder="Pick warehouse" />
          </SelectTrigger>
          <SelectContent>
            {warehouses.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={save} disabled={busy || !warehouseId}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Set destination
        </Button>
      </div>
    </div>
  );
}

const BANNER =
  'border-warning/40 bg-warning-wash text-foreground rounded-lg border px-4 py-3 text-[13px] leading-5';
