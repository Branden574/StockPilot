'use client';

import { Check, Loader2, Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  digitalPickCompletionConfirm,
  lineOwedUnits,
  orderLineItemName,
  type OrderReadinessResult,
} from '@stockpilot/core';

import { FefoLotHint } from '@/components/orders/fefo-lot-hint';
import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  completePickingAction,
  recordPickedLineAction,
} from '@/server/actions/order-requests';
import type { OrderRequestLineWithItem } from '@/server/services/order-requests';
import type { FefoSuggestion } from '@/server/services/lots';

/** The DOM id of a line's picked-quantity field ("Review short lines" lands
 *  on the first short one). */
function pickLineInputId(lineId: string): string {
  return `pick-line-${lineId}`;
}

interface DigitalPickProps {
  orderId: string;
  initialLines: OrderRequestLineWithItem[];
  /** Whether THIS viewer may edit the pick (the assigned picker or a
   *  manager+). When false, the editable inputs are replaced with a
   *  read-only lock notice — the server blocks the write regardless. */
  canPick: boolean;
  /** Display name of the current claimant, for the locked notice. */
  assignedPickerName: string | null;
  /**
   * The order's readiness (F2-2), read by the pick page beside the order: the
   * completion confirm projects complete_picking over it with what the picker
   * entered (core digitalPickCompletionConfirm, the phone's too). Null or a
   * failed read still confirms what was entered short and says stock could
   * not be checked: the confirm is never skipped for want of facts. Required,
   * so no caller can skip it by leaving it out.
   */
  readiness: OrderReadinessResult | null;
  lotSerial?: { enabled: boolean; fefoByItemId: Record<string, FefoSuggestion[]> };
}

export function DigitalPick({
  orderId,
  initialLines,
  canPick,
  assignedPickerName,
  readiness,
  lotSerial,
}: DigitalPickProps) {
  const router = useRouter();
  const [picked, setPicked] = React.useState<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const l of initialLines) {
      out[l.id] = Number(l.quantity_picked ?? 0);
    }
    return out;
  });
  const [savingLine, setSavingLine] = React.useState<string | null>(null);
  const [completing, setCompleting] = React.useState(false);

  async function save(lineId: string, qty: number) {
    setSavingLine(lineId);
    const res = await recordPickedLineAction({ orderId, lineId, quantity: qty });
    setSavingLine(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return false;
    }
    return true;
  }

  async function complete() {
    setCompleting(true);

    // Flush any unsaved line quantities BEFORE calling
    // complete_picking. The RPC reads quantity_picked off each line
    // row and skips adjust_stock when it's null/0 — so if the user
    // typed a quantity into the input but never clicked Save, the
    // status would flip to picking_complete without any stock
    // decrement. We persist the local state first to guarantee the
    // RPC has accurate per-line numbers to deduct from.
    const flushes = initialLines
      .map((line) => {
        const localQty = picked[line.id] ?? 0;
        const serverQty = Number(line.quantity_picked ?? 0);
        if (localQty === serverQty) return null;
        return { lineId: line.id, qty: localQty };
      })
      .filter((x): x is { lineId: string; qty: number } => x !== null);

    for (const f of flushes) {
      const res = await recordPickedLineAction({
        orderId,
        lineId: f.lineId,
        quantity: f.qty,
      });
      if (!res.ok) {
        setCompleting(false);
        toast.error(`Couldn't save line before completing: ${res.error.message}`);
        return;
      }
    }

    const res = await completePickingAction({ id: orderId });
    setCompleting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Picking complete. Stock decremented.');
    router.push(`/dashboard/orders/${orderId}`);
  }

  const allLinesPicked = initialLines.every((l) => (picked[l.id] ?? 0) > 0);
  const anyLinePicked = initialLines.some((l) => (picked[l.id] ?? 0) > 0);

  // Short-completion guard (F2-2): complete_picking takes min(entered, owed)
  // per line once the entered numbers are saved, so the confirm projects the
  // completion with what the picker ENTERED, over the order's readiness (core
  // digitalPickCompletionConfirm, word for word what the phone's digital pick
  // and the one-click "Mark picking complete" say). It speaks when a line
  // comes up short ("Not everything will be picked. L4L - Pen Black & Rose
  // Gold: 0 of 60. ..."), when the pick would fail (units still in Staging),
  // and when stock could not be checked; otherwise Complete runs at once.
  const completionConfirm = digitalPickCompletionConfirm(
    initialLines.map((l) => ({
      id: l.id,
      itemName: l.item?.name ?? null,
      // Core lineOwedUnits is the one definition of owed (pattern #26).
      owed: lineOwedUnits({
        quantityRequested: l.quantity_requested,
        quantityFulfilled: l.quantity_fulfilled,
      }),
      picking: picked[l.id] ?? 0,
    })),
    readiness,
  );
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // "Review short lines" lands on the first short line's quantity, once the
  // dialog has closed (it hands focus back to its opener otherwise).
  const reviewAfterClose = React.useRef<string | null>(null);

  function onCompleteClick() {
    if (completionConfirm) {
      setConfirmOpen(true);
      return;
    }
    void complete();
  }

  // Locked to another picker (or unclaimed and the viewer isn't a manager).
  // The server rejects the write either way; this just avoids showing
  // editable inputs the viewer can't submit. Hooks above run unconditionally.
  if (!canPick) {
    return (
      <div className="border-border bg-card rounded-xl border p-6 text-center">
        <Lock className="text-muted-foreground mx-auto h-6 w-6" />
        <p className="mt-3 text-sm font-medium">
          {assignedPickerName
            ? `This order is being picked by ${assignedPickerName}.`
            : 'This order needs to be claimed before you can pick it.'}
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          {assignedPickerName
            ? 'Ask a manager to reassign it if you need to take over.'
            : 'Go back to the order and tap “Claim picking” to start.'}
        </p>
        <div className="mt-4">
          <Button variant="outline" asChild>
            <Link href={`/dashboard/orders/${orderId}`}>Back to order</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {initialLines.map((line) => {
        const requested = Number(line.quantity_requested);
        const current = picked[line.id] ?? 0;
        const isSaving = savingLine === line.id;
        return (
          <div
            key={line.id}
            className="border-border bg-card rounded-xl border p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{line.item?.name ?? '—'}</div>
                <div className="text-muted-foreground font-mono text-xs">
                  {line.item?.sku ?? '—'}
                </div>
              </div>
              <div className="text-muted-foreground shrink-0 text-xs">
                requested {requested}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <BlankZeroNumberInput
                id={pickLineInputId(line.id)}
                aria-label={`Picked quantity for ${orderLineItemName(line.item)}`}
                min={0}
                max={requested}
                value={current}
                onValueChange={(n) =>
                  setPicked((p) => ({
                    ...p,
                    [line.id]: Math.max(0, Math.min(requested, n)),
                  }))
                }
                // A word, never a number: the requested quantity as a grey
                // placeholder made a line with nothing entered look filled
                // (F2-2 walk). What is asked for sits beside the field, as
                // on the phone.
                placeholder="Qty"
                className="w-24"
              />
              <span className="text-muted-foreground text-xs tabular-nums">of {requested}</span>
              <Button
                type="button"
                size="sm"
                variant={current === requested ? 'default' : 'outline'}
                disabled={isSaving}
                onClick={async () => {
                  const ok = await save(line.id, current);
                  if (ok) toast.success(`Saved ${current} / ${requested}`);
                }}
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Check className="mr-1 h-4 w-4" />
                    Save
                  </>
                )}
              </Button>
            </div>
            {lotSerial?.enabled && line.item?.tracking_type === 'lot' && (
              <FefoLotHint
                orderId={orderId}
                orderLineId={line.id}
                itemId={line.item.id}
                suggestions={lotSerial.fefoByItemId[line.item.id] ?? []}
              />
            )}
          </div>
        );
      })}

      <div className="flex justify-end pt-2">
        <Button
          onClick={onCompleteClick}
          disabled={completing || !anyLinePicked}
          variant="gradient"
          size="lg"
        >
          {completing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>Complete picking{allLinesPicked ? '' : ' (partial)'}</>
          )}
        </Button>
      </div>

      {/* Short-completion confirm (F2-2): which lines come up short, what
          would stop the pick, what could not be checked, in core's words.
          "Review short lines" goes back to the first short line; "Complete
          picking" goes ahead, and what was not picked is owed at hand-over
          (the server stays permissive: shipping short is legitimate). */}
      <Dialog
        open={confirmOpen && completionConfirm !== null}
        onOpenChange={(v) => {
          if (completing) return;
          setConfirmOpen(v);
        }}
      >
        <DialogContent
          className="max-w-md"
          data-testid="completion-confirm"
          onCloseAutoFocus={(e) => {
            const lineId = reviewAfterClose.current;
            reviewAfterClose.current = null;
            const input = lineId ? document.getElementById(pickLineInputId(lineId)) : null;
            if (!input) return;
            e.preventDefault();
            input.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
            input.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle>{completionConfirm?.title}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                {completionConfirm?.paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                reviewAfterClose.current = completionConfirm?.focusLineId ?? null;
                setConfirmOpen(false);
              }}
              disabled={completing}
            >
              {completionConfirm?.reviewLabel}
            </Button>
            <Button
              variant="gradient"
              onClick={() => {
                setConfirmOpen(false);
                void complete();
              }}
              disabled={completing}
            >
              {completing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {completionConfirm?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
