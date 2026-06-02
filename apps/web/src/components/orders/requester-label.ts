import type { OrderRequestSummary } from '@/server/services/order-requests';

/**
 * Display label for an order's requester. PURE + server-safe — intentionally
 * NOT in `status-badge.tsx` (a `'use client'` module): the orders list page is
 * a Server Component that calls this directly, and a function exported from a
 * client module becomes a client reference that throws when invoked on the
 * server ("Attempted to call X() from the server but X is on the client").
 */
export function summaryRequesterLabel(r: OrderRequestSummary): string {
  if (r.requesterName) {
    return r.requesterOrgLabel
      ? `${r.requesterName} · ${r.requesterOrgLabel}`
      : r.requesterName;
  }
  if (r.requesterEmail) return r.requesterEmail;
  if (r.requesterUserId) return 'Team member';
  return 'External requester';
}
