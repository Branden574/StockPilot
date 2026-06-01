'use client';

import { Loader2, Undo2 } from 'lucide-react';
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
import { createReturnFromOrderAction } from '@/server/actions/returns';

import type { ReturnableLine } from '@/server/services/returns';

interface Props {
  orderId: string;
  lines: ReturnableLine[];
}

type ReasonCode = 'damaged' | 'wrong_item' | 'end_of_year' | 'overage' | 'other';

const REASONS: Array<{ value: ReasonCode; label: string }> = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'end_of_year', label: 'End of year' },
  { value: 'overage', label: 'Overage' },
  { value: 'other', label: 'Other' },
];

interface LineState {
  selected: boolean;
  quantity: string;
  disposition: 'restock' | 'scrap';
}

export function CreateReturnDialog({ orderId, lines }: Props) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [reason, setReason] = React.useState<ReasonCode | ''>('');
  const [notes, setNotes] = React.useState('');
  const [lineState, setLineState] = React.useState<Record<string, LineState>>(() =>
    initialLineState(lines),
  );

  function reset() {
    setReason('');
    setNotes('');
    setLineState(initialLineState(lines));
  }

  function updateLine(id: string, patch: Partial<LineState>) {
    setLineState((prev) => {
      const existing = prev[id] ?? { selected: false, quantity: '1', disposition: 'restock' };
      return { ...prev, [id]: { ...existing, ...patch } };
    });
  }

  function lineStateFor(id: string): LineState {
    return lineState[id] ?? { selected: false, quantity: '1', disposition: 'restock' };
  }

  async function submit() {
    const selected = lines
      .filter((l) => lineStateFor(l.orderRequestLineId).selected)
      .map((l) => {
        const st = lineStateFor(l.orderRequestLineId);
        return {
          orderRequestLineId: l.orderRequestLineId,
          quantity: Number(st.quantity),
          disposition: st.disposition,
          remaining: l.quantityRemaining,
        };
      });

    if (selected.length === 0) {
      toast.error('Select at least one line to return.');
      return;
    }
    for (const s of selected) {
      if (!Number.isFinite(s.quantity) || s.quantity <= 0) {
        toast.error('Each selected line needs a quantity greater than zero.');
        return;
      }
      if (s.quantity > s.remaining) {
        toast.error(`Quantity exceeds the ${s.remaining} returnable on a line.`);
        return;
      }
    }

    setBusy(true);
    const res = await createReturnFromOrderAction({
      orderRequestId: orderId,
      reasonCode: reason || undefined,
      notes: notes.trim() ? notes.trim() : undefined,
      lines: selected.map((s) => ({
        orderRequestLineId: s.orderRequestLineId,
        quantity: s.quantity,
        disposition: s.disposition,
      })),
    });
    setBusy(false);

    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Return created.');
    setOpen(false);
    router.push(`/dashboard/returns/${res.data.id}`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        setOpen(v);
        if (v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Undo2 className="h-3.5 w-3.5" />
          Create return
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create a return</DialogTitle>
          <DialogDescription>
            Pick the lines to return, set a quantity (up to what was fulfilled
            and not already returned) and a disposition. Restock adds the stock
            back; scrap writes it off. Inventory only moves when the return is
            received and closed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            {lines.map((l) => {
              const st = lineStateFor(l.orderRequestLineId);
              return (
                <div
                  key={l.orderRequestLineId}
                  className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
                >
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={st.selected}
                      onChange={(e) =>
                        updateLine(l.orderRequestLineId, { selected: e.target.checked })
                      }
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {l.itemName ?? 'Item'}
                      </span>
                      <span className="text-muted-foreground block font-mono text-[11px]">
                        {l.itemSku ?? l.itemId.slice(0, 8)} · {l.quantityRemaining} of{' '}
                        {l.quantityFulfilled} returnable
                      </span>
                    </span>
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={l.quantityRemaining}
                      step={1}
                      value={st.quantity}
                      disabled={!st.selected}
                      onChange={(e) =>
                        updateLine(l.orderRequestLineId, { quantity: e.target.value })
                      }
                      className="w-20 tabular-nums"
                      aria-label="Return quantity"
                    />
                    <Select
                      value={st.disposition}
                      disabled={!st.selected}
                      onValueChange={(v) =>
                        updateLine(l.orderRequestLineId, {
                          disposition: v as 'restock' | 'scrap',
                        })
                      }
                    >
                      <SelectTrigger className="w-28" aria-label="Disposition">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="restock">Restock</SelectItem>
                        <SelectItem value="scrap">Scrap</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="return-reason">Reason</Label>
              <Select
                value={reason}
                onValueChange={(v) => setReason(v as ReasonCode)}
              >
                <SelectTrigger id="return-reason">
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="return-notes">Notes</Label>
            <Textarea
              id="return-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Optional context for this return"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="gradient" onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Create return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function initialLineState(lines: ReturnableLine[]): Record<string, LineState> {
  const out: Record<string, LineState> = {};
  for (const l of lines) {
    out[l.orderRequestLineId] = {
      selected: false,
      quantity: String(l.quantityRemaining),
      disposition: 'restock',
    };
  }
  return out;
}
