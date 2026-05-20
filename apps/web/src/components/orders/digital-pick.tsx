'use client';

import { Check, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import {
  completePickingAction,
  recordPickedLineAction,
} from '@/server/actions/order-requests';
import type { OrderRequestLineWithItem } from '@/server/services/order-requests';

interface DigitalPickProps {
  orderId: string;
  initialLines: OrderRequestLineWithItem[];
}

export function DigitalPick({ orderId, initialLines }: DigitalPickProps) {
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
                min={0}
                max={requested}
                value={current}
                onValueChange={(n) =>
                  setPicked((p) => ({
                    ...p,
                    [line.id]: Math.max(0, Math.min(requested, n)),
                  }))
                }
                placeholder={String(requested)}
                className="w-24"
              />
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
          </div>
        );
      })}

      <div className="flex justify-end pt-2">
        <Button
          onClick={complete}
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
    </div>
  );
}
