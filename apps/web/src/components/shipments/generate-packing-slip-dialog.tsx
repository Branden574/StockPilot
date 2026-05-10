'use client';

import { Loader2, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { createShipmentFromOrderRequestAction } from '@/server/actions/shipments';

interface SourceWarehouseOption {
  id: string;
  name: string;
}

interface CharterOption {
  id: string;
  name: string;
  code: string | null;
}

interface WarehouseCharterPair {
  warehouse_id: string;
  charter_id: string;
}

export function GeneratePackingSlipDialog({
  orderRequestId,
  sourceWarehouses,
  charters,
  warehouseCharterPairs,
}: {
  orderRequestId: string;
  sourceWarehouses: SourceWarehouseOption[];
  charters: CharterOption[];
  warehouseCharterPairs: WarehouseCharterPair[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [sourceWarehouseId, setSourceWarehouseId] = React.useState<string>(
    () => sourceWarehouses[0]?.id ?? '',
  );
  const [destinationCharterId, setDestinationCharterId] =
    React.useState<string>('');
  const [attentionToName, setAttentionToName] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [ccEmails, setCcEmails] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setSourceWarehouseId(sourceWarehouses[0]?.id ?? '');
    setDestinationCharterId('');
    setAttentionToName('');
    setNotes('');
    setCcEmails('');
  }, [open, sourceWarehouses]);

  // Filter charters by selected source via the warehouse_charters junction.
  const chartersByWarehouse = React.useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of warehouseCharterPairs) {
      const set = m.get(p.warehouse_id) ?? new Set<string>();
      set.add(p.charter_id);
      m.set(p.warehouse_id, set);
    }
    return m;
  }, [warehouseCharterPairs]);

  const filteredCharters = React.useMemo(() => {
    if (!sourceWarehouseId) return [] as CharterOption[];
    const allowed = chartersByWarehouse.get(sourceWarehouseId);
    if (!allowed || allowed.size === 0) return [];
    return charters.filter((c) => allowed.has(c.id));
  }, [charters, chartersByWarehouse, sourceWarehouseId]);

  // Reset destination when source changes if previous charter isn't serviced.
  React.useEffect(() => {
    if (
      destinationCharterId &&
      !filteredCharters.some((c) => c.id === destinationCharterId)
    ) {
      setDestinationCharterId('');
    }
  }, [filteredCharters, destinationCharterId]);

  async function submit() {
    if (!sourceWarehouseId) {
      toast.error('Pick a source warehouse');
      return;
    }
    if (!destinationCharterId) {
      toast.error('Pick a destination charter');
      return;
    }
    const ccList = ccEmails
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setSubmitting(true);
    const res = await createShipmentFromOrderRequestAction({
      orderRequestId,
      sourceWarehouseId,
      destinationCharterId,
      attentionToName: attentionToName.trim() ? attentionToName.trim() : null,
      notes: notes.trim() ? notes.trim() : null,
      ccEmails: ccList.length > 0 ? ccList : undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Packing slip created');
    setOpen(false);
    router.push(`/dashboard/shipments/${res.data.id}`);
  }

  const disabled = sourceWarehouses.length === 0;
  const canSubmit = !!sourceWarehouseId && !!destinationCharterId;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" disabled={disabled}>
          <Truck className="h-3.5 w-3.5" />
          Generate packing slip
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate packing slip</DialogTitle>
          <DialogDescription>
            Create a draft shipment from this order request. Pick the source
            warehouse and the receiving charter, then continue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="source-wh">Shipping from</Label>
            <Select
              value={sourceWarehouseId}
              onValueChange={(v) => setSourceWarehouseId(v)}
            >
              <SelectTrigger id="source-wh">
                <SelectValue placeholder="Select a source warehouse" />
              </SelectTrigger>
              <SelectContent>
                {sourceWarehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sourceWarehouses.length === 0 && (
              <p className="text-muted-foreground text-xs">
                You don&apos;t have write access to any warehouse — can&apos;t
                generate a packing slip.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dest-charter">Shipping to (charter)</Label>
            <Select
              value={destinationCharterId}
              onValueChange={(v) => setDestinationCharterId(v)}
              disabled={!sourceWarehouseId || filteredCharters.length === 0}
            >
              <SelectTrigger id="dest-charter">
                <SelectValue placeholder="Select a destination charter" />
              </SelectTrigger>
              <SelectContent>
                {filteredCharters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.code ? (
                      <span className="text-muted-foreground text-xs"> ({c.code})</span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sourceWarehouseId && filteredCharters.length === 0 && (
              <p className="text-muted-foreground text-xs">
                This warehouse doesn&apos;t service any charters yet. Add
                charter assignments in Admin → Warehouses.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="attention">
              Attention to
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="attention"
              value={attentionToName}
              onChange={(e) => setAttentionToName(e.target.value)}
              placeholder="Principal, receiving clerk, etc."
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">
              Notes
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              placeholder="Anything the receiver needs to know"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cc">
              CC emails
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="cc"
              value={ccEmails}
              onChange={(e) => setCcEmails(e.target.value)}
              placeholder="principal@school.org, ops@charter.org"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated. Used by the Phase 2B signed-PDF email.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || disabled || !canSubmit} variant="gradient">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create packing slip'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
