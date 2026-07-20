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

import { Button } from '@/components/ui/button';
import { requestPortalReturnAction, submitPortalOrderAction } from '@/server/actions/portal';
import type { PortalCatalogItem, PortalOrder } from '@/server/services/portal';

import { ORDER_STATUS_META, isOrderStatusKey } from '@stockpilot/core';

/** Orders in a terminal fulfilled state are the only ones with a return budget. */
const RETURNABLE_ORDER_STATUSES = new Set(['completed', 'delivered']);

const RETURN_REASON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'overage', label: 'Too many / overage' },
  { value: 'end_of_year', label: 'End of year' },
  { value: 'other', label: 'Other' },
];

/** Customer-facing labels for the return lifecycle (status + date only). */
const RETURN_STATUS_LABELS: Record<string, string> = {
  requested: 'Return requested — pending approval',
  approved: 'Return approved — awaiting drop-off/receipt',
  received: 'Return received',
  closed: 'Return completed',
  denied: 'Return declined',
  cancelled: 'Return cancelled',
};

type ReturnableLine = PortalOrder['lines'][number] & { remaining: number };

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
 * orders with a remaining return budget offer an in-place "Request a return"
 * form; the request lands in the supplier's approval queue.
 */
export function PortalShop({
  catalog,
  orders,
  returnsEnabled,
}: {
  catalog: PortalCatalogItem[];
  orders: PortalOrder[];
  returnsEnabled: boolean;
}) {
  const router = useRouter();
  const [cart, setCart] = React.useState<Record<string, number>>({});
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [placedId, setPlacedId] = React.useState<string | null>(null);
  // Which order's "Request a return" form is open, and which order just got
  // a return submitted (drives the in-portal confirmation banner).
  const [returnFormOrderId, setReturnFormOrderId] = React.useState<string | null>(null);
  const [returnPlacedOrderId, setReturnPlacedOrderId] = React.useState<string | null>(null);

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
                      {canRequestReturn && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setReturnPlacedOrderId(null);
                            setReturnFormOrderId((cur) => (cur === o.id ? null : o.id));
                          }}
                        >
                          <Undo2 className="h-3.5 w-3.5" /> Request a return
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* The customer's return requests on this order — status + date only. */}
                  {o.returns.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {o.returns.map((ret) => (
                        <li key={ret.id} className="text-muted-foreground text-xs">
                          {RETURN_STATUS_LABELS[ret.status] ?? `Return ${ret.status}`}
                          {' · '}
                          {new Date(ret.created_at).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </li>
                      ))}
                    </ul>
                  )}

                  {returnPlacedOrderId === o.id && (
                    <div
                      className="border-success/40 bg-success/10 mt-3 flex items-center gap-2 rounded-lg border p-3 text-sm"
                      role="status"
                    >
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      Return requested — pending approval. Your supplier will review it and
                      follow up.
                    </div>
                  )}

                  {returnFormOrderId === o.id && canRequestReturn && (
                    <PortalReturnForm
                      orderId={o.id}
                      lines={retLines}
                      onDone={() => {
                        setReturnFormOrderId(null);
                        setReturnPlacedOrderId(o.id);
                        router.refresh();
                      }}
                      onCancel={() => setReturnFormOrderId(null)}
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

/**
 * Inline "Request a return" form for one completed order. Quantity pickers
 * are capped at each line's remaining budget (fulfilled − already returned)
 * so the common path never bounces off a validation error — but the server
 * NEVER trusts these values: the portal action re-resolves the customer's
 * own order and re-validates every line against the durable budget.
 */
function PortalReturnForm({
  orderId,
  lines,
  onDone,
  onCancel,
}: {
  orderId: string;
  lines: ReturnableLine[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [quantities, setQuantities] = React.useState<Record<string, number>>(() =>
    Object.fromEntries(lines.map((l) => [l.orderRequestLineId, l.remaining])),
  );
  const [reasonCode, setReasonCode] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function setQty(line: ReturnableLine, raw: string) {
    const n = Math.floor(Number(raw));
    const clamped = Number.isFinite(n) ? Math.max(1, Math.min(line.remaining, n)) : 1;
    setQuantities((prev) => ({ ...prev, [line.orderRequestLineId]: clamped }));
  }

  async function submit() {
    const picked = lines.filter((l) => selected[l.orderRequestLineId]);
    if (picked.length === 0) {
      setError('Pick at least one item to return.');
      return;
    }
    setError(null);
    setBusy(true);
    const res = await requestPortalReturnAction({
      orderId,
      reasonCode: (reasonCode || undefined) as
        | 'damaged'
        | 'wrong_item'
        | 'end_of_year'
        | 'overage'
        | 'other'
        | undefined,
      notes: notes.trim() || undefined,
      lines: picked.map((l) => ({
        orderRequestLineId: l.orderRequestLineId,
        quantity: quantities[l.orderRequestLineId] ?? l.remaining,
      })),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    onDone();
  }

  return (
    <div className="bg-muted/40 mt-3 space-y-3 rounded-lg border p-3">
      <p className="text-sm font-medium">Request a return</p>
      <ul className="space-y-2">
        {lines.map((line) => {
          const isSelected = Boolean(selected[line.orderRequestLineId]);
          return (
            <li key={line.orderRequestLineId} className="flex items-center gap-3">
              <input
                type="checkbox"
                id={`ret-${orderId}-${line.orderRequestLineId}`}
                checked={isSelected}
                onChange={() =>
                  setSelected((prev) => ({
                    ...prev,
                    [line.orderRequestLineId]: !prev[line.orderRequestLineId],
                  }))
                }
                className="h-4 w-4 shrink-0"
              />
              <label
                htmlFor={`ret-${orderId}-${line.orderRequestLineId}`}
                className="min-w-0 flex-1 cursor-pointer text-sm"
              >
                <span className="font-medium">{line.name}</span>
                <span className="text-muted-foreground ml-2 text-xs">
                  {line.remaining} of {line.quantityFulfilled} returnable
                </span>
              </label>
              {isSelected && (
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={line.remaining}
                  value={quantities[line.orderRequestLineId] ?? line.remaining}
                  onChange={(e) => setQty(line, e.target.value)}
                  className="border-input bg-background w-20 shrink-0 rounded-md border px-2 py-1 text-center text-sm"
                  aria-label={`Quantity to return for ${line.name}`}
                />
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          className="border-input bg-background rounded-md border px-2 py-1.5 text-sm"
          aria-label="Return reason"
        >
          <option value="">Reason (optional)</option>
          {RETURN_REASON_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <input
          className="border-input bg-background min-w-0 flex-1 rounded-md border px-3 py-1.5 text-sm"
          placeholder="Notes for your supplier (optional)"
          value={notes}
          maxLength={2000}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Submit return request
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
