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
import { setPoDestinationWarehouseAction } from '@/server/actions/purchase-orders';

interface Props {
  poId: string;
  warehouses: Array<{ id: string; name: string }>;
}

/**
 * Inline picker that shows when a PO has no destination_location_id yet.
 * Receiving is gated on a destination, so without this the user is stuck.
 * On change → resolves a location for the chosen warehouse on the server
 * (auto-creates one if needed) → page refreshes → Receive button appears.
 */
export function PoSetDestination({ poId, warehouses }: Props) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function save() {
    if (!warehouseId) {
      toast.error('Pick a warehouse first');
      return;
    }
    setBusy(true);
    const r = await setPoDestinationWarehouseAction({ poId, warehouseId });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Destination set — Receive button is now available');
    router.refresh();
  }

  if (warehouses.length === 0) {
    return (
      <div className="border-warning/40 bg-warning/5 rounded-md border px-3 py-2 text-xs">
        This PO has no destination warehouse and no warehouses exist yet.
        Create one in Admin → Warehouses, then come back here.
      </div>
    );
  }

  return (
    <div className="border-warning/40 bg-warning/5 rounded-md border px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Warehouse className="h-3.5 w-3.5" />
        <span>
          <strong>No destination set.</strong> Pick a warehouse so receiving can
          post stock against this PO.
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select value={warehouseId} onValueChange={setWarehouseId}>
          <SelectTrigger className="h-8 max-w-[280px] text-xs">
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
        <Button size="sm" onClick={save} disabled={busy || !warehouseId}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Set destination'}
        </Button>
      </div>
    </div>
  );
}
