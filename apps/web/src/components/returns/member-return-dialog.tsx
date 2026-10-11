'use client';

import { Loader2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { RequesterReturnSheetForm } from '@/components/returns/requester-return-sheet';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { readPublicOptionsResponse, readPublicSubmitResponse } from '@/lib/returns/requester-sheet';

import { requesterEntryLabel, RETURNS_COPY, type RequesterReturnSheet } from '@stockpilot/core';

type SheetState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; sheet: RequesterReturnSheet };

const SHEET_FAILED = 'The return form could not be loaded. Please try again.';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function isSheet(v: unknown): v is RequesterReturnSheet {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.exchangesEnabled === 'boolean' && Array.isArray(s.lines) && Array.isArray(s.tracking);
}

async function readSheet(orderId: string): Promise<SheetState> {
  try {
    const res = await fetch(`/api/v1/orders/${encodeURIComponent(orderId)}/return-request`, { cache: 'no-store' });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const m = data && typeof data === 'object' ? (data as Record<string, unknown>).message : null;
      return { status: 'failed', message: typeof m === 'string' && m.trim() ? m : SHEET_FAILED };
    }
    return isSheet(data) ? { status: 'ready', sheet: data } : { status: 'failed', message: SHEET_FAILED };
  } catch {
    return { status: 'failed', message: SHEET_FAILED };
  }
}

/**
 * A member's own "Return or exchange" on the web order page when the order
 * has no return token (returns RX-3 fix round 1, desk checks L6: 9 such
 * handed-over member orders in production at 0395, which had no web entry
 * while the phone's member routes served them). The same requester form as
 * the token page and the portal, over the member routes with the session
 * cookie, the phone's routes:
 *
 *   GET  /api/v1/orders/[id]/return-request          the sheet, read when opened
 *   POST /api/v1/orders/[id]/return-request/options  the sizes, no body, once
 *   POST /api/v1/orders/[id]/return-request          the request
 *
 * The order id in the path is the only input that names the order: no token
 * travels, the server serves the caller's own order only (the one 404
 * otherwise), every answer is no-store. An order WITH a token keeps its link
 * to the token page, as before.
 */
export function MemberReturnDialog({ orderId, exchangesEnabled }: { orderId: string; exchangesEnabled: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<SheetState>({ status: 'idle' });
  const base = `/api/v1/orders/${encodeURIComponent(orderId)}/return-request`;

  const load = React.useCallback(async () => {
    setState({ status: 'loading' });
    setState(await readSheet(orderId));
  }, [orderId]);

  // The server said the form is behind: read the sheet again in place (the
  // form stays, with its words) and refresh the page's requests.
  const readAgain = React.useCallback(async () => {
    router.refresh();
    const next = await readSheet(orderId);
    if (next.status === 'ready') setState(next);
  }, [orderId, router]);

  const label = requesterEntryLabel(state.status === 'ready' ? state.sheet.exchangesEnabled : exchangesEnabled);

  let body: React.ReactNode = null;
  if (state.status === 'loading' || state.status === 'idle') {
    body = (
      <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {RETURNS_COPY.requesterLoadingForm}
      </p>
    );
  } else if (state.status === 'failed') {
    body = (
      <div className="space-y-2">
        <p role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  } else if (state.sheet.lines.length === 0) {
    body = <p className="text-muted-foreground text-sm">{RETURNS_COPY.requesterNothingLeft}</p>;
  } else {
    body = (
      <RequesterReturnSheetForm
        lines={state.sheet.lines}
        exchangesEnabled={state.sheet.exchangesEnabled}
        idPrefix={`member-return-${orderId}`}
        density="inline"
        loadOptions={async () =>
          readPublicOptionsResponse(await fetch(`${base}/options`, { method: 'POST', cache: 'no-store' }))
        }
        submit={async (b) =>
          readPublicSubmitResponse(
            await fetch(base, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(b), cache: 'no-store' }),
          )
        }
        onSubmitted={(result) => {
          setOpen(false);
          setState({ status: 'idle' });
          const received = result.hasExchange
            ? RETURNS_COPY.requesterReceivedExchangeRequest
            : RETURNS_COPY.requesterReceivedReturnRequest;
          toast.success(result.returnNumber ? `${received} ${RETURNS_COPY.requesterReference(result.returnNumber)}` : received);
          router.refresh();
        }}
        onStale={() => void readAgain()}
        onCancel={() => setOpen(false)}
      />
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) void load();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
          {requesterEntryLabel(exchangesEnabled)}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            The warehouse reviews every request before anything happens. This order then lists it under{' '}
            {RETURNS_COPY.requesterYourRequests}.
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
