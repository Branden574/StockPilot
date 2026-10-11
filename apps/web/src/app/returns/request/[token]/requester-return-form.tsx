'use client';

import { CheckCircle2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { RequesterReturnSheetForm, type RequesterSubmitted } from '@/components/returns/requester-return-sheet';
import { readPublicOptionsResponse, readPublicSubmitResponse } from '@/lib/returns/requester-sheet';

import { RETURNS_COPY, type RequesterReturnableLine } from '@stockpilot/core';

interface RequesterReturnFormProps {
  /** The page's own token (the link the requester opened). */
  token: string;
  lines: RequesterReturnableLine[];
  exchangesEnabled: boolean;
  requesterName: string | null;
  /** The requester already has requests on this order (the tracking below). */
  hasRequests: boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/**
 * The token page's form (returns RX-3): the shared requester form over the
 * two public routes.
 *
 *   • The sizes: POST /api/v1/public/returns/options with the token in the
 *     BODY, never in a URL (the token stays out of URLs, logs and CDN keys),
 *     once, on the first Exchange.
 *   • The request: POST /api/v1/public/returns with the token, the honeypot
 *     and the key minted when the form opened.
 *
 * The server never trusts these values: it re-resolves the token, re-checks
 * every line against the durable budget and every replacement against the
 * line's own sizes. After a request it refreshes the page, so "Your requests
 * on this order" below shows it; the confirmation stays where the form was.
 */
export function RequesterReturnForm({ token, lines, exchangesEnabled, requesterName, hasRequests }: RequesterReturnFormProps) {
  const router = useRouter();
  const [hp, setHp] = React.useState('');
  const [submitted, setSubmitted] = React.useState<RequesterSubmitted | null>(null);
  // RX-3 fix round 1 (L5): the form is gone once the request is in, so focus
  // moves to the confirmation's heading instead of falling to the page.
  const doneHeading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (submitted) doneHeading.current?.focus();
  }, [submitted]);

  if (submitted) {
    const first = requesterName?.trim().split(/\s+/)[0];
    return (
      <div className="border-border bg-card rounded-2xl border p-6 text-center" role="status">
        <CheckCircle2 className="text-success mx-auto mb-3 h-6 w-6" aria-hidden />
        <h2 ref={doneHeading} tabIndex={-1} className="font-display text-lg outline-none">
          {submitted.hasExchange ? RETURNS_COPY.requesterReceivedExchangeRequest : RETURNS_COPY.requesterReceivedReturnRequest}
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          {first ? `Thanks, ${first}. ` : ''}
          {submitted.returnNumber ? (
            <>
              Your reference is <span className="text-foreground font-mono">{submitted.returnNumber}</span>.{' '}
            </>
          ) : null}
          The warehouse will review it. This page shows where it stands.
        </p>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="border-border bg-card rounded-2xl border p-6 text-center">
        <h2 className="font-display text-lg">Nothing left to return</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          {hasRequests
            ? 'Every item on this order is already returned or in one of your requests below. If you think this is a mistake, reach out to the warehouse directly.'
            : 'Every item on this order has already been returned, or this order has no returnable items. If you think this is a mistake, reach out to the warehouse directly.'}
        </p>
      </div>
    );
  }

  return (
    <RequesterReturnSheetForm
      lines={lines}
      exchangesEnabled={exchangesEnabled}
      idPrefix="return"
      density="page"
      honeypot={{ value: hp, onChange: setHp }}
      loadOptions={async () =>
        readPublicOptionsResponse(
          await fetch('/api/v1/public/returns/options', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ token }),
            cache: 'no-store',
          }),
        )
      }
      submit={async (body) =>
        readPublicSubmitResponse(
          await fetch('/api/v1/public/returns', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ token, ...body, hp }),
            cache: 'no-store',
          }),
        )
      }
      onSubmitted={(result) => {
        setSubmitted(result);
        router.refresh();
      }}
      // The server said the page is behind (RX-3 fix round 1, M4): read it
      // again; the form checks its choices against the lines it then gets.
      onStale={() => router.refresh()}
    />
  );
}
