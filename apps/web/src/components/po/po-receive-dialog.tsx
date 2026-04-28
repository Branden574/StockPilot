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
import { receivePoAction } from '@/server/actions/purchase-orders';

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
  lines: Line[];
}

export function PoReceiveDialog({ poId, poNumber, lines }: PoReceiveDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  const [quantities, setQuantities] = React.useState<Record<string, number>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, Math.max(l.quantityOrdered - l.quantityReceived, 0)])),
  );

  async function submit() {
    setSubmitting(true);
    const res = await receivePoAction(poId, {
      lines: Object.entries(quantities)
        .filter(([, qty]) => qty > 0)
        .map(([lineId, qty]) => ({ lineId, quantity: qty })),
      notes: notes || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Received against ${poNumber}`);
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Receive {poNumber}</DialogTitle>
          <DialogDescription>
            Enter how many of each line you received. Stock will increase and the ledger will record it.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-3 overflow-y-auto">
          {lines.map((l) => {
            const remaining = l.quantityOrdered - l.quantityReceived;
            return (
              <div key={l.id} className="grid grid-cols-12 gap-2 rounded-md border p-3">
                <div className="col-span-7">
                  <p className="font-medium">{l.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{l.sku}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ordered {l.quantityOrdered} · Already received {l.quantityReceived} · Remaining {remaining}
                  </p>
                </div>
                <div className="col-span-5 flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Receive now</Label>
                    <Input
                      type="number"
                      min="0"
                      max={remaining}
                      step="1"
                      value={quantities[l.id] ?? 0}
                      onChange={(e) => setQuantities((q) => ({ ...q, [l.id]: Math.min(Number(e.target.value) || 0, remaining) }))}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setQuantities((q) => ({ ...q, [l.id]: remaining }))}
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
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm receipt'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
