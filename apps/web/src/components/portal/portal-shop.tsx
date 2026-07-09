'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, Minus, Plus, RotateCcw, ShoppingCart } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { submitPortalOrderAction } from '@/server/actions/portal';
import type { PortalCatalogItem, PortalOrder } from '@/server/services/portal';

import { ORDER_STATUS_META, isOrderStatusKey } from '@stockpilot/core';

/**
 * Portal storefront: catalog with quantity steppers, a sticky cart bar,
 * checkout, and order history with one-tap reorder (fills the cart from a
 * past order; nothing is submitted until the customer confirms).
 */
export function PortalShop({
  catalog,
  orders,
}: {
  catalog: PortalCatalogItem[];
  orders: PortalOrder[];
}) {
  const router = useRouter();
  const [cart, setCart] = React.useState<Record<string, number>>({});
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [placedId, setPlacedId] = React.useState<string | null>(null);

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
            Your catalog is empty right now — your supplier hasn&apos;t priced
            any items for your account yet.
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
                        {item.inStock ? (
                          <span className="text-green-600 dark:text-green-500">In stock</span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-500">
                            Backorder — ships when available
                          </span>
                        )}
                      </p>
                    </div>
                    <p className="shrink-0 font-mono text-sm">${item.unitPrice.toFixed(2)}</p>
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
            {orders.map((o) => (
              <div key={o.id} className="bg-card rounded-xl border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      #{o.id.slice(0, 8).toUpperCase()}
                      <span className="text-muted-foreground ml-2 font-normal">
                        {new Date(o.created_at).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
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
                    <span className="font-mono text-sm">${o.total.toFixed(2)}</span>
                    <Button variant="outline" size="sm" onClick={() => reorder(o)}>
                      <RotateCcw className="h-3.5 w-3.5" /> Reorder
                    </Button>
                  </div>
                </div>
              </div>
            ))}
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
                {cartLines.reduce((s, [, q]) => s + q, 0)} units ·{' '}
                <span className="font-mono">${total.toFixed(2)}</span>
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
