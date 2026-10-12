/**
 * Words for the restore row's SKU-change warning (Ungroup D1 b). A restore
 * point taken before restore points carried record ids matches records by SKU
 * and rack, so a record whose SKU was edited after it is re-created under its
 * old SKU with the stock it had then, and the record with the new SKU stays as
 * an extra. A record Ungroup split straight from its SKU at the point is
 * found through its split instead (PR stage, DATA-1), so it is not named; one
 * whose SKU was edited before its split is named (fix round 1, F2). Shown
 * before the typed RESTORE confirm.
 */
export interface RestoreSkuChangeLine {
  name: string | null;
  before: string | null;
  after: string | null;
  shared: boolean;
}

export const RESTORE_SKU_COPY = {
  checking: 'Checking whether any record changed SKU since this restore point…',
  failed:
    'Could not check whether any record changed SKU since this restore point. If one did, restoring it can add that record again under its old SKU.',
  /** PR stage, DATA-1 (2): the check reads the audit log, and this admin's
   *  view of it was revoked. Never an empty list read as an all-clear. */
  noAuditAccess:
    'Could not check whether any record changed SKU since this restore point: that check reads the audit log, which you cannot view. If one did, restoring it can add that record again under its old SKU.',
  /** PR stage fix round 1 (F3): the check reads at most SKU_CHANGES_SCAN
   *  audit rows, and the split rows it leaves out count against that limit.
   *  A check cut off at the limit that names nothing is never an all-clear. */
  cutOff:
    'Could not check every SKU change since this restore point: there are more than this check reads. If a record changed SKU, restoring it can add that record again under its old SKU.',
  heading: 'Some records changed SKU after this restore point was taken.',
  body: 'This restore point matches records by SKU and rack, so restoring it can add each of these records again under its old SKU, with the stock it had then, and keep the record with its new SKU as an extra.',
  advice: 'Check these records before you type RESTORE, or restore a newer point.',
  line: (c: RestoreSkuChangeLine): string =>
    `${c.name ?? 'A record you cannot see'}: ${c.before ?? 'no SKU'} to ${c.after ?? 'no SKU'}${
      c.shared ? ', with the records that shared it' : ''
    }`,
  /** With the check cut off at its limit, more may exist past it even when
   *  every record it read is named (PR stage fix round 1, F3). */
  more: (n: number, truncated: boolean): string =>
    truncated ? (n > 0 ? `and at least ${n} more` : 'and possibly more') : `and ${n} more`,
} as const;
