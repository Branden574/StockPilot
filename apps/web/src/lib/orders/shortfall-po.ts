import type { ShortfallPoView } from '@stockpilot/core';

/**
 * DRAFT A PO FOR WHAT AN ORDER IS SHORT (F2-5), the web order page's plumbing.
 *
 * The page mounts the dialog ONCE, at a spot no refresh moves, and puts only
 * the button on the readiness strip. Drafting reads the page again (the strip
 * then counts the new drafts), and when nothing is left to draft that refresh
 * takes the button away; the dialog, which is showing the links to the new
 * drafts, must not go with it. So the button asks the mounted dialog to open
 * through this registry, keyed by the order, as the needed-by Change does
 * (needed-by-change-opener.ts).
 *
 * Plain module (no directive): the page (a server component) builds the
 * offer, the dialog and the button (client components) share the registry,
 * and the load action ('use server') names its answer's type from here.
 */

/** What the page hands the dialog: the order, what its readiness read says
 *  may be drafted (core shortfallPoView, from the page's own read, so the
 *  dialog opens at once), and the org's zone for "Checked at". Null when the
 *  viewer may not draft, or nothing may be drafted. Plain data. */
export interface ShortfallPoOffer {
  orderId: string;
  view: ShortfallPoView;
  timeZone: string;
}

/**
 * What loadShortfallPoAction answers when the dialog opens, and again after a
 * refusal because the numbers moved: readiness read again (the view) and the
 * organization's supplier names (SuppliersService.listForLookups, id to
 * name). Either is null when it could not be read: the dialog keeps the view
 * it has, and a supplier it cannot name says so (core
 * SHORTFALL_SUPPLIER_UNKNOWN_COPY). The draft itself re-checks everything.
 */
export interface ShortfallPoLoad {
  view: ShortfallPoView | null;
  supplierNames: Record<string, string> | null;
}

/** Opens the dialog; `trigger` is the button pressed (focus returns to it). */
export type ShortfallPoOpener = (trigger: HTMLElement | null) => void;

const openers = new Map<string, ShortfallPoOpener>();

/** Registers the mounted dialog for an order. Returns its unregister, which
 *  removes only this registration (a newer one for the same order stays). */
export function registerShortfallPoOpener(orderId: string, open: ShortfallPoOpener): () => void {
  openers.set(orderId, open);
  return () => {
    if (openers.get(orderId) === open) openers.delete(orderId);
  };
}

/** Opens the order's dialog. False when none is mounted. */
export function openShortfallPo(orderId: string, trigger: HTMLElement | null): boolean {
  const open = openers.get(orderId);
  if (!open) return false;
  open(trigger);
  return true;
}
