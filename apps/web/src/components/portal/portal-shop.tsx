'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  ShoppingCart,
  Undo2,
} from 'lucide-react';

import { PortalReturnSheet } from '@/components/portal/portal-return-sheet';
import type { RequesterSubmitted } from '@/components/returns/requester-return-sheet';
import { RequesterTracking } from '@/components/returns/requester-tracking';
import { Button } from '@/components/ui/button';
import { useHydrated } from '@/lib/use-hydrated';
import { submitPortalOrderAction } from '@/server/actions/portal';
import type { PortalCatalogItem, PortalOrder } from '@/server/services/portal';

import {
  ORDER_STATUS_META,
  isOrderStatusKey,
  requesterEntryLabel,
  RETURNS_COPY,
  type PortalPricingMode,
  type RequesterTrackingReturn,
} from '@stockpilot/core';

/** Orders in a terminal fulfilled state are the only ones with a return budget. */
const RETURNABLE_ORDER_STATUSES = new Set(['completed', 'delivered']);

type ReturnableLine = PortalOrder['lines'][number] & { remaining: number };

/** The customer's own requests on an order, as the requester tracking reads them. */
function trackingOf(order: PortalOrder): RequesterTrackingReturn[] {
  return order.returns.map((r) => ({
    returnNumber: r.returnNumber,
    createdAt: r.created_at,
    returnStatus: r.status as RequesterTrackingReturn['returnStatus'],
    exchangeStatus: r.exchangeStatus,
    sentences: r.sentences,
    replacementOrderNumber: r.replacementOrderNumber,
    lines: r.lines,
  }));
}

/** Lines with a positive returnable budget: durable (fulfilled − already
 *  returned) minus live PENDING return requests — the same number the DB cap
 *  trigger enforces, so the form never offers a quantity the server rejects. */
function returnableLines(order: PortalOrder): ReturnableLine[] {
  return order.lines
    .map((l) => ({
      ...l,
      remaining: l.quantityFulfilled - l.quantityReturned - l.quantityPendingReturn,
    }))
    .filter((l) => l.remaining > 0);
}

/**
 * Portal storefront: catalog with quantity steppers, a sticky cart bar,
 * checkout, and order history with one-tap reorder (fills the cart from a
 * past order; nothing is submitted until the customer confirms). Completed
 * orders with a remaining return budget offer an in-place "Return or
 * exchange" sheet (returns RX-3; "Request a return" while exchanges are
 * switched off); the request lands in the supplier's approval queue, and
 * each order lists the customer's own requests in the requester's words.
 */
export function PortalShop({
  catalog,
  orders,
  returnsEnabled,
  exchangesEnabled = false,
  pricingMode,
}: {
  catalog: PortalCatalogItem[];
  orders: PortalOrder[];
  returnsEnabled: boolean;
  /** The exchange kill switch (RETURNS_EXCHANGE_CREATE): the button's words only. */
  exchangesEnabled?: boolean;
  pricingMode: PortalPricingMode;
}) {
  const router = useRouter();
  const [cart, setCart] = React.useState<Record<string, number>>({});
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [placedId, setPlacedId] = React.useState<string | null>(null);
  // Which order's "Return or exchange" sheet is open, and which order just
  // got a request (drives the in-portal confirmation banner).
  const [returnFormOrderId, setReturnFormOrderId] = React.useState<string | null>(null);
  const [returnPlaced, setReturnPlaced] = React.useState<({ orderId: string } & RequesterSubmitted) | null>(null);
  // RX-3 fix round 1 (L5): the sheet is gone once the request is in, so focus
  // moves to the confirmation banner instead of falling to the page.
  const returnBanner = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (returnPlaced) returnBanner.current?.focus();
  }, [returnPlaced]);
  const returnButtonWords = requesterEntryLabel(exchangesEnabled);
  // Order and return days are the viewer's; the server's zone (UTC) would
  // print the next day for an evening order (React error #418). Printed once
  // hydrated.
  const hydrated = useHydrated();

  const byId = React.useMemo(() => new Map(catalog.map((c) => [c.itemId, c])), [catalog]);
  const cartLines = Object.entries(cart).filter(([, q]) => q > 0);
  const total = cartLines.reduce(
    (s, [id, q]) => s + q * (byId.get(id)?.unitPrice ?? 0),
    0,
  );

  function setQty(itemId: string, qty: number) {
    setCart((prev) => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, 100000)) }));
  }

  function reorder(order: PortalOrder) {
    const next: Record<string, number> = {};
    let skipped = 0;
    for (const line of order.lines) {
      if (byId.has(line.itemId)) next[line.itemId] = line.quantity;
      else skipped += 1;
    }
    setCart(next);
    setPlacedId(null);
    setError(
      skipped > 0
        ? `${skipped} item${skipped === 1 ? ' is' : 's are'} no longer available and ${skipped === 1 ? 'was' : 'were'} left out.`
        : null,
    );
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submit() {
    setError(null);
    setBusy(true);
    const res = await submitPortalOrderAction({
      lines: cartLines.map(([itemId, quantity]) => ({ itemId, quantity })),
      notes: notes.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setCart({});
    setNotes('');
    setPlacedId(res.data.id);
    router.refresh();
  }

  return (
    <div className="space-y-10 pb-28">
      {placedId && (
        <div className="border-success/40 bg-success/10 flex items-center gap-2 rounded-xl border p-4 text-sm" role="status">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Order submitted — your supplier will review and confirm it. Reference:{' '}
          <span className="font-mono">{placedId.slice(0, 8).toUpperCase()}</span>
        </div>
      )}

      <section>
        <h2 className="text-muted-foreground mb-3 text-sm font-medium tracking-wide uppercase">
          Catalog · {catalog.length} item{catalog.length === 1 ? '' : 's'}
        </h2>
        {catalog.length === 0 ? (
          <div className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
            {pricingMode === 'no_charge'
              ? "Your supplier hasn't added any items to this account's catalog yet."
              : "Your catalog is empty right now — your supplier hasn't priced any items for your account yet."}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {catalog.map((item) => {
              const qty = cart[item.itemId] ?? 0;
              return (
                <div key={item.itemId} className="bg-card rounded-xl border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium leading-snug">{item.name}</p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {item.sku ? `${item.sku} · ` : ''}
                        {item.quantityAvailable > 0 ? (
                          <span className="text-green-600 dark:text-green-500">
                            {item.quantityAvailable} available
                          </span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-500">
                            Out of stock — ships when available
                          </span>
                        )}
                      </p>
                    </div>
                    {pricingMode === 'no_charge' ? null : item.quotable ? (
                      <p className="text-muted-foreground shrink-0 text-sm">Request quote</p>
                    ) : (
                      <p className="shrink-0 font-mono text-sm">
                        ${(item.unitPrice ?? 0).toFixed(2)}
                      </p>
                    )}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setQty(item.itemId, qty - 1)}
                      disabled={qty === 0}
                      aria-label={`Remove one ${item.name}`}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <input
                      className="border-input bg-background w-16 rounded-md border px-2 py-1 text-center text-sm"
                      inputMode="numeric"
                      value={qty === 0 ? '' : String(qty)}
                      placeholder="0"
                      onChange={(e) => {
                        const n = parseInt(e.target.value.replace(/\D/g, ''), 10);
                        setQty(item.itemId, Number.isFinite(n) ? n : 0);
                      }}
                      aria-label={`Quantity of ${item.name}`}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setQty(item.itemId, qty + 1)}
                      aria-label={`Add one ${item.name}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-muted-foreground mb-3 text-sm font-medium tracking-wide uppercase">
          Your orders
        </h2>
        {orders.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No orders yet — your history will appear here.
          </p>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => {
              const retLines = returnableLines(o);
              const canRequestReturn =
                returnsEnabled &&
                RETURNABLE_ORDER_STATUSES.has(o.status) &&
                retLines.length > 0;
              return (
                <div key={o.id} className="bg-card rounded-xl border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        #{o.id.slice(0, 8).toUpperCase()}
                        <span className="text-muted-foreground ml-2 font-normal">
                          {hydrated
                            ? new Date(o.created_at).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })
                            : null}
                        </span>
                      </p>
                      <p className="text-muted-foreground mt-0.5 truncate text-xs">
                        {o.lines.map((l) => `${l.quantity}× ${l.name}`).join(' · ')}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-muted-foreground text-xs">
                        {isOrderStatusKey(o.status) ? ORDER_STATUS_META[o.status].label : o.status}
                      </span>
                      {pricingMode !== 'no_charge' && (
                        <span className="font-mono text-sm">${o.total.toFixed(2)}</span>
                      )}
                      <Button variant="outline" size="sm" onClick={() => reorder(o)}>
                        <RotateCcw className="h-3.5 w-3.5" /> Reorder
                      </Button>
                      {canRequestReturn && (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-expanded={returnFormOrderId === o.id}
                          aria-controls={returnFormOrderId === o.id ? `portal-return-${o.id}` : undefined}
                          onClick={() => {
                            setReturnPlaced(null);
                            setReturnFormOrderId((cur) => (cur === o.id ? null : o.id));
                          }}
                        >
                          <Undo2 className="h-3.5 w-3.5" aria-hidden /> {returnButtonWords}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* The customer's own requests on this order (returns RX-3): the
                      requester's sentences, what comes back and what replaces
                      it, and the replacement's SO. Never a staff field. */}
                  <RequesterTracking requests={trackingOf(o)} headingLevel={3} density="compact" className="mt-3" />

                  {returnPlaced?.orderId === o.id && (
                    <div
                      ref={returnBanner}
                      tabIndex={-1}
                      className="border-success/40 bg-success/10 mt-3 flex items-center gap-2 rounded-lg border p-3 text-sm outline-none"
                      role="status"
                    >
                      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                      <span>
                        {returnPlaced.hasExchange
                          ? RETURNS_COPY.requesterReceivedExchangeRequest
                          : RETURNS_COPY.requesterReceivedReturnRequest}{' '}
                        {returnPlaced.returnNumber ? `${RETURNS_COPY.requesterReference(returnPlaced.returnNumber)} ` : ''}
                        The warehouse will review it and follow up.
                      </span>
                    </div>
                  )}

                  {returnFormOrderId === o.id && canRequestReturn && (
                    <PortalReturnSheet
                      orderId={o.id}
                      id={`portal-return-${o.id}`}
                      onDone={(result) => {
                        setReturnFormOrderId(null);
                        setReturnPlaced({ orderId: o.id, ...result });
                        router.refresh();
                      }}
                      onCancel={() => setReturnFormOrderId(null)}
                      onStale={() => router.refresh()}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Sticky cart bar */}
      {cartLines.length > 0 && (
        <div className="bg-background/95 fixed inset-x-0 bottom-0 border-t backdrop-blur">
          <div className="mx-auto flex max-w-4xl flex-col gap-2 px-4 py-3 sm:px-6">
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <div className="flex items-center gap-3">
              <ShoppingCart className="text-muted-foreground h-4 w-4 shrink-0" />
              <span className="text-sm">
                {cartLines.reduce((s, [, q]) => s + q, 0)} units
                {pricingMode !== 'no_charge' && (
                  <>
                    {' '}
                    · <span className="font-mono">${total.toFixed(2)}</span>
                  </>
                )}
              </span>
              <input
                className="border-input bg-background min-w-0 flex-1 rounded-md border px-3 py-1.5 text-sm"
                placeholder="Notes for your supplier (optional)"
                value={notes}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
              />
              <Button onClick={() => void submit()} disabled={busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Place order
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
