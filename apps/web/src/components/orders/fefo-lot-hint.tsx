'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { recordLotPicksAction } from '@/server/actions/lots';
import type { FefoSuggestion } from '@/server/services/lots';

const BADGE: Record<string, string> = {
  expired: 'bg-destructive/15 text-destructive',
  le7: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  le30: 'bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300',
  le90: 'bg-muted text-muted-foreground',
  ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300',
  unknown: 'bg-muted text-muted-foreground',
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
      <p className="text-muted-foreground mt-2 text-xs">
        No lots with remaining quantity recorded for this item.
      </p>
    );
  }

  async function record() {
    const picks = suggestions
      .map((s) => ({ lotNumber: s.lotNumber, qty: qty[s.lotNumber] ?? 0, expirationDate: s.expirationDate }))
      .filter((p) => p.qty > 0);
    if (picks.length === 0) {
      toast.error('Enter a quantity for at least one lot.');
      return;
    }
    setSaving(true);
    const res = await recordLotPicksAction({ orderRequestId: orderId, orderRequestLineId: orderLineId, itemId, picks });
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
    <div className="border-border/60 mt-3 rounded-lg border border-dashed p-3">
      <p className="mb-2 text-xs font-medium">Pick earliest-expiry first (FEFO)</p>
      <div className="space-y-2">
        {suggestions.map((s) => (
          <div key={s.lotNumber} className="flex items-center gap-2 text-xs">
            <span className="font-mono">{s.lotNumber}</span>
            <span className={`rounded px-1.5 py-0.5 ${BADGE[s.bucket]}`}>
              {s.effectiveExpiry ? s.effectiveExpiry.slice(0, 10) : 'no date'}
            </span>
            <span className="text-muted-foreground">avail {s.remaining}</span>
            <BlankZeroNumberInput
              min={0}
              max={s.remaining}
              value={qty[s.lotNumber] ?? 0}
              onValueChange={(n) =>
                setQty((m) => ({ ...m, [s.lotNumber]: Math.max(0, Math.min(s.remaining, n)) }))
              }
              className="ml-auto w-20"
              placeholder="0"
            />
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={record} disabled={saving}>
        {saving ? 'Recording…' : 'Record picked lots'}
      </Button>
    </div>
  );
}
