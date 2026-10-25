'use client';

import { Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { placementWarningMessage, type NewRackConfirmationDetail } from '@stockpilot/core';

import {
  newRackConfirmContent,
  newRackQuestion,
  rackFieldsFromLabel,
} from '@/components/inventory/new-rack-question';
import { PlacementConfirmDialog } from '@/components/inventory/placement-confirm-dialog';
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
import { CRATE_COLORS } from '@/lib/book-storage';
import { duplicateItemAction } from '@/server/actions/duplicate-item';

interface Props {
  itemId: string;
  itemName: string;
  itemType: 'book' | 'product' | string | null;
}

/**
 * A book copy whose stock the server could not move to Unplaced (B28): the
 * copy exists (never an error), its stock is still where the seed put it (the
 * original's site), and the person is sent to look, in the shared placement
 * warning's order.
 */
function stockLeftAtMessage(itemName: string, locationName: string | null): string {
  const where = locationName ? `still at ${locationName}` : 'still where it started';
  return `Duplicated "${itemName}", but its stock could not be moved to Unplaced: it is ${where}. Check before picking.`;
}

/**
 * Modal launched by the "Duplicate" button on item-detail.
 * Pre-fills nothing visible (everything is inherited from the
 * original); user only enters the new physical location. On success,
 * redirects to the new item's detail page.
 */
export function DuplicateItemDialog({ itemId, itemName, itemType }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isBook = itemType === 'book';

  const [rackNumber, setRackNumber] = useState('');
  const [rackRow, setRackRow] = useState('');
  const [crateColor, setCrateColor] = useState('');
  const [crateNumber, setCrateNumber] = useState('');
  const [quantity, setQuantity] = useState('0');
  // "Create new rack 1-B?" (2026-10-24): a copy's stock is moved onto the rack
  // typed here, and when no such rack exists the server asks before it creates
  // one, the same question as the New item form (see new-rack-question.ts).
  // Products only: a duplicated book is never placed by the duplicate.
  const [rackQuestion, setRackQuestion] = useState<NewRackConfirmationDetail | null>(null);

  function reset() {
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setQuantity('0');
    setRackQuestion(null);
  }

  /**
   * `answer` is the person's reply to the server's new-rack question, for this
   * one save: yes, or the near-match to put the copy on instead.
   */
  function submit(answer: { confirmNewRack?: true; rack?: { number: string; row: string } } = {}) {
    const number = answer.rack?.number ?? rackNumber;
    const row = answer.rack?.row ?? rackRow;
    const qty = Number.parseInt(quantity, 10);
    if (Number.isNaN(qty) || qty < 0) {
      toast.error('Quantity must be 0 or more.');
      return;
    }
    if (!number.trim()) {
      toast.error('Rack number is required.');
      return;
    }
    if (isBook && (!crateColor.trim() || !crateNumber.trim())) {
      toast.error('Crate color and number are required for books.');
      return;
    }

    startTransition(async () => {
      const input = isBook
        ? {
            originalId: itemId,
            itemType: 'book' as const,
            rackNumber: number.trim(),
            rackRow: row.trim() || null,
            crateColor: crateColor.trim(),
            crateNumber: crateNumber.trim(),
            quantity: qty,
          }
        : {
            originalId: itemId,
            itemType: 'product' as const,
            rackNumber: number.trim(),
            rackRow: row.trim() || null,
            quantity: qty,
            // Only after the person said yes to creating the new rack.
            ...(answer.confirmNewRack ? { confirmNewRack: true } : {}),
          };
      const result = await duplicateItemAction(input);
      if (!result.ok) {
        const question = isBook ? null : newRackQuestion(result.error);
        setRackQuestion(question);
        if (question) return;
        toast.error(result.error.message);
        return;
      }
      setRackQuestion(null);
      // The copy exists either way. When its stock did not reach the rack
      // (2026-10-25), say so in the shared placement words, as Add more sizes
      // does. A book copy's stock waits in Unplaced (B28); when the server
      // could not move it there, say where it was left.
      if (result.data.placementFailed) {
        toast.warning(
          placementWarningMessage(`Duplicated "${itemName}"`, result.data.placementFailed),
          { duration: 10000 },
        );
      } else if (result.data.stockLeftAt) {
        toast.warning(stockLeftAtMessage(itemName, result.data.stockLeftAt.locationName), {
          duration: 10000,
        });
      } else if (isBook && qty > 0) {
        toast.success(`Duplicated "${itemName}". Its stock is in Unplaced, awaiting put-away.`);
      } else {
        toast.success(`Duplicated "${itemName}"`);
      }
      setOpen(false);
      reset();
      router.push(`/dashboard/inventory/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Copy className="h-4 w-4" /> Duplicate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate {isBook ? 'book' : 'item'}</DialogTitle>
          <DialogDescription>
            Creates a second row of &ldquo;{itemName}&rdquo; at a new physical location. Everything
            else (name, SKU base, cost, photo, tags, category) is copied automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dup-rack-number">
                Rack number <span className="text-destructive">*</span>
              </Label>
              <Input
                id="dup-rack-number"
                value={rackNumber}
                onChange={(e) => setRackNumber(e.target.value)}
                placeholder="38"
                disabled={pending}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dup-rack-row">Row (optional)</Label>
              <Input
                id="dup-rack-row"
                value={rackRow}
                onChange={(e) => setRackRow(e.target.value)}
                placeholder="A"
                disabled={pending}
              />
            </div>
          </div>

          {isBook && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dup-crate-color">
                  Crate color <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={crateColor || undefined}
                  onValueChange={setCrateColor}
                  disabled={pending}
                >
                  <SelectTrigger id="dup-crate-color">
                    <SelectValue placeholder="Pick a color" />
                  </SelectTrigger>
                  <SelectContent>
                    {CRATE_COLORS.map((c) => (
                      <SelectItem key={c.slug} value={c.slug}>
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="inline-block h-3 w-3 shrink-0 rounded-full border border-[var(--ed-line-strong)]"
                            style={{ backgroundColor: c.hex }}
                          />
                          {c.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dup-crate-number">
                  Crate number <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="dup-crate-number"
                  value={crateNumber}
                  onChange={(e) => setCrateNumber(e.target.value)}
                  placeholder="4"
                  inputMode="numeric"
                  disabled={pending}
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="dup-quantity">Quantity at this rack</Label>
            <Input
              id="dup-quantity"
              type="number"
              inputMode="numeric"
              min={0}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={pending}
            />
            <p className="text-muted-foreground text-[12px]">
              {isBook
                ? 'Defaults to 0. The stock waits in Unplaced until it is put away into this crate.'
                : 'Defaults to 0. Set the actual on-hand count at the new rack.'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => submit()} disabled={pending}>
            {pending ? 'Duplicating…' : 'Duplicate'}
          </Button>
        </DialogFooter>
      </DialogContent>

      <PlacementConfirmDialog
        open={rackQuestion !== null}
        content={rackQuestion ? newRackConfirmContent(rackQuestion) : null}
        submitting={pending}
        onCancel={() => setRackQuestion(null)}
        onConfirm={() => submit({ confirmNewRack: true })}
        onUseSuggestion={(label) => {
          // Show the rack the copy goes onto, and save onto it.
          const rack = rackFieldsFromLabel(label);
          setRackNumber(rack.number);
          setRackRow(rack.row);
          submit({ rack });
        }}
      />
    </Dialog>
  );
}
