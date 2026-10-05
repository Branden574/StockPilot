import Link from 'next/link';

import type { OrderReplacementInfo } from '@/server/services/order-replacement';

import { changeOrCancelInRmaLabel, formatOrderNumber, replacementBannerLines } from '@stockpilot/core';

/**
 * The exchange replacement order's banner (returns RX-2, plan 3.6.9):
 * "Exchange replacement for RMA-… · Original order SO-…" (the RMA a link
 * only for holders of returns:read or returns:manage), then core's lines
 * (replacementBannerLines, the phone's rule too): while it is still to be
 * handed over, the return-first gate in words, an RMA cancelled under it, who
 * released it early and why (the reason only for those who read the RMA),
 * the driver's line and that its items change only in the RMA; once it was
 * handed over, how the exchange ended (part never sent included) and the
 * early release as history. Rendered for an ordinary order: nothing.
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
  const lines = replacementBannerLines(replacement, fulfillmentType);
  return (
    <section
      className="bg-card border-l-primary mb-4 space-y-1.5 rounded-xl border border-l-4 p-4 text-sm"
      aria-label="Exchange replacement"
      data-testid="replacement-banner"
    >
      {lines.map((line) => {
        switch (line.key) {
          case 'title':
            // Core's sentence with the two handles linked; the test pins that
            // the text reads exactly as core builds it.
            return (
              <p key="title" className="font-medium" data-testid="replacement-banner-title" data-words={line.text}>
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
            );
          case 'handed_over':
            return (
              <p key="handed_over" className="text-muted-foreground" role="status" data-testid="replacement-handed-over">
                {line.text}
              </p>
            );
          case 'gate':
            return (
              <p key="gate" className="text-muted-foreground" role="status">
                {line.text}
              </p>
            );
          case 'closed':
            return (
              <p key="closed" className="text-muted-foreground" role="status" data-testid="replacement-return-closed">
                {line.text}
              </p>
            );
          case 'released':
          case 'driver':
            return (
              <p key={line.key} className="text-muted-foreground">
                {line.text}
              </p>
            );
          case 'change':
            return (
              <p key="change" className="text-muted-foreground text-xs">
                {line.text}{' '}
                {replacement.canOpenReturn ? (
                  <Link href={`/dashboard/returns/${replacement.returnId}`} className="text-foreground hover:underline">
                    {changeOrCancelInRmaLabel(replacement.returnNumber)}
                  </Link>
                ) : null}
              </p>
            );
        }
      })}
    </section>
  );
}
