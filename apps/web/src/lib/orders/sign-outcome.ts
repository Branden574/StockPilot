/**
 * What the public sign page says once a signature is recorded (L87). The sign
 * route answers the status the hand-over left the order in:
 *   - completed: everything owed was handed over;
 *   - backordered: units are still owed (the 0244 fork), so the order is NOT
 *     completed and no completion receipt goes out;
 *   - null: the status could not be read after the signature was recorded,
 *     so nothing beyond the signature is claimed.
 * `receiptOnItsWay` is true only where the route always emails the signer a
 * receipt (the completed path). `redirectTo` is the orders list the countdown
 * lands on.
 */
export interface SignedOutcome {
  message: string;
  receiptOnItsWay: boolean;
  redirectTo: string;
}

export function signedOutcome(status: string | null): SignedOutcome {
  if (status === 'completed') {
    return {
      message: 'The order is marked completed.',
      receiptOnItsWay: true,
      redirectTo: '/dashboard/orders?status=completed',
    };
  }
  if (status === 'backordered') {
    return {
      message: 'What was handed over is recorded. The rest stays on backorder.',
      receiptOnItsWay: false,
      redirectTo: '/dashboard/orders?status=backordered',
    };
  }
  return {
    message: 'Your signature is recorded.',
    receiptOnItsWay: false,
    redirectTo: '/dashboard/orders?status=all_active',
  };
}
