'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  checkShortfallSelection,
  defaultShortfallSelection,
  keepShortfallSelection,
  parseShortfallChangedDetail,
  parseShortfallQuantity,
  readinessCheckedAtCopy,
  SHORTFALL_PO_FAILED_COPY,
  SHORTFALL_PO_INVALID_COPY,
  SHORTFALL_PO_SUBMIT_LABEL,
  SHORTFALL_PO_TITLE,
  SHORTFALL_PO_CHANGED_COPY,
  SHORTFALL_SUPPLIER_UNKNOWN_COPY,
  shortfallDraftGroups,
  shortfallIdempotencyKey,
  shortfallPoCreatedCopy,
  shortfallPoCreatedRowCopy,
  shortfallPoFooterCopy,
  shortfallPoRetryable,
  shortfallSupplierLabel,
  type ActionResult,
  type ShortfallKeyState,
  type ShortfallPoFailureReason,
  type ShortfallPoLine,
  type ShortfallPoResult,
  type ShortfallPoRow,
  type ShortfallPoView,
  type ShortfallSelection,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { IntentLink } from '@/components/ui/intent-link';
import {
  registerShortfallPoOpener,
  type ShortfallPoLoad,
  type ShortfallPoOffer,
} from '@/lib/orders/shortfall-po';
import { cn } from '@/lib/utils';
import { draftShortfallPosAction, loadShortfallPoAction } from '@/server/actions/order-readiness';

/** A new idempotency key: random, never derived from the request. */
function mintKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `sfp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Refusals after which readiness is read again: the numbers, the order or
 *  its items moved under the dialog. */
const RELOAD_ON: ReadonlySet<ShortfallPoFailureReason> = new Set([
  'shortfall_changed',
  'item_not_draftable',
  'line_not_on_order',
  'not_applicable',
]);

/** Whether two views offer different things to draft (a row's state or its
 *  most). */
function draftableChanged(a: ShortfallPoView, b: ShortfallPoView): boolean {
  const key = (v: ShortfallPoView) =>
    v.rows
      .map((r) => `${r.itemId.toLowerCase()}:${r.state}:${r.draftable}`)
      .sort()
      .join('|');
  return key(a) !== key(b);
}

/** The database's current most per item (shortfall_changed), applied to the
 *  rows at once, before readiness is read again: a row keeps its words until
 *  that read answers, and its field then says the new most. */
function withCurrentMaxima(view: ShortfallPoView, current: Record<string, number> | null): ShortfallPoView {
  if (!current) return view;
  return {
    ...view,
    rows: view.rows.map((r) => {
      const now = current[r.itemId.toLowerCase()];
      return r.state === 'draftable' && now !== undefined ? { ...r, draftable: now } : r;
    }),
  };
}

type Phase = { step: 'choose' } | { step: 'drafting' } | { step: 'done'; result: ShortfallPoResult };

/**
 * DRAFT A PO FOR WHAT AN ORDER IS SHORT (F2-5), on the web order page.
 *
 * WHO. The page offers it (core canDraftShortfallPo: a manager holding
 * purchase_orders:manage, the orders and purchase_orders modules on) when its
 * readiness read leaves something to draft; anyone else on the full strip
 * reads core's sentence instead. The service and draft_order_shortfall_pos
 * (0385) repeat every floor.
 *
 * WHAT. One row per short item (core shortfallPoView, from the page's own
 * readiness read, so it opens at once): a checkbox, on for every item that
 * may be drafted; "Short 12 · already on order or draft 4"; the quantity,
 * starting at the most that may be drafted; and its supplier, or core's
 * sentence for an item with none. Items already covered by an open PO or a
 * draft are shown unticked and cannot be chosen, with what covers them
 * ("Already on PO-2026-0021 (40 still to arrive)"; a PO the reader cannot
 * open is a quantity only). Kits, deleted items and items moved to another
 * warehouse say why they are not drafted. The footer counts the drafts the
 * choice makes, in the database's grouping (one per supplier, one more for the
 * items with no supplier), and says drafts are not sent.
 *
 * ON OPEN, one read (loadShortfallPoAction): readiness again and the supplier
 * names, in parallel; the page reads neither for this. A fresh answer that
 * offers something else replaces the rows and says so, keeping whatever was
 * already chosen (core keepShortfallSelection).
 *
 * DRAFT sends the chosen lines with an idempotency key minted for THAT
 * request (core shortfallIdempotencyKey): pressing Draft again for the same
 * request (a lost answer, "try again") reuses it, so the database answers
 * with the first drafts instead of making more; any edit discards it. A
 * double press sends once.
 *
 * REFUSALS stay in the dialog as an inline alert in core's words (pattern
 * #20). When stock or POs moved (shortfall_changed), the database's current
 * most applies to the rows at once, readiness is read again, and the choice
 * is KEPT: a quantity above the new most is shown as a problem to fix, never
 * lowered silently; an item with nothing left is unticked. "Busy" and a lost
 * answer keep the key, so pressing Draft again is the same request.
 *
 * DONE: core's sentence from the answer (never from what was asked for) and a
 * link to each draft. The page is read again behind it. Drafts are not sent,
 * and nothing here emails or notifies anyone.
 *
 * THE PAGE MOUNTS IT ONCE, at the top, with `offer` null when nothing is
 * offered; an open dialog keeps its own copy until it is closed.
 */
export function DraftShortfallPoDialog({ offer }: { offer: ShortfallPoOffer | null }) {
  const router = useRouter();
  const ids = React.useId();

  const [open, setOpen] = React.useState(false);
  // The last offer the page handed over, kept for an open dialog when the
  // page stops offering (adjusted while rendering, as for the needed-by
  // dialog).
  const [lastOffer, setLastOffer] = React.useState<ShortfallPoOffer | null>(offer);
  if (offer !== null && offer !== lastOffer) setLastOffer(offer);
  const live = offer ?? (open ? lastOffer : null);
  const orderId = live?.orderId ?? null;

  // The dialog's own copy, taken when it opens: a refresh behind it never
  // changes what the person is choosing from.
  const [session, setSession] = React.useState<{ orderId: string; timeZone: string } | null>(null);
  const [view, setView] = React.useState<ShortfallPoView | null>(null);
  const [selection, setSelection] = React.useState<ShortfallSelection>({});
  const [names, setNames] = React.useState<Record<string, string> | null>(null);
  const [namesFailed, setNamesFailed] = React.useState(false);
  const [keyState, setKeyState] = React.useState<ShortfallKeyState | null>(null);
  const [phase, setPhase] = React.useState<Phase>({ step: 'choose' });
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  /** The person changed the choice since the dialog opened. */
  const touched = React.useRef(false);
  /** A draft is on its way (a second press in the same tick sends nothing). */
  const inFlight = React.useRef(false);
  /** Bumped on every load and on close: an older answer is dropped. */
  const loadSeq = React.useRef(0);
  const openedBy = React.useRef<HTMLElement | null>(null);

  const drafting = phase.step === 'drafting';

  function adopt(fresh: ShortfallPoView) {
    setView(fresh);
    setSelection((sel) => (touched.current ? keepShortfallSelection(sel, fresh).selection : defaultShortfallSelection(fresh)));
    if (!touched.current) setKeyState(null);
  }

  /** Reads readiness and the supplier names. `opened`: the view the dialog
   *  opened with (the page's), when this is the read on open. */
  async function load(forOrder: string, opened: ShortfallPoView | null) {
    const seq = ++loadSeq.current;
    let res: ShortfallPoLoad | null;
    try {
      res = await loadShortfallPoAction({ orderId: forOrder });
    } catch {
      res = null;
    }
    if (seq !== loadSeq.current) return;
    // Names already read stay when a later read fails.
    if (res?.supplierNames) {
      setNames(res.supplierNames);
      setNamesFailed(false);
    } else {
      setNamesFailed(true);
    }
    // A fresh view never lands under a draft on its way: the draft's answer
    // says what happened.
    if (res?.view && !inFlight.current) {
      adopt(res.view);
      if (opened && draftableChanged(opened, res.view)) setNotice(SHORTFALL_PO_CHANGED_COPY);
    }
  }

  function onOpenChange(next: boolean) {
    // Never dismissed while a draft is on its way: its answer is still to come.
    if (drafting || inFlight.current) return;
    if (next) {
      if (!live) return;
      // A fresh start each time, from the page's latest read.
      touched.current = false;
      setSession({ orderId: live.orderId, timeZone: live.timeZone });
      setView(live.view);
      setSelection(defaultShortfallSelection(live.view));
      setNames(null);
      setNamesFailed(false);
      setKeyState(null);
      setPhase({ step: 'choose' });
      setError(null);
      setNotice(null);
      setOpen(true);
      void load(live.orderId, live.view);
      return;
    }
    loadSeq.current++;
    setOpen(false);
  }

  // Opened by DraftShortfallPoButton, wherever the page puts it.
  const openFromButton = React.useEffectEvent((button: HTMLElement | null) => {
    openedBy.current = button;
    onOpenChange(true);
  });
  React.useEffect(() => {
    if (orderId === null) return;
    return registerShortfallPoOpener(orderId, (button) => openFromButton(button));
  }, [orderId]);

  function returnFocus(e: Event) {
    const opener = openedBy.current;
    const target =
      opener && opener.isConnected
        ? opener
        : session
          ? document.querySelector<HTMLElement>(`[data-shortfall-po="${session.orderId}"]`)
          : null;
    // The button is gone once nothing is left to draft: focus then goes where
    // the dialog library puts it.
    if (!target) return;
    e.preventDefault();
    target.focus();
  }

  function edit(itemId: string, change: { checked?: boolean; quantity?: string }) {
    touched.current = true;
    // Any edit is another request: the next Draft mints its own key.
    setKeyState(null);
    setSelection((sel) => {
      const cur = sel[itemId];
      if (!cur) return sel;
      return { ...sel, [itemId]: { ...cur, ...change } };
    });
  }

  async function draft() {
    if (inFlight.current || !view || !session) return;
    const check = checkShortfallSelection(view, selection);
    if (!check.ok) {
      const first = Object.keys(check.problems)[0];
      if (first) {
        // Each problem is under its field; take the person to the first.
        document.getElementById(`${ids}-qty-${first}`)?.focus();
        setError(null);
      } else {
        setError(SHORTFALL_PO_INVALID_COPY);
      }
      return;
    }
    const next = shortfallIdempotencyKey(keyState, session.orderId, check.lines, mintKey);
    setKeyState(next);
    inFlight.current = true;
    setPhase({ step: 'drafting' });
    setError(null);
    setNotice(null);
    // null: the action never answered.
    let res: ActionResult<ShortfallPoResult> | null;
    try {
      res = await draftShortfallPosAction({
        orderId: session.orderId,
        lines: check.lines,
        idempotencyKey: next.key,
      });
    } catch {
      res = null;
    }
    inFlight.current = false;
    if (!res) {
      // Whether the drafts were made is unknown. The key stays with this
      // request: pressing Draft again either makes them or answers with the
      // ones already made, never both.
      setPhase({ step: 'choose' });
      setError(SHORTFALL_PO_FAILED_COPY);
      return;
    }
    if (res.ok) {
      setPhase({ step: 'done', result: res.data });
      // The strip and the lines behind now count the new drafts.
      router.refresh();
      return;
    }
    const details = res.error.details ?? {};
    const reason = (typeof details.reason === 'string' ? details.reason : 'failed') as ShortfallPoFailureReason;
    setPhase({ step: 'choose' });
    setError(res.error.message);
    // Only "busy" and a fault are the same request tried again.
    if (!shortfallPoRetryable(reason)) setKeyState(null);
    if (reason === 'shortfall_changed') {
      const patched = withCurrentMaxima(view, parseShortfallChangedDetail(details.current));
      touched.current = true;
      setView(patched);
      setSelection((sel) => keepShortfallSelection(sel, patched).selection);
    }
    if (RELOAD_ON.has(reason)) {
      touched.current = true;
      void load(session.orderId, null);
      router.refresh();
    }
    if (reason === 'not_found') {
      // The page it sits on is replaced by "not found", and the dialog with it.
      toast.error(res.error.message);
      router.refresh();
    }
  }

  if (!live && !open) return null;

  const timeZone = session?.timeZone ?? live?.timeZone ?? '';
  const chosenLines: ShortfallPoLine[] = view
    ? view.rows
        .filter((r) => r.state === 'draftable' && selection[r.itemId]?.checked)
        .map((r) => ({ itemId: r.itemId, quantity: parseShortfallQuantity(selection[r.itemId]!.quantity) ?? 0 }))
    : [];
  const check = view ? checkShortfallSelection(view, selection) : null;
  const done = phase.step === 'done' ? phase.result : null;
  const canDraft = !!view && view.draftableCount > 0 && chosenLines.length > 0 && !drafting;
  const qtyHeaderId = `${ids}-qty-header`;

  const supplierText = (supplierId: string | null): string | null => {
    if (!supplierId) return shortfallSupplierLabel(null, {});
    if (names) return shortfallSupplierLabel(supplierId, names);
    return namesFailed ? SHORTFALL_SUPPLIER_UNKNOWN_COPY : null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="draft-shortfall-po-dialog" onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{SHORTFALL_PO_TITLE}</DialogTitle>
          {view && (
            <DialogDescription data-testid="draft-shortfall-po-checked-at">
              {readinessCheckedAtCopy(view.observedAt, { timeZone })}
            </DialogDescription>
          )}
        </DialogHeader>

        {/* The result's live region is mounted from the start (empty until
            the drafts exist), so a screen reader announces it when it is
            filled in. */}
        <div role="status" aria-live="polite" data-testid="draft-shortfall-po-status">
          {done && (
            <p className="text-sm font-medium" data-testid="draft-shortfall-po-result">
              {shortfallPoCreatedCopy(done)}
            </p>
          )}
          {!done && notice && (
            <p className="text-muted-foreground text-sm" data-testid="draft-shortfall-po-notice">
              {notice}
            </p>
          )}
        </div>

        {done && done.created.length > 0 && (
          <ul className="border-border divide-border divide-y rounded-lg border text-sm" data-testid="draft-shortfall-po-created">
            {done.created.map((c) => (
              <li key={c.purchaseOrderId} className="px-3 py-2" data-testid="draft-shortfall-po-created-row">
                <IntentLink
                  href={`/dashboard/purchase-orders/${c.purchaseOrderId}`}
                  className="text-primary font-medium underline-offset-2 hover:underline"
                >
                  {shortfallPoCreatedRowCopy(c)}
                </IntentLink>
                <p className="text-muted-foreground mt-0.5 text-xs">{supplierText(c.supplierId) ?? ''}</p>
              </li>
            ))}
          </ul>
        )}

        {!done && view && view.rows.length === 0 && (
          <p className="text-sm" data-testid="draft-shortfall-po-unavailable">
            {view.unavailableCopy}
          </p>
        )}

        {!done && view && view.rows.length > 0 && (
          <div className="grid gap-2">
            {view.draftableCount > 0 && (
              <div className="text-muted-foreground flex justify-end px-3 text-xs" aria-hidden>
                <span id={qtyHeaderId} className="w-24 text-right">
                  Quantity
                </span>
              </div>
            )}
            <ul
              className="border-border divide-border max-h-[50vh] divide-y overflow-y-auto rounded-lg border text-sm"
              aria-busy={names === null && !namesFailed ? true : undefined}
              data-testid="draft-shortfall-po-rows"
            >
              {view.rows.map((row) => (
                <ShortfallRow
                  key={row.itemId}
                  row={row}
                  idBase={`${ids}-${row.itemId}`}
                  qtyId={`${ids}-qty-${row.itemId}`}
                  qtyHeaderId={qtyHeaderId}
                  checked={row.state === 'draftable' && !!selection[row.itemId]?.checked}
                  quantity={selection[row.itemId]?.quantity ?? ''}
                  problem={row.state === 'draftable' && selection[row.itemId]?.checked ? (check?.problems[row.itemId] ?? null) : null}
                  supplier={row.state === 'draftable' ? supplierText(row.supplierId) : null}
                  disabled={drafting}
                  onToggle={(checked) => edit(row.itemId, { checked })}
                  onQuantity={(quantity) => edit(row.itemId, { quantity })}
                />
              ))}
            </ul>
            {view.hiddenNote && (
              <p className="text-muted-foreground text-xs" data-testid="draft-shortfall-po-hidden">
                {view.hiddenNote}
              </p>
            )}
            {view.draftableCount > 0 && (
              <p className="text-muted-foreground text-xs" data-testid="draft-shortfall-po-footer">
                {shortfallPoFooterCopy(shortfallDraftGroups(view, chosenLines))}
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-destructive text-sm" data-testid="draft-shortfall-po-error">
            {error}
          </p>
        )}

        <DialogFooter>
          {done ? (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="draft-shortfall-po-close">
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={drafting}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void draft()}
                disabled={!canDraft}
                data-testid="draft-shortfall-po-submit"
              >
                {drafting && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                {SHORTFALL_PO_SUBMIT_LABEL}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One short item: its choice, its numbers in core's words, its supplier and
 *  its quantity. Covered, kit, deleted and moved items say why and cannot be
 *  chosen. */
function ShortfallRow({
  row,
  idBase,
  qtyId,
  qtyHeaderId,
  checked,
  quantity,
  problem,
  supplier,
  disabled,
  onToggle,
  onQuantity,
}: {
  row: ShortfallPoRow;
  idBase: string;
  qtyId: string;
  qtyHeaderId: string;
  checked: boolean;
  quantity: string;
  problem: string | null;
  /** The supplier's name or core's sentence; null while it is being read. */
  supplier: string | null;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
  onQuantity: (quantity: string) => void;
}) {
  const draftable = row.state === 'draftable';
  const nameId = `${idBase}-name`;
  const detailId = `${idBase}-detail`;
  const supplierId = `${idBase}-supplier`;
  const problemId = `${idBase}-problem`;
  const checkboxId = `${idBase}-check`;
  const describedBy = [detailId, draftable ? supplierId : null].filter(Boolean).join(' ');
  return (
    <li
      className={cn('flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5', !draftable && 'bg-muted/30')}
      data-testid="draft-shortfall-po-row"
      data-item-id={row.itemId}
      data-state={row.state}
    >
      <label htmlFor={checkboxId} className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-start gap-2.5">
        <input
          id={checkboxId}
          type="checkbox"
          className="accent-primary mt-0.5 size-4 shrink-0"
          checked={checked}
          disabled={!draftable || disabled}
          aria-labelledby={nameId}
          aria-describedby={describedBy}
          onChange={(e) => onToggle(e.target.checked)}
          data-testid="draft-shortfall-po-check"
        />
        <span className="min-w-0">
          <span id={nameId} className="block font-medium break-words">
            {row.itemSku ? `${row.itemName} (${row.itemSku})` : row.itemName}
          </span>
          <span id={detailId} className="text-muted-foreground block text-xs tabular-nums" data-testid="draft-shortfall-po-detail">
            {row.detail}
          </span>
          {draftable && (
            <span id={supplierId} className="text-muted-foreground block text-xs" data-testid="draft-shortfall-po-supplier">
              {supplier ?? <span className="bg-muted inline-block h-3 w-28 animate-pulse rounded align-middle" aria-hidden />}
            </span>
          )}
        </span>
      </label>
      {draftable && (
        <div className="ml-auto grid w-24 gap-1">
          <Input
            id={qtyId}
            inputMode="decimal"
            autoComplete="off"
            value={quantity}
            onChange={(e) => onQuantity(e.target.value)}
            disabled={!checked || disabled}
            aria-labelledby={`${qtyHeaderId} ${nameId}`}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? problemId : undefined}
            className="h-9 text-right tabular-nums"
            data-testid="draft-shortfall-po-qty"
          />
          {problem && (
            <p id={problemId} className="text-destructive text-xs" data-testid="draft-shortfall-po-problem">
              {problem}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
