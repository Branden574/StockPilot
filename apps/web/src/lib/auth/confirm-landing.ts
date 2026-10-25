/**
 * Where an emailed confirmation link lands after /auth/confirm verifies it, by
 * the link's type (docket S14 review). Pure, so the route and its tests share
 * one list.
 *
 * WHY THE LINK DOES NOT CHOOSE. Any page can send a browser to /auth/confirm
 * with a link it holds for its own account (a reset link for its own address
 * is one form away) and with any `next` it likes. The person then presses the
 * button on the app's own page, so the post is same-origin and no Fetch
 * Metadata header can tell it from a real one. With `next` free, that page
 * also chose where its account opened in the person's browser: a new item, an
 * order, Billing, an integration to connect, anywhere they might type their
 * own data into an account someone else reads. Each type now lands where the
 * app's own emails and its sign-in tools send it, and any other `next` lands on
 * the type's first entry: never a page inside the account. (email_change
 * ignores `next` already: its destination is fixed in the route.)
 *
 * The landings, each held by confirm-landing.test.ts:
 *   recovery   /reset/complete  forgot password (lib/auth/password-reset-email.ts)
 *                               and the QA recovery link (api/admin/qa-recovery-link)
 *   invite     /reset/complete  a new organization's owner (server/actions/platform-admin.ts):
 *                               the account has no password yet
 *              /portal          a new portal customer (server/services/customers.ts)
 *   magiclink  /dashboard       the sign-in tools: the perf harness
 *                               (tests/perf/auth.setup.ts) and the QA and lab walks open
 *                               magic links minted through the admin API, and wait for the
 *                               dashboard (a walk that asks for a page inside it lands
 *                               here and goes on from there)
 *              /portal          an existing account invited to a portal (customers.ts)
 * The first entry is where any other `next` lands, so it is the type's home,
 * not a page inside the account. A new email or tool that needs another landing
 * adds it here, with its builder.
 */
export const CONFIRM_LANDINGS = {
  recovery: ['/reset/complete'],
  invite: ['/reset/complete', '/portal'],
  magiclink: ['/dashboard', '/portal'],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type ConfirmLandingType = keyof typeof CONFIRM_LANDINGS;

/** Where a type with no landings here goes (none today): the app's default, never `next`. */
export const CONFIRM_FALLBACK_LANDING = '/dashboard';

/**
 * The landing for a link of this type: `next` when it is one of the type's
 * landings, exactly; otherwise the type's first. A type this list does not
 * know (the route's allowlist grew without it) lands on the app's default and
 * never on `next`, rather than throwing.
 */
export function confirmLanding(type: string, next: string | null | undefined): string {
  if (!Object.hasOwn(CONFIRM_LANDINGS, type)) return CONFIRM_FALLBACK_LANDING;
  const landings: readonly string[] = CONFIRM_LANDINGS[type as ConfirmLandingType];
  return next != null && landings.includes(next) ? next : landings[0]!;
}
