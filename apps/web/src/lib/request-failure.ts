/**
 * What a page says when a request it sent got no usable answer (B40).
 *
 * A Server Action call (or a fetch) REJECTS, instead of resolving with a
 * result, when the browser is offline, when the connection drops, when the
 * server fails before it can answer (a crash, a timeout, an edge refusal) and
 * when a deploy no longer has the action. The page then has nothing from the
 * server to show, so it says what did not happen and what to do, in one
 * sentence shape everywhere.
 *
 * Both messages take the error first, so a page older than the server (its
 * Server Action is gone after a deploy) says to reload instead of to check the
 * connection: trying again from that page fails every time until it reloads.
 *
 * The catch that shows it must let Next's control flow through first:
 * `if (isControlFlow(e)) return;` (lib/control-flow.ts), because a redirect to
 * sign-in rejects the call too and the router is already on its way.
 */

/**
 * True when the call never ran because the page was built by an older deploy:
 * the Server Action it names is not on the server any more. Next throws an
 * UnrecognizedActionError, 'Server Action "..." was not found on the server'
 * (next/dist/client/components/router-reducer/reducers/server-action-reducer.js);
 * older servers answered "Failed to find Server Action". Nothing ran, so
 * nothing changed, and only a reload helps.
 *
 * The order storefront uses the same test (orderCallResultFromThrown), so the
 * two never disagree about what an out-of-date page is.
 */
export function isActionOutOfDate(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === 'UnrecognizedActionError' ||
      /was not found on the server|Failed to find Server Action/i.test(e.message))
  );
}

/**
 * For a request that is safe to send again (a read, a setting, a rename, an
 * archive, a delete, a status the server refuses to repeat):
 * "We couldn't save the view. Check your connection and try again."
 *
 * `e` is what the call rejected with. `what` is the thing that did not
 * happen, as a verb phrase that follows "We couldn't": 'save the view',
 * 'delete the category'.
 *
 * A page older than the server gets "StockPilot was updated since this page
 * was opened, so we couldn't save the view. Reload the page, then try again."
 */
export function requestFailedMessage(e: unknown, what: string): string {
  if (isActionOutOfDate(e)) {
    return `StockPilot was updated since this page was opened, so we couldn't ${what}. Reload the page, then try again.`;
  }
  return `We couldn't ${what}. Check your connection and try again.`;
}

/**
 * For a write that would happen twice if it were sent again (stock that
 * moves by an amount, a record that is created): the request may have reached
 * the server and been applied before the answer was lost, so the person is
 * told to look before trying again, as the maintenance request form already
 * does. "We couldn't confirm that the kits were assembled. Check the bundle's
 * stock before trying again."
 *
 * `e` is what the call rejected with. `what` is a clause that follows "We
 * couldn't confirm that"; `check` names where to look.
 *
 * A page older than the server gets "StockPilot was updated since this page
 * was opened, so nothing was changed. Reload the page, then try again.": the
 * action is not on the server, so it never ran, and that is certain (the
 * storefront words it the same way, core ORDER_PAGE_OUT_OF_DATE_FINAL_COPY).
 */
export function requestUnconfirmedMessage(e: unknown, what: string, check: string): string {
  if (isActionOutOfDate(e)) {
    return 'StockPilot was updated since this page was opened, so nothing was changed. Reload the page, then try again.';
  }
  return `We couldn't confirm that ${what}. Check ${check} before trying again.`;
}
