/**
 * The order page mounts its needed-by dialog ONCE, at a stable spot, and puts
 * only the Change button beside the date: on the readiness strip while the
 * order is to be picked, in the Dates card otherwise (F2-4). A refresh can move
 * that button (picking completes while an approver is editing) or take it away
 * (the readiness read failed, the order closed); the dialog, and what was
 * typed in it, must not go with it. So the button asks the mounted dialog to
 * open through this registry, keyed by the order.
 *
 * Plain module: the dialog (a client component) registers itself while it is
 * mounted, and the button (a client component) calls it from its click.
 */

/** Opens the dialog; `trigger` is the button pressed (focus returns to it). */
export type NeededByChangeOpener = (trigger: HTMLElement | null) => void;

const openers = new Map<string, NeededByChangeOpener>();

/** Registers the mounted dialog for an order. Returns its unregister, which
 *  removes only this registration (a newer one for the same order stays). */
export function registerNeededByChangeOpener(orderId: string, open: NeededByChangeOpener): () => void {
  openers.set(orderId, open);
  return () => {
    if (openers.get(orderId) === open) openers.delete(orderId);
  };
}

/** Opens the order's dialog. False when none is mounted. */
export function openNeededByChange(orderId: string, trigger: HTMLElement | null): boolean {
  const open = openers.get(orderId);
  if (!open) return false;
  open(trigger);
  return true;
}
