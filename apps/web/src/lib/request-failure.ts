/**
 * What a page says when a request it sent got no usable answer (B40).
 *
 * A Server Action call (or a fetch) REJECTS, instead of resolving with a
 * result, when the browser is offline, when the connection drops, and when the
 * server fails before it can answer (a crash, a timeout, a deploy that no
 * longer has the action). The page then has nothing from the server to show,
 * so it says what did not happen and what to do, in one sentence shape
 * everywhere: "We couldn't save the view. Check your connection and try
 * again."
 *
 * `what` is the thing that did not happen, as a verb phrase that follows
 * "We couldn't": 'save the view', 'delete the category'.
 *
 * The catch that shows it must let Next's control flow through first:
 * `if (isControlFlow(e)) return;` (lib/control-flow.ts), because a redirect to
 * sign-in rejects the call too and the router is already on its way.
 */
export function requestFailedMessage(what: string): string {
  return `We couldn't ${what}. Check your connection and try again.`;
}
