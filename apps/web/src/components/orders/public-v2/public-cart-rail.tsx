'use client';

import { Loader2, Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { clearCartDraft, useCart } from '@/components/orders/v2/cart-context';
import type { CatalogItem } from '@/components/orders/v2/types';

export interface SubmittedState {
  id: string;
  email: string;
  trackUrl: string;
}

interface PublicCartRailProps {
  token: string;
  warehouseId: string;
  /** Map of itemId → CatalogItem for thumbnail + name lookups in the rail. */
  itemMap: Map<string, CatalogItem>;
  /** Requester fields — owned by the root and passed down so this component
   *  can include them in the submit payload without duplicating state. */
  name: string;
  email: string;
  phone: string;
  pickupNotes: string;
  honeypot: string;
  onSubmitted: (state: SubmittedState) => void;
}

/**
 * Sticky cart rail for the public order link.
 *
 * Visual structure mirrors the staff CartRail for consistency, but the
 * submit logic posts to POST /api/v1/public/order-requests (not the
 * createOrderRequestAction server action). On success, calls onSubmitted
 * so the root can switch to the "Check your inbox" panel.
 */
export function PublicCartRail({
  token,
  warehouseId,
  itemMap,
  name,
  email,
  phone,
  pickupNotes,
  honeypot,
  onSubmitted,
}: PublicCartRailProps) {
  const { state, dispatch } = useCart();
  const [submitting, setSubmitting] = React.useState(false);

  const lines = state.lines;
  const totalQty = lines.reduce((s, l) => s + l.quantity, 0);

  // Screen-reader live region for cart changes
  const [announcement, setAnnouncement] = React.useState('');
  const prevCount = React.useRef(totalQty);
  React.useEffect(() => {
    if (totalQty !== prevCount.current) {
      setAnnouncement(`${totalQty} item${totalQty === 1 ? '' : 's'} in cart.`);
      prevCount.current = totalQty;
    }
  }, [totalQty]);

  async function handleSubmit() {
    if (submitting) return;

    if (!name.trim() || !email.trim()) {
      toast.error('Add your name and email.');
      return;
    }
    if (lines.length === 0) {
      toast.error('Add at least one book.');
      return;
    }
    if (state.fulfillmentType === 'delivery' && !state.charterId) {
      toast.error('Pick a delivery site.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/public/order-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          warehouseId,
          requesterName: name.trim(),
          requesterEmail: email.trim(),
          notes: state.notes.trim() || undefined,
          lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
          fulfillmentType: state.fulfillmentType,
          requesterPhone: phone.trim() || null,
          deliveryCharterId:
            state.fulfillmentType === 'delivery' ? state.charterId : null,
          pickupLocationNotes:
            state.fulfillmentType === 'pickup' ? pickupNotes.trim() || null : null,
          hp: honeypot || undefined,
        }),
      });

      const json = await res.json().catch(() => ({})) as Record<string, unknown>;

      if (!res.ok) {
        toast.error(
          (json.message as string | undefined) ??
          (json.error as string | undefined) ??
          'Something went wrong.',
        );
        return;
      }

      const ok = json as { id: string; trackUrl: string };
      clearCartDraft(warehouseId);
      onSubmitted({ id: ok.id, email: email.trim(), trackUrl: ok.trackUrl });
    } catch {
      toast.error("Couldn't reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside
      className="lg:sticky lg:top-4 lg:self-start w-full lg:w-[360px] lg:flex-none"
      aria-label="Cart"
    >
      {/* Screen-reader live region */}
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
          {name.trim() && (
            <span className="ml-auto text-xs text-muted-foreground truncate max-w-[140px]">
              {name.trim()}
            </span>
          )}
        </div>

        {/* Line items */}
        {lines.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Your cart is empty. Add books from the catalog.
          </p>
        ) : (
          <ul className="divide-y divide-border text-xs space-y-0">
            {lines.map((line) => {
              const item = itemMap.get(line.itemId);
              const itemName = item?.name ?? line.itemId;
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
                    <p className="font-medium truncate leading-tight" title={itemName}>
                      {itemName}
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
                    aria-label={`Remove ${itemName} from cart`}
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
          <label htmlFor="pub-v2-cart-notes" className="text-xs text-muted-foreground">
            Notes
            <span className="ml-1 font-normal">(optional)</span>
          </label>
          <Textarea
            id="pub-v2-cart-notes"
            value={state.notes}
            onChange={(e) => dispatch({ type: 'set-notes', value: e.target.value })}
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
          disabled={submitting || lines.length === 0}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : null}
          Send request
        </Button>
      </div>
    </aside>
  );
}
