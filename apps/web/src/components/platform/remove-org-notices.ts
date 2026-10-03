/**
 * The remove-organization dialog's notices about orphan accounts it did not
 * delete (migration 0388, review R8). PURE and server-safe, so it is tested
 * without the client dialog.
 *
 *  - kept: the database refused the delete because the account is linked to
 *    records that must be kept (a permanent business refusal);
 *  - failed: the check could not answer or the delete failed (a row lock, a
 *    fault); the account was left in place and the error report has the
 *    details. Never called "linked to records".
 */
export function orphanAccountNotices(r: { keptUsers: number; failedUsers: number }): {
  kept: string | null;
  failed: string | null;
} {
  const kept =
    r.keptUsers > 0
      ? `${r.keptUsers} account${r.keptUsers === 1 ? ' was' : 's were'} kept because ${
          r.keptUsers === 1 ? 'it is' : 'they are'
        } linked to records that must be kept.`
      : null;
  const failed =
    r.failedUsers > 0
      ? `${r.failedUsers} account${r.failedUsers === 1 ? '' : 's'} could not be deleted right now and ${
          r.failedUsers === 1 ? 'was' : 'were'
        } left in place. The error report has the details.`
      : null;
  return { kept, failed };
}
