/**
 * THE BORROWER ON A RENTAL: anyone, with or without a StockPilot account.
 *
 * A rental keeps its borrower on the rental itself: `borrower_name` (required),
 * `borrower_email` (optional), and `borrower_user_id` only when the borrower is
 * a team member. Someone from a site who has no login is an ordinary borrower:
 * a name, and an email when there is one.
 *
 * Whatever address is on the rental is where the rental emails go
 * (apps/web/src/lib/email/rentals.ts):
 *   • the checkout receipt, right after checkout;
 *   • the return confirmation, when the rental is marked returned;
 *   • one overdue reminder, from the daily sweep (cron/rental-overdue) once
 *     the expected return date has passed and the rental is still out.
 * No address, no emails. There is no reminder BEFORE the return date.
 *
 * The overdue reminder has one more condition. The sweep is automation that
 * writes to people outside the organization, so it runs only for
 * organizations whose own Rentals switch in Settings > Modules is on (the
 * explicit organization_modules row), never because of the all-modules comp
 * (lib/modules/effective-modules.ts). A comped organization can create
 * rentals with that switch off, and its borrowers then get the receipt and
 * the confirmation but no reminder. The sentence below says so, so it is true
 * for every organization that can open this form.
 *
 * Web and phone say this in the same words, so the copy lives here. If the
 * emails above change, change this sentence with them.
 *
 * What a rental's detail and list pages say about these emails afterwards
 * (sent, when, or why not) lives in ./emails.ts, which shares its overdue rule
 * with the sweep itself.
 */
export const RENTAL_BORROWER_EMAIL_HELP =
  'If you add an email, they get the checkout receipt, the return confirmation, and, while Rentals is switched on in Settings > Modules, a reminder if the rental is overdue.';

/**
 * The web form's check before it submits: text@text.text with no spaces. It is
 * a typing check only; the server's schema (createRentalSchema, zod `.email()`)
 * decides. An empty email is allowed (the email is optional) and is not
 * checked here.
 */
export function isBorrowerEmailFormat(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
