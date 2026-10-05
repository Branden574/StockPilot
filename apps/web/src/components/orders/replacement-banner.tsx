import Link from 'next/link';

import type { OrderReplacementInfo } from '@/server/services/order-replacement';

import {
  changeOrCancelInRmaLabel,
  exchangeReplacementBanner,
  formatOrderNumber,
  releasedBeforeReturnLine,
  returnCancelledReplacementLine,
  RETURNS_COPY,
  waitingForReturnLine,
} from '@stockpilot/core';

/**
 * The exchange replacement order's banner (returns RX-2, plan 3.6.9):
 * "Exchange replacement for RMA-… · Original order SO-…" (the RMA a link
 * only for holders of returns:read or returns:manage), the return-first gate
 * in words while it holds, who released it early and why (the reason only for
 * those who read the RMA), and that its items change only in the RMA.
 * Rendered for an ordinary order: nothing.
 */
export function ReplacementBanner({
  replacement,
  fulfillmentType,
}: {
  replacement: OrderReplacementInfo | null | undefined;
  fulfillmentType: 'pickup' | 'delivery';
}) {
  if (!replacement) return null;
  const rma = replacement.returnNumber ?? 'its RMA';
  const so = formatOrderNumber(replacement.originalOrderNumber);
  return (
    <section
      className="bg-card border-l-primary mb-4 space-y-1.5 rounded-xl border border-l-4 p-4 text-sm"
      aria-label="Exchange replacement"
      data-testid="replacement-banner"
    >
      {/* Core's sentence (exchangeReplacementBanner), with the two handles
          linked; the test pins that the text reads exactly as core builds it. */}
      <p className="font-medium" data-testid="replacement-banner-title" data-words={exchangeReplacementBanner(replacement.returnNumber, replacement.originalOrderNumber)}>
        Exchange replacement for{' '}
        {replacement.canOpenReturn ? (
          <Link href={`/dashboard/returns/${replacement.returnId}`} className="hover:underline">
            {rma}
          </Link>
        ) : (
          rma
        )}
        {so ? (
          <>
            {' · Original order '}
            {replacement.originalOrderId ? (
              <Link href={`/dashboard/orders/${replacement.originalOrderId}`} className="hover:underline">
                {so}
              </Link>
            ) : (
              so
            )}
          </>
        ) : null}
      </p>
      {replacement.live && replacement.waitingForReturn ? (
        <p className="text-muted-foreground" role="status">
          {waitingForReturnLine(replacement.returnNumber)}
        </p>
      ) : null}
      {replacement.live && replacement.returnClosed ? (
        <p className="text-muted-foreground" role="status" data-testid="replacement-return-closed">
          {returnCancelledReplacementLine(replacement.returnNumber)}
        </p>
      ) : null}
      {replacement.releasedEarly ? (
        <p className="text-muted-foreground">
          {releasedBeforeReturnLine(replacement.release?.byName ?? null, replacement.release?.reason ?? null)}
        </p>
      ) : null}
      {replacement.live && fulfillmentType === 'delivery' && replacement.driverLine ? (
        <p className="text-muted-foreground">{replacement.driverLine}</p>
      ) : null}
      {replacement.live ? (
        <p className="text-muted-foreground text-xs">
          {RETURNS_COPY.changeOrCancelHere}{' '}
          {replacement.canOpenReturn ? (
            <Link href={`/dashboard/returns/${replacement.returnId}`} className="text-foreground hover:underline">
              {changeOrCancelInRmaLabel(replacement.returnNumber)}
            </Link>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
