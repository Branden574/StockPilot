'use client';

import { Loader2, Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { createOrderRequestAction } from '@/server/actions/order-requests';

import { clearCartDraft, useCart } from './cart-context';
import type { CatalogItem } from './types';

interface CartRailProps {
  /** Map of itemId → CatalogItem so the rail can look up name, image,
   *  and price for each cart line. */
  itemMap: Map<string, CatalogItem>;
  warehouseId: string;
}

export function CartRail({ itemMap, warehouseId }: CartRailProps) {
  const router = useRouter();
  const { state, dispatch } = useCart();
  const [isPending, startTransition] = React.useTransition();

  const lines = state.lines;
  const totalQty = lines.reduce((s, l) => s + l.quantity, 0);

  // Announce cart changes to screen readers
  const [announcement, setAnnouncement] = React.useState('');
  const prevCount = React.useRef(totalQty);
  React.useEffect(() => {
    if (totalQty !== prevCount.current) {
      setAnnouncement(`${totalQty} item${totalQty === 1 ? '' : 's'} in cart.`);
      prevCount.current = totalQty;
    }
  }, [totalQty]);

  function handleSubmit() {
    if (lines.length === 0) {
      toast.error('Add at least one item to your cart before submitting.');
      return;
    }
    if (state.fulfillmentType === 'delivery' && !state.charterId) {
      toast.error('Select a delivery site in the setup strip above.');
      return;
    }
    if (state.onBehalfOf) {
      if (!state.onBehalfOf.name.trim() || !state.onBehalfOf.email.trim()) {
        toast.error("Complete the requester's name and email above.");
        return;
      }
    }

    startTransition(async () => {
      const res = await createOrderRequestAction({
        warehouseId: state.warehouseId,
        notes: state.notes.trim() || null,
        fulfillmentType: state.fulfillmentType,
        requesterPhone: null, // v2 doesn't collect phone
        deliveryCharterId:
          state.fulfillmentType === 'delivery' ? (state.charterId ?? null) : null,
        pickupLocationNotes: null,
        onBehalfOf: state.onBehalfOf
          ? { name: state.onBehalfOf.name.trim(), email: state.onBehalfOf.email.trim() }
          : null,
        lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      });

      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }

      clearCartDraft(warehouseId);
      toast.success('Order request submitted.');
      router.push(`/dashboard/orders/${res.data.id}`);
    });
  }

  return (
    <aside
      className="lg:sticky lg:top-4 lg:self-start w-full lg:w-[360px] lg:flex-none"
      aria-label="Cart"
    >
      {/* Screen-reader live region for cart changes */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <ShoppingCart className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">
            Cart
            {totalQty > 0 && (
              <span className="ml-1.5 text-muted-foreground font-normal">
                ({totalQty})
              </span>
            )}
          </h2>
        </div>

        {/* Line items */}
        {lines.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Your cart is empty. Add items from the catalog.
          </p>
        ) : (
          <ul className="divide-y divide-border text-xs space-y-0">
            {lines.map((line) => {
              const item = itemMap.get(line.itemId);
              const name = item?.name ?? line.itemId;
              const imageUrl = item?.imageUrl ?? null;
              const maxQty = item?.quantityOnHand ?? Infinity;

              return (
                <li key={line.itemId} className="flex items-start gap-2 py-2">
                  {/* Thumbnail */}
                  <div className="h-9 w-9 flex-none rounded-md border bg-muted overflow-hidden">
                    {imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={imageUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : null}
                  </div>

                  {/* Name + stepper */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="font-medium truncate leading-tight" title={name}>
                      {name}
                    </p>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => dispatch({ type: 'dec', itemId: line.itemId })}
                        className="flex items-center justify-center h-6 w-6 rounded border border-border hover:bg-muted transition-colors"
                        aria-label="Decrease quantity"
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                      <span className="w-6 text-center tabular-nums font-semibold">
                        {line.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => dispatch({ type: 'inc', itemId: line.itemId })}
                        disabled={line.quantity >= maxQty}
                        className="flex items-center justify-center h-6 w-6 rounded border border-border hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        aria-label="Increase quantity"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  {/* Remove */}
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'remove', itemId: line.itemId })}
                    className="text-muted-foreground hover:text-destructive transition-colors mt-0.5"
                    aria-label={`Remove ${name} from cart`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Notes */}
        <div className="space-y-1">
          <label htmlFor="cart-notes" className="text-xs text-muted-foreground">
            Notes for the manager
            <span className="ml-1 font-normal">(optional)</span>
          </label>
          <Textarea
            id="cart-notes"
            value={state.notes}
            onChange={(e) =>
              dispatch({ type: 'set-notes', value: e.target.value })
            }
            rows={2}
            maxLength={2000}
            placeholder="Anything the manager should know…"
            className="text-xs resize-none"
          />
        </div>

        {/* Totals */}
        {lines.length > 0 && (
          <div className="space-y-1 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total qty</span>
              <span className="tabular-nums font-semibold">{totalQty}</span>
            </div>
          </div>
        )}

        {/* Submit */}
        <Button
          type="button"
          className="w-full"
          onClick={handleSubmit}
          disabled={isPending || lines.length === 0}
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : null}
          Submit request
        </Button>
      </div>
    </aside>
  );
}
