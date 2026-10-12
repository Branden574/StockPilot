/**
 * Words for the restore row's SKU-change warning (Ungroup D1 b). A restore
 * point taken before restore points carried record ids matches records by SKU
 * and rack, so a record whose SKU changed after it (an Ungroup, or a SKU edit)
 * is re-created under its old SKU with the stock it had then, and the record
 * with the new SKU stays as an extra. Shown before the typed RESTORE confirm.
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
  heading: 'Some records changed SKU after this restore point was taken.',
  body: 'This restore point matches records by SKU and rack, so restoring it can add each of these records again under its old SKU, with the stock it had then, and keep the record with its new SKU as an extra.',
  advice: 'Check these records before you type RESTORE, or restore a newer point.',
  line: (c: RestoreSkuChangeLine): string =>
    `${c.name ?? 'A record you cannot see'}: ${c.before ?? 'no SKU'} to ${c.after ?? 'no SKU'}${
      c.shared ? ', with the records that shared it' : ''
    }`,
  more: (n: number, truncated: boolean): string =>
    truncated ? `and at least ${n} more` : `and ${n} more`,
} as const;
