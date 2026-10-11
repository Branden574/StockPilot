'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { RequesterReturnSheetForm, type RequesterSubmitted } from '@/components/returns/requester-return-sheet';
import { Button } from '@/components/ui/button';
import { readActionOptions, readActionSubmit } from '@/lib/returns/requester-sheet';
import { portalReturnOptionsAction, portalReturnSheetAction, requestPortalReturnAction } from '@/server/actions/portal';

import { requesterEntryLabel, RETURNS_COPY, type RequesterReturnSheet } from '@stockpilot/core';

type SheetState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; sheet: RequesterReturnSheet };

const SHEET_FAILED = 'The return form could not be loaded. Please try again.';

/**
 * The B2B portal's "Return or exchange" sheet for one of the customer's own
 * orders (returns RX-3): the same requester form as the token page, through
 * the portal's actions, which re-resolve the signed-in customer on every
 * call (a foreign order id is "not found").
 *
 * The sheet is loaded when it opens (portalReturnSheetAction: the returnable
 * lines with names, sizes and photos signed for these items only, the
 * portal's first image surface), the sizes on the first Exchange
 * (portalReturnOptionsAction: "Available" or "Not in stock right now", never
 * a count, D6), and the request goes through requestPortalReturnAction with
 * the key minted when the form opened.
 */
export function PortalReturnSheet({
  orderId,
  id,
  onDone,
  onCancel,
}: {
  orderId: string;
  /** The element id the order's toggle button controls. */
  id?: string;
  onDone: (result: RequesterSubmitted) => void;
  onCancel: () => void;
}) {
  const [state, setState] = React.useState<SheetState>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      let next: SheetState;
      try {
        const res = await portalReturnSheetAction(orderId);
        next = res.ok ? { status: 'ready', sheet: res.data } : { status: 'failed', message: res.error.message || SHEET_FAILED };
      } catch {
        next = { status: 'failed', message: SHEET_FAILED };
      }
      if (live) setState(next);
    })();
    return () => {
      live = false;
    };
  }, [orderId, attempt]);

  const shell = 'bg-muted/40 mt-3 space-y-3 rounded-lg border p-3';

  if (state.status === 'loading') {
    return (
      <div id={id} className={shell}>
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading the return form…
        </p>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div id={id} className={shell}>
        <p role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setState({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const { sheet } = state;
  const heading = requesterEntryLabel(sheet.exchangesEnabled);
  const headingId = `${id ?? `portal-return-${orderId}`}-heading`;
  return (
    <section id={id} className={shell} aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-medium">
        {heading}
      </h3>
      {sheet.lines.length === 0 ? (
        <>
          <p className="text-muted-foreground text-sm">{RETURNS_COPY.requesterNothingLeft}</p>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </>
      ) : (
        <RequesterReturnSheetForm
          lines={sheet.lines}
          exchangesEnabled={sheet.exchangesEnabled}
          idPrefix={`ret-${orderId}`}
          density="inline"
          loadOptions={async () => readActionOptions(await portalReturnOptionsAction(orderId))}
          submit={async (body) => readActionSubmit(await requestPortalReturnAction({ orderId, ...body }))}
          onSubmitted={onDone}
          onCancel={onCancel}
        />
      )}
    </section>
  );
}
