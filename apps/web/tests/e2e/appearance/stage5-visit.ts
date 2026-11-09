/**
 * What a stage 5 accessibility spec may conclude from opening a page, and
 * how much it must have measured before it may pass. Pure, so
 * src/test/stage5-visit.test.ts proves it without a browser; stage5-pages.ts
 * (visit) and the a11y specs apply it.
 *
 * Why: a page that answered 500 used to read as "does not open for this
 * role", so its test skipped (signed in) or measured nothing and passed
 * (signed out). A glass build that crashed a route was green. Now:
 *  - a server error (500 and above), no response, a 4xx other than 401, 403
 *    and 404, or a signed-in page that lands on /signin (the session was
 *    lost) is a FAILURE;
 *  - only a signed-in route answering 401, 403 or 404, or sending the role
 *    to another page (not one under it), means the role cannot open it (a
 *    skip, with the reason);
 *  - a signed-out route (marketing, auth, the portal) opens for everyone:
 *    any 4xx there is a failure too;
 *  - every look loop names what it measured, and a loop that measured
 *    nothing (or not the glass looks on a glass build) fails.
 */

export type VisitOutcome =
  { kind: 'drawn' } | { kind: 'no-access'; reason: string } | { kind: 'failure'; reason: string };

/** Statuses that mean "this role may not open this page". */
export const NO_ACCESS_STATUSES: readonly number[] = [401, 403, 404];

/**
 * @param path        the path asked for
 * @param status      the final response's status (null: no response)
 * @param finalPath   the path the browser ended on (after redirects)
 * @param signedOut   true for a page every visitor may open (no session needed)
 */
export function visitOutcome(
  path: string,
  status: number | null,
  finalPath: string,
  signedOut: boolean,
): VisitOutcome {
  if (status === null) return { kind: 'failure', reason: `${path}: no response` };
  if (status >= 500) return { kind: 'failure', reason: `${path}: the server answered ${status}` };
  if (status >= 400) {
    if (!signedOut && NO_ACCESS_STATUSES.includes(status))
      return { kind: 'no-access', reason: `${path} answered ${status} for this role` };
    return { kind: 'failure', reason: `${path}: answered ${status}` };
  }
  if (!signedOut && !path.startsWith('/signin') && /^\/signin(\/|$)/u.test(finalPath))
    return { kind: 'failure', reason: `${path}: sent to ${finalPath} (the session was lost)` };
  // A role without the page is sent elsewhere (the dashboard): that page is measured on its own route.
  if (!signedOut && finalPath !== path && !finalPath.startsWith(`${path}/`))
    return { kind: 'no-access', reason: `${path} sent this role to ${finalPath}` };
  return { kind: 'drawn' };
}

/** The looks a loop must have measured: both Classic looks, and both glass looks on a glass build. */
export function requiredLooks(glass: boolean, classicToo = true): string[] {
  return [...(classicToo ? ['Dark', 'Light'] : []), ...(glass ? ['Day glass', 'Night glass'] : [])];
}

/** Problems with what a look loop measured (empty: enough was measured to judge). */
export function coverageProblems(
  where: string,
  measured: Iterable<string>,
  required: readonly string[],
): string[] {
  const have = new Set(measured);
  if (have.size === 0) return [`${where}: no look was measured`];
  return required.filter((l) => !have.has(l)).map((l) => `${where}: ${l} was not measured`);
}

/** The fewest Tab stops a keyboard walk must reach on a page before it may pass. */
export const MIN_TAB_STOPS = 3;
