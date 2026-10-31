/**
 * A purchase order's status in words, as the web's PO badge says it
 * (apps/web/src/components/po/po-status-badge.tsx; po-status.test.ts holds the
 * two to the same word for every status).
 *
 * The PO screen's header used its own list of four and printed any other
 * status as stored, so a received or cancelled PO read "received" or
 * "cancelled" beside the supplier (docket B10).
 */
const PO_STATUS_WORDS: Readonly<Record<string, string>> = {
  draft: 'Draft',
  expected_inbound: 'Expected',
  ordered: 'Ordered',
  partially_received: 'Partial',
  received: 'Received',
  cancelled: 'Cancelled',
};

/**
 * The words for `status`. A status this build does not know yet is said in
 * words too ("on_hold" reads "On hold"), never as the stored key. Only the
 * table's own keys count: an inherited member such as "constructor" is not a
 * status.
 */
export function poStatusLabel(status: string | null | undefined): string {
  if (!status) return '';
  if (Object.prototype.hasOwnProperty.call(PO_STATUS_WORDS, status)) {
    return PO_STATUS_WORDS[status] ?? '';
  }
  const words = status.replace(/_+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}
