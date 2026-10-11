import Link from 'next/link';

import type { OrderReplacementInfo } from '@/server/services/order-replacement';

import { formatOrderNumber, replacementBannerLines } from '@stockpilot/core';

/**
 * The exchange replacement order's banner (returns RX-2, plan 3.6.9):
 * "Exchange replacement for RMA-… · Original order SO-…" (the RMA a link
 * only for holders of returns:read or returns:manage), then core's lines
 * (replacementBannerLines, the phone's rule too): while it is still to be
 * handed over, the return-first gate in words, an RMA cancelled under it, who
 * released it early and why (the reason only for those who read the RMA),
 * the driver's line for an early-released delivery (never to the requester)
 * and where its items change, for who is reading (review fix P9): the RMA
 * link alone for someone who can open it, who to ask for the requester, who
 * can for anyone else; once it was handed over, how the exchange ended (part
 * never sent included) and the early release as history. Rendered for an
 * ordinary order: nothing.
 */
export function ReplacementBanner({
  replacement,
  fulfillmentType,
  isRequester = false,
}: {
  replacement: OrderReplacementInfo | null | undefined;
  fulfillmentType: 'pickup' | 'delivery';
  /** The viewer placed this order (the replacement's requester). */
  isRequester?: boolean;
}) {
  if (!replacement) return null;
  const rma = replacement.returnNumber ?? 'its RMA';
  const so = formatOrderNumber(replacement.originalOrderNumber);
  const lines = replacementBannerLines(replacement, fulfillmentType, {
    canOpenRma: replacement.canOpenReturn,
    isRequester,
  });
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
          case 'rma_link':
            // Someone who can open the RMA: the link alone says where.
            return (
              <p key="rma_link" className="text-xs">
                <Link href={`/dashboard/returns/${replacement.returnId}`} className="text-foreground hover:underline">
                  {line.text}
                </Link>
              </p>
            );
          case 'change':
            return (
              <p key="change" className="text-muted-foreground text-xs">
                {line.text}
              </p>
            );
        }
      })}
    </section>
  );
}
