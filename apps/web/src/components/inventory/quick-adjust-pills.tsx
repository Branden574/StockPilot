'use client';

import { Minus, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { adjustStockAction } from '@/server/actions/inventory';
import { cn } from '@/lib/utils';

interface QuickAdjustPillsProps {
  itemId: string;
  /**
   * Current on-hand quantity. We use this to gate the `-1` pill so a
   * power-user can't accidentally drive the row negative with a single
   * click. Larger negative moves still go through the dialog.
   */
  currentQuantity: number;
  /**
   * Whether the current viewer has `stock:adjust` — passed in from the
   * server-rendered ItemDetail so the gate matches the server-side
   * permission check that the action itself runs.
   */
  canAdjust: boolean;
}

/**
 * Two small `-1` / `+1` pills meant to live next to the qty badge in
 * the sticky header. Power-user affordance for "I just shelved one
 * more / one fewer" without opening the full stock-adjust dialog.
 *
 * Disabled when:
 *   • the viewer lacks `stock:adjust` (passed in as `canAdjust`)
 *   • the pill would push stock negative (only affects `-1` at qty 0)
 *   • a previous click is still in flight (avoids double-fire toasts)
 */
export function QuickAdjustPills({ itemId, currentQuantity, canAdjust }: QuickAdjustPillsProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState<-1 | 1 | null>(null);

  async function fire(delta: -1 | 1) {
    if (!canAdjust) return;
    if (delta === -1 && currentQuantity <= 0) return;
    setPending(delta);
    const res = await adjustStockAction({
      itemId,
      quantityChange: delta,
      movementType: delta > 0 ? 'add' : 'remove',
    });
    setPending(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(delta > 0 ? '+1 on hand' : '-1 on hand');
    router.refresh();
  }

  const minusDisabled = !canAdjust || currentQuantity <= 0 || pending !== null;
  const plusDisabled = !canAdjust || pending !== null;

  // Title text explains *why* a pill is dimmed — perm vs. floor vs. busy.
  const minusTitle = !canAdjust
    ? 'You do not have permission to adjust stock'
    : currentQuantity <= 0
      ? 'Quantity is already 0'
      : 'Decrement by 1';
  const plusTitle = !canAdjust ? 'You do not have permission to adjust stock' : 'Increment by 1';

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Quick stock adjustment">
      <button
        type="button"
        onClick={() => fire(-1)}
        disabled={minusDisabled}
        aria-label="Decrease quantity by 1"
        title={minusTitle}
        className={cn(
          'inline-flex h-7 items-center gap-0.5 rounded-full border px-2 text-xs font-medium tabular-nums transition-colors',
          'border-border bg-background text-foreground hover:bg-muted',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background',
        )}
      >
        <Minus className="h-3 w-3" />
        <span>1</span>
      </button>
      <button
        type="button"
        onClick={() => fire(1)}
        disabled={plusDisabled}
        aria-label="Increase quantity by 1"
        title={plusTitle}
        className={cn(
          'inline-flex h-7 items-center gap-0.5 rounded-full border px-2 text-xs font-medium tabular-nums transition-colors',
          'border-border bg-background text-foreground hover:bg-muted',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background',
        )}
      >
        <Plus className="h-3 w-3" />
        <span>1</span>
      </button>
    </div>
  );
}
