'use client';

import { Loader2, Minus, Plus } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { adjustStockAction } from '@/server/actions/inventory';
import { cn } from '@/lib/utils';

import { type MovementType } from '@stockpilot/core';

interface StockAdjustDialogProps {
  itemId: string;
  itemName: string;
  currentQuantity: number;
  trigger?: React.ReactNode;
}

const REASON_PRESETS: Array<{ type: MovementType; label: string; sign: 1 | -1 }> = [
  { type: 'add', label: 'Stock added', sign: 1 },
  { type: 'remove', label: 'Stock removed', sign: -1 },
  { type: 'adjust', label: 'Manual adjustment', sign: 1 },
  { type: 'damage', label: 'Damage / loss', sign: -1 },
  { type: 'return', label: 'Return', sign: 1 },
  { type: 'correction', label: 'Correction', sign: 1 },
];

export function StockAdjustDialog({
  itemId,
  itemName,
  currentQuantity,
  trigger,
}: StockAdjustDialogProps) {
  // Each field's label names it (its accessible name), one id set per dialog.
  const fieldId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [movementType, setMovementType] = React.useState<MovementType>('add');
  const [quantity, setQuantity] = React.useState('1');
  const [reason, setReason] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const preset = REASON_PRESETS.find((p) => p.type === movementType) ?? REASON_PRESETS[0]!;
  const sign = preset.sign;
  const qtyNum = Number.parseFloat(quantity) || 0;
  const change = qtyNum * sign;
  const newQty = currentQuantity + change;

  async function submit() {
    if (qtyNum <= 0) {
      toast.error('Enter a positive quantity to adjust by.');
      return;
    }
    if (newQty < 0) {
      toast.error('That adjustment would push stock below zero. Pick a smaller quantity.');
      return;
    }
    setSubmitting(true);
    const res = await adjustStockAction({
      itemId,
      quantityChange: change,
      movementType,
      reason: reason || undefined,
      notes: notes || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Stock adjusted to ${newQty}.`);
    setOpen(false);
    setQuantity('1');
    setReason('');
    setNotes('');
    // No router.refresh() here. adjustStockAction revalidates paths, and a
    // Server Action that revalidated carries the re-rendered current page in
    // its own response (Next 16 action-handler: page rendering is skipped only
    // when nothing was revalidated), which the router applies as part of this
    // same action. A refresh on top rendered the whole page a second time,
    // queued behind any other router work.
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="default">
            <Plus className="h-4 w-4" />
            Adjust stock
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust stock</DialogTitle>
          <DialogDescription>
            Adjusting <span className="text-foreground font-medium">{itemName}</span>. Current:{' '}
            <span className="tabular-nums">{currentQuantity}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-reason`}>Reason</Label>
            <Select
              value={movementType}
              onValueChange={(v: string) => setMovementType(v as MovementType)}
            >
              <SelectTrigger id={`${fieldId}-reason`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASON_PRESETS.map((p) => (
                  <SelectItem key={p.type} value={p.type}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-quantity`}>Quantity</Label>
            <div className="flex items-center gap-2">
              {/* The direction of the change, beside the quantity: added on the
                  accent wash, removed on the danger wash (the sign is also in
                  the New quantity line, so the tone is never the only cue). */}
              <span
                aria-hidden
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-md max-sm:size-11',
                  sign > 0
                    ? 'bg-success-wash text-success'
                    : 'bg-destructive-wash text-destructive',
                )}
              >
                {sign > 0 ? <Plus className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
              </span>
              <Input
                id={`${fieldId}-quantity`}
                type="number"
                step="1"
                min="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="flex-1"
              />
            </div>
            <p className="text-muted-foreground text-[12px]">
              New quantity:{' '}
              <span className={cn('font-semibold tabular-nums', newQty < 0 && 'text-destructive')}>
                {newQty}
              </span>
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-note`}>Note (optional)</Label>
            <Input
              id={`${fieldId}-note`}
              placeholder="Damaged in transit, customer return…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-internal-notes`}>Internal notes</Label>
            <Textarea
              id={`${fieldId}-internal-notes`}
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          {/* The commit in front of you: the ink primary (DESIGN-SPEC 6.2). */}
          <Button
            variant="default"
            onClick={submit}
            disabled={submitting || qtyNum <= 0 || newQty < 0}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
