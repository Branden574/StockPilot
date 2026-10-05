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

/**
 * What a used sign link says (L87, found again in the test-stage walk). The
 * page's "already signed" panel said "looks like this order was already
 * completed. Check your inbox for the confirmation email." for every status,
 * so after a short hand-over it claimed a completion and an email that never
 * happen. Its words now follow the status the hand-over left, as the
 * thank-you panel's do. Only a token that resolves reaches this panel, and its
 * holder signed or is a member, so the status is nothing they could not see.
 */
export function alreadySignedMessage(status: string | null): string {
  if (status === 'completed') {
    return 'Thanks — looks like this order was already completed. Check your inbox for the confirmation email.';
  }
  return `Thanks. ${signedOutcome(status).message}`;
}
