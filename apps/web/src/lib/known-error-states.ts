/**
 * Error states an error boundary can name, by an error's `digest`.
 *
 * WHY A DIGEST. An error thrown while a Server Component renders does not
 * reach the browser as itself. In a production build React sends only the
 * error's `digest` and builds a stand-in on the client, whose message is
 * React's own generic text (its error 441: "An error occurred in the Server
 * Components render...", printed minified, with a link to React's error
 * list). The class and the message stay on the server, as they should. The
 * digest is the one thing that crosses: Next generates one from the message
 * and stack unless the error already carries its own, which it then keeps
 * (next/dist/server/app-render/create-error-handler.js: "If the error already
 * has a digest, respect the original digest"). So an error class that sets a
 * fixed `digest` is recognizable in error.tsx, and nothing else about it is.
 *
 * WHAT A DIGEST HERE MAY SAY. It is visible to the browser, so it is a plain
 * token for a state the page is about to say in words anyway. Never a
 * message, a table, an id or anything about the request.
 *
 * No server-only import: the error classes (server) and the error cards
 * (client components) both read this file.
 */

/**
 * A check of the caller's access could not be made (an organization's module
 * state that could not be read: lib/modules/module-state
 * ModulesUnavailableError). Not a crash, and nothing the person did.
 */
export const ACCESS_UNCHECKED_DIGEST = 'STOCKPILOT_ACCESS_UNCHECKED';

/**
 * A public link could not be checked (server/services/public-catalog
 * PublicLinkUnavailableError). Neither "open" nor "not found".
 */
export const LINK_UNCHECKED_DIGEST = 'STOCKPILOT_LINK_UNCHECKED';

export interface KnownErrorState {
  key: 'access-unchecked' | 'link-unchecked';
  /** The card's heading. */
  title: string;
  /** The one sentence under it. */
  body: string;
}

const STATES: Record<string, KnownErrorState> = {
  [ACCESS_UNCHECKED_DIGEST]: {
    key: 'access-unchecked',
    title: "This page couldn't be loaded",
    body: "We couldn't check your access just now. This is usually temporary.",
  },
  [LINK_UNCHECKED_DIGEST]: {
    key: 'link-unchecked',
    title: "This page couldn't be loaded",
    body: "We couldn't check this link just now. This is usually temporary.",
  },
};

/** The state `error`'s digest names, or null for any other error. */
export function knownErrorState(error: unknown): KnownErrorState | null {
  if (!error || typeof error !== 'object') return null;
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(STATES, digest) ? STATES[digest]! : null;
}
