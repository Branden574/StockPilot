import { SHORTFALL_PO_PHONE_REVIEW_COPY } from '@stockpilot/core';

/**
 * A DRAFT PO ON THE PHONE IS READ-ONLY (F2-5).
 *
 * The phone's PO screen (app/po/[id].tsx) is the receiving screen: Scan,
 * a "Received now" field per line and Post receipt. Until F2-5 no draft
 * reached it (the Receive tab lists only receivable statuses). The draft
 * sheet now opens the drafts it created there, and a draft is not received:
 * the database refuses a receipt on it (0349, po_not_ordered), and editing
 * or ordering a draft on the phone is an existing gap (F2 plan section 7). So
 * for a draft the screen shows its lines and what was ordered, with core's
 * "Review and order this draft on the web.", and offers no Scan, no
 * quantities and no Post receipt. Every other status is unchanged.
 */
export function poIsReviewOnly(status: string | null | undefined): boolean {
  return status === 'draft';
}

/** What the screen says on a draft (core's words, the draft sheet's too). */
export const PO_DRAFT_REVIEW_COPY = SHORTFALL_PO_PHONE_REVIEW_COPY;
