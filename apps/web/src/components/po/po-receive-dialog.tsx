'use client';

import { Loader2, PackageCheck } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { postReceiptAction } from '@/server/actions/receiving';

interface Line {
  id: string;
  name: string;
  sku: string;
  quantityOrdered: number;
  quantityReceived: number;
}

interface PoReceiveDialogProps {
  poId: string;
  poNumber: string;
  warehouseId: string;
  lines: Line[];
}

interface LineEntry {
  received: number;
  accepted: number;
  rejected: number;
  notes: string;
}

function blankEntry(remaining: number): LineEntry {
  const r = Math.max(remaining, 0);
  return { received: r, accepted: r, rejected: 0, notes: '' };
}

export function PoReceiveDialog({
  poId,
  poNumber,
  warehouseId,
  lines,
}: PoReceiveDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  const [entries, setEntries] = React.useState<Record<string, LineEntry>>(() =>
    Object.fromEntries(
      lines.map((l) => [l.id, blankEntry(l.quantityOrdered - l.quantityReceived)]),
    ),
  );

  // Idempotency key: one per dialog open. New key when re-opening (resets state).
  const [idempotencyKey, setIdempotencyKey] = React.useState(() => crypto.randomUUID());

  React.useEffect(() => {
    if (open) {
      setIdempotencyKey(crypto.randomUUID());
      setEntries(
        Object.fromEntries(
          lines.map((l) => [l.id, blankEntry(l.quantityOrdered - l.quantityReceived)]),
        ),
      );
      setNotes('');
    }
  }, [open, lines]);

  function setField(lineId: string, patch: Partial<LineEntry>) {
    setEntries((m) => ({
      ...m,
      [lineId]: { ...(m[lineId] ?? blankEntry(0)), ...patch },
    }));
  }

  async function submit() {
    const submittable = lines
      .map((l) => ({ line: l, entry: entries[l.id] ?? blankEntry(0) }))
      .filter(({ entry }) => entry.received > 0);
    if (submittable.length === 0) {
      toast.error('Enter at least one received quantity');
      return;
    }

    // Per-line validation: accepted + rejected ≤ received
    for (const { line, entry } of submittable) {
      if (entry.accepted + entry.rejected > entry.received + 0.0001) {
        toast.error(`Line "${line.name}": accepted + rejected can't exceed received`);
        return;
      }
    }

    setSubmitting(true);
    const res = await postReceiptAction({
      purchaseOrderId: poId,
      warehouseId,
      lines: submittable.map(({ line, entry }) => ({
        poLineId: line.id,
        qtyReceived: entry.received,
        qtyAccepted: entry.accepted,
        qtyRejected: entry.rejected,
        notes: entry.notes || undefined,
      })),
      notes: notes || undefined,
      idempotencyKey,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Receipt ${res.data.receiptNumber} posted against ${poNumber}`);
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="gradient">
          <PackageCheck className="h-4 w-4" /> Receive
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Receive {poNumber}</DialogTitle>
          <DialogDescription>
            Enter received, accepted, and rejected quantities per line. Only
            accepted quantities increase usable stock — rejected/damaged units
            are recorded but stay out of inventory.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-y-auto">
          {lines.map((l) => {
            const remaining = l.quantityOrdered - l.quantityReceived;
            const e = entries[l.id] ?? blankEntry(remaining);
            return (
              <div key={l.id} className="grid gap-3 rounded-md border p-3 sm:grid-cols-12">
                <div className="sm:col-span-5">
                  <p className="font-medium">{l.name}</p>
                  <p className="text-muted-foreground font-mono text-xs">{l.sku}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Ordered {l.quantityOrdered} · Already received {l.quantityReceived}{' '}
                    · Remaining {remaining}
                  </p>
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <Label className="text-muted-foreground text-[11px]">Received</Label>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={e.received}
                    onChange={(ev) => {
                      const v = Math.max(0, Number(ev.target.value) || 0);
                      // Auto-adjust accepted if it exceeds new received
                      const accepted = Math.min(e.accepted, v);
                      const rejected = Math.min(e.rejected, v - accepted);
                      setField(l.id, { received: v, accepted, rejected });
                    }}
                  />
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <Label className="text-muted-foreground text-[11px]">Accepted</Label>
                  <Input
                    type="number"
                    min="0"
                    max={e.received}
                    step="1"
                    value={e.accepted}
                    onChange={(ev) => {
                      const v = Math.max(0, Math.min(e.received, Number(ev.target.value) || 0));
                      const rejected = Math.min(e.rejected, e.received - v);
                      setField(l.id, { accepted: v, rejected });
                    }}
                  />
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <Label className="text-muted-foreground text-[11px]">Rejected</Label>
                  <Input
                    type="number"
                    min="0"
                    max={e.received - e.accepted}
                    step="1"
                    value={e.rejected}
                    onChange={(ev) =>
                      setField(l.id, {
                        rejected: Math.max(
                          0,
                          Math.min(e.received - e.accepted, Number(ev.target.value) || 0),
                        ),
                      })
                    }
                  />
                </div>
                <div className="sm:col-span-1 flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setField(l.id, { received: remaining, accepted: remaining, rejected: 0 })
                    }
                  >
                    All
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="gradient" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Post receipt'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
