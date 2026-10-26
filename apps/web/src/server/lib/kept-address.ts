import 'server-only';

/**
 * MAY A KEPT ADDRESS STILL BE EMAILED? (B23)
 *
 * Some records keep a copy of the filer's email address (owner decision
 * O-A3-6: the address is part of the business record), and a later email
 * about the record goes to that copy, not to the live account:
 *   - a maintenance request keeps requester_email_snapshot, and the
 *     resolution email (server/email/maintenance-resolved.ts) goes there;
 *   - a support ticket keeps email, and the "resolved" notice
 *     (server/services/support-tickets.ts) goes there.
 * Since migration 0393 every member can delete their account, and a person
 * who deleted their account is never emailed again (A3). So each of these
 * senders asks the functions below first. Orders answer the same question
 * from their own marker, order_requests.requester_deleted_at (0388), in
 * ./requester-contact.ts.
 *
 * WHY A NULL OWNER MEANS A DELETED ACCOUNT. Neither table has a deletion
 * marker yet, so the answer is inferred from the owner columns, which only an
 * account deletion empties:
 *   - maintenance_requests.requester_user_id: every request is filed with the
 *     filer's id, whether from the request form or from an exception
 *     escalation (both go through MaintenanceRequestsService.create). The
 *     0314 insert policy requires it to be the caller, 0362 refuses any later
 *     change of it, and its foreign key to auth.users is ON DELETE SET NULL.
 *     A request with no requester is a deleted member's.
 *   - support_tickets.organization_id and submitted_by: a ticket filed in the
 *     app (the dashboard, the phone) names both, and a ticket from the public
 *     support page names neither; supportTicketOwner below refuses anything
 *     else at the one insert. submitted_by's foreign key to user_profiles is
 *     ON DELETE SET NULL. A ticket that names an organization and nobody is a
 *     deleted member's.
 * kept-address.guard.test.ts pins this: it finds every insert path for both
 * tables (TypeScript, and the SQL functions in supabase/migrations) and every
 * write of their owner columns, and fails on one it has not been told about.
 *
 * WHICH WAY IT FAILS. Toward sending nothing, the private direction: a row
 * read without its owner columns counts as a deleted member's. The one gap
 * it cannot close: a deleted member's ticket whose organization was deleted
 * too names neither and reads as a public ticket, so its kept address is
 * still emailed. One path reaches it today: the platform console's
 * organization delete with "also delete orphaned users" (deleteOrganization
 * in server/actions/platform-admin.ts) deletes the organization first, which
 * empties organization_id, and then each orphaned account, which empties
 * submitted_by. No other column of a ticket says reliably that it was filed
 * in the app, so nothing here guesses; the marker below closes the gap.
 *
 * WHAT REPLACES IT. Explicit markers, set in the database by the account
 * deletion's own trigger before the foreign keys empty the owner columns, so
 * every deletion path sets them (the app, the phone, the platform console,
 * the Supabase dashboard) and an organization delete cannot erase them
 * (maintenance_requests.requester_deleted_at and
 * support_tickets.submitter_deleted_at, designed in the B23 pull request for
 * the next database batch). These functions switch to them in that same
 * change, which also closes the gap above. Rentals keep
 * a borrower's address too (borrower_email), but a borrower without an
 * account has no borrower_user_id either, so nothing can be inferred there:
 * its marker (rentals.borrower_deleted_at) is in the same design. Until then,
 * when a member who borrowed something deletes their account, the overdue
 * reminders and the returned email (lib/email/rentals.ts) still go to the
 * address kept on the rental.
 */

/** The maintenance_requests column the answer reads. */
export interface MaintenanceRequesterColumns {
  requester_user_id?: string | null;
}

/**
 * Whether the member who filed this maintenance request deleted their
 * account. A row read without requester_user_id counts as deleted.
 */
export function maintenanceRequesterAccountDeleted(row: MaintenanceRequesterColumns): boolean {
  return typeof row.requester_user_id !== 'string' || row.requester_user_id.length === 0;
}

/** The support_tickets columns the answer reads. */
export interface SupportTicketOwnerColumns {
  organization_id?: string | null;
  submitted_by?: string | null;
}

/**
 * Whether the member who filed this support ticket in the app deleted their
 * account. A public ticket names neither column and is nobody's account. A
 * row read without both columns counts as deleted.
 */
export function supportTicketSubmitterAccountDeleted(row: SupportTicketOwnerColumns): boolean {
  if (row.organization_id === undefined || row.submitted_by === undefined) return true;
  return row.organization_id !== null && row.submitted_by === null;
}

/**
 * The owner columns of a NEW support ticket: both named (a member filed it in
 * the app) or neither (the public support page). Half an owner is refused: it
 * would read as a deleted member's ticket, and the person who filed it would
 * never get the resolved notice.
 */
export function supportTicketOwner(input: {
  organizationId?: string | null;
  submittedBy?: string | null;
}): { organization_id: string | null; submitted_by: string | null } {
  const organizationId = input.organizationId ?? null;
  const submittedBy = input.submittedBy ?? null;
  if (organizationId === null && submittedBy === null) {
    return { organization_id: null, submitted_by: null };
  }
  if (organizationId && submittedBy) {
    return { organization_id: organizationId, submitted_by: submittedBy };
  }
  throw new Error(
    'A support ticket names both the organization and the member who filed it, or neither.',
  );
}
