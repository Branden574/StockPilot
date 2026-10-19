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
import { StatePanel } from '@/components/patterns/state-panel';
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
import { completePickingAction, recordPickedLineAction } from '@/server/actions/order-requests';
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
    // The shared forbidden state (StatePanel), with the page's own words.
    return (
      <StatePanel
        kind="forbidden"
        icon={Lock}
        size="sm"
        data-testid="digital-pick-locked"
        title={
          assignedPickerName
            ? `This order is being picked by ${assignedPickerName}.`
            : 'This order needs to be claimed before you can pick it.'
        }
        description={
          assignedPickerName
            ? 'Ask a manager to reassign it if you need to take over.'
            : 'Go back to the order and tap “Claim picking” to start.'
        }
        action={
          <Button variant="outline" asChild>
            <Link href={`/dashboard/orders/${orderId}`}>Back to order</Link>
          </Button>
        }
      />
    );
  }

  // The count workbench's card (DESIGN-SPEC 7.7, M6): one row per line with
  // the item on the left and the entry on the right (the field right-aligned
  // in mono on the sunk fill, "of N", Save), the lot hint under its line, and
  // the commit in the card's footer. On a phone the entry wraps under the
  // item. "of N" holds six characters and Save its own width while it
  // spins, so the fields line up down the card whatever each line asks
  // for; on a phone Save takes the field's 44 px height. Every word, id,
  // clamp and button is the one the page had.
  return (
    <div
      className="border-border bg-card overflow-hidden rounded-lg border"
      data-testid="digital-pick"
    >
      <ul className="divide-border divide-y">
        {initialLines.map((line) => {
          const requested = Number(line.quantity_requested);
          const current = picked[line.id] ?? 0;
          const isSaving = savingLine === line.id;
          return (
            <li key={line.id} className="px-[18px] py-3" data-testid="digital-pick-line">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="text-[13.5px] font-medium leading-5 [overflow-wrap:anywhere]">
                    {line.item?.name ?? '—'}
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 font-mono text-[11.5px] leading-[18px]">
                    <span>{line.item?.sku ?? '—'}</span>
                    <span className="font-sans text-[12px]">requested {requested}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
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
                    className="bg-sunk h-8 w-[72px] text-right font-mono tabular-nums"
                  />
                  <span className="text-muted-foreground min-w-[6ch] font-mono text-[12.5px] tabular-nums">
                    of {requested}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant={current === requested ? 'default' : 'outline'}
                    className="min-w-[72px] max-sm:h-11 max-sm:px-4"
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
                        <Check className="h-4 w-4" />
                        Save
                      </>
                    )}
                  </Button>
                </div>
              </div>
              {lotSerial?.enabled && line.item?.tracking_type === 'lot' && (
                <FefoLotHint
                  orderId={orderId}
                  orderLineId={line.id}
                  itemId={line.item.id}
                  suggestions={lotSerial.fefoByItemId[line.item.id] ?? []}
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="border-border flex justify-end border-t px-[18px] py-3.5">
        <Button
          onClick={onCompleteClick}
          disabled={completing || !anyLinePicked}
          variant="default"
          className="max-sm:h-11 max-sm:px-5"
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
              variant="default"
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
