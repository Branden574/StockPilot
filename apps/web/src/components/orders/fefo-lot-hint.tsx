'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { recordLotPicksAction } from '@/server/actions/lots';
import type { FefoSuggestion } from '@/server/services/lots';

/** Expiry pills on the redesign's tones (DESIGN-SPEC 6.10): expired in the
 *  danger wash, within 7 days in the warning wash, within 30 the warning
 *  outline, within 90 neutral, later the accent wash, no date quiet. The
 *  date (or "no date") is always the words, so colour is never the only cue. */
const BADGE: Record<string, string> = {
  expired: 'border-transparent bg-destructive-wash text-destructive',
  le7: 'border-transparent bg-warning-wash text-warning',
  le30: 'border-warning/40 bg-transparent text-warning',
  le90: 'border-line-strong bg-sunk text-ink-2',
  ok: 'border-transparent bg-success-wash text-accent',
  unknown: 'border-line-strong bg-transparent text-muted-foreground',
};

export function FefoLotHint({
  orderId,
  orderLineId,
  itemId,
  suggestions,
}: {
  orderId: string;
  orderLineId: string;
  itemId: string;
  suggestions: FefoSuggestion[];
}) {
  const router = useRouter();
  const [qty, setQty] = React.useState<Record<string, number>>({});
  const [saving, setSaving] = React.useState(false);
  if (suggestions.length === 0) {
    return (
      <p className="text-muted-foreground mt-2 text-[12.5px]">
        No lots with remaining quantity recorded for this item.
      </p>
    );
  }

  async function record() {
    const picks = suggestions
      .map((s) => ({
        lotNumber: s.lotNumber,
        qty: qty[s.lotNumber] ?? 0,
        expirationDate: s.expirationDate,
      }))
      .filter((p) => p.qty > 0);
    if (picks.length === 0) {
      toast.error('Enter a quantity for at least one lot.');
      return;
    }
    setSaving(true);
    const res = await recordLotPicksAction({
      orderRequestId: orderId,
      orderRequestLineId: orderLineId,
      itemId,
      picks,
    });
    setSaving(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Lot picks recorded.');
    setQty({});
    // Re-fetch the server component so displayed availability reflects the
    // just-recorded picks.
    router.refresh();
  }

  return (
    // A sub-panel inside the pick row: the sunk well, one row per lot in
    // earliest-expiry order, the quantity right-aligned in mono like the
    // count workbench's input (DESIGN-SPEC 6.3).
    <div className="bg-sunk border-border mt-3 rounded-lg border p-3" data-testid="fefo-lot-hint">
      <p className="mb-2 text-[12.5px] font-medium">Pick earliest-expiry first (FEFO)</p>
      <div className="space-y-2">
        {suggestions.map((s) => (
          <div
            key={s.lotNumber}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]"
          >
            <span className="font-mono">{s.lotNumber}</span>
            <span
              className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 text-[12px] leading-[18px] ${BADGE[s.bucket]}`}
              data-bucket={s.bucket}
            >
              {s.effectiveExpiry ? s.effectiveExpiry.slice(0, 10) : 'no date'}
            </span>
            <span className="text-muted-foreground font-mono tabular-nums">
              avail {s.remaining}
            </span>
            <BlankZeroNumberInput
              min={0}
              max={s.remaining}
              value={qty[s.lotNumber] ?? 0}
              onValueChange={(n) =>
                setQty((m) => ({ ...m, [s.lotNumber]: Math.max(0, Math.min(s.remaining, n)) }))
              }
              className="bg-card ml-auto h-8 w-[72px] text-right font-mono tabular-nums"
              placeholder="0"
              aria-label={`Picked quantity from lot ${s.lotNumber}`}
            />
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={record}
        disabled={saving}
      >
        {saving ? 'Recording…' : 'Record picked lots'}
      </Button>
    </div>
  );
}
