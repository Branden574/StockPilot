/**
 * The remove-organization dialog's notices about orphan accounts it did not
 * delete (migration 0388, review R8). PURE and server-safe, so it is tested
 * without the client dialog.
 *
 *  - kept: the account was not deleted on purpose: a StockPilot platform
 *    admin's account while its email is on the allowlist (O-A3-7), or the
 *    rare record that could not be released (since 0393 every member's
 *    records are kept as "Deleted user", so this is not expected);
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
      ? `${r.keptUsers} account${r.keptUsers === 1 ? ' was' : 's were'} kept: ${
          r.keptUsers === 1 ? 'it belongs' : 'they belong'
        } to a StockPilot platform admin or ${
          r.keptUsers === 1 ? 'is' : 'are'
        } still linked to a record that could not be released. The error report has the details.`
      : null;
  const failed =
    r.failedUsers > 0
      ? `${r.failedUsers} account${r.failedUsers === 1 ? '' : 's'} could not be deleted right now and ${
          r.failedUsers === 1 ? 'was' : 'were'
        } left in place. The error report has the details.`
      : null;
  return { kept, failed };
}
