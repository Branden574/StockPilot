/**
 * The status mark after a record's name: ' (archived)', ' (inactive)', or
 * nothing. One copy for every label core builds from a record that can be
 * archived or made inactive: the Book Order Totals report's warehouse and
 * charter options, and a purchase order's bill-to charter (B56) on the web
 * page and the phone. Any other status, or none, marks nothing.
 *
 * Pure: no I/O, no platform API.
 */
export function recordStatusSuffix(status: string | null | undefined): string {
  if (status === 'archived') return ' (archived)';
  if (status === 'inactive') return ' (inactive)';
  return '';
}
