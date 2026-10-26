/**
 * What a page says when a request it sent got no usable answer (B40).
 *
 * A Server Action call (or a fetch) REJECTS, instead of resolving with a
 * result, when the browser is offline, when the connection drops, and when the
 * server fails before it can answer (a crash, a timeout, a deploy that no
 * longer has the action). The page then has nothing from the server to show,
 * so it says what did not happen and what to do, in one sentence shape
 * everywhere.
 *
 * The catch that shows it must let Next's control flow through first:
 * `if (isControlFlow(e)) return;` (lib/control-flow.ts), because a redirect to
 * sign-in rejects the call too and the router is already on its way.
 */

/**
 * For a request that is safe to send again (a read, a setting, a rename, an
 * archive): "We couldn't save the view. Check your connection and try again."
 *
 * `what` is the thing that did not happen, as a verb phrase that follows
 * "We couldn't": 'save the view', 'delete the category'.
 */
export function requestFailedMessage(what: string): string {
  return `We couldn't ${what}. Check your connection and try again.`;
}

/**
 * For a write that would happen twice if it were sent again (stock that
 * moves, a record that is created): the request may have reached the server
 * and been applied before the answer was lost, so the person is told to look
 * before trying again, as the maintenance request form already does.
 * "We couldn't confirm that the kits were assembled. Check the bundle's stock
 * before trying again."
 *
 * `what` is a clause that follows "We couldn't confirm that"; `check` names
 * where to look.
 */
export function requestUnconfirmedMessage(what: string, check: string): string {
  return `We couldn't confirm that ${what}. Check ${check} before trying again.`;
}
