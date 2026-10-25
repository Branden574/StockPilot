'use client';

import { CheckCircle2, Circle, XCircle } from 'lucide-react';
import { useState } from 'react';

import { ExternalCard, ExternalEyebrow } from '@/components/auth/external-shell';
import { DeliveryMap } from '@/components/orders/delivery-map';
import { Timeline, TimelineEntry } from '@/components/patterns/timeline';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { orderStatusLabelForFulfillment, returnedFragment } from '@stockpilot/core';
import { cn } from '@/lib/utils';

interface TrackResult {
  id: string;
  status: string;
  requesterName: string | null;
  warehouseName: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  lines: Array<{
    itemName: string;
    quantityRequested: number;
    quantityFulfilled: number;
    /** Units the requester sent back on a closed return; absent on older
     *  responses. Shown beside fulfilled, never folded into it. */
    returnedQuantity?: number;
  }>;
  createdAt: string;
  approvedAt: string | null;
  packingSlipGeneratedAt: string | null;
  stagedAt: string | null;
  inTransitAt: string | null;
  signedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  deniedReason: string | null;
  notes: string | null;
  /** Self-service return-portal path (`/returns/request/<token>`) — present
   *  only on a completed order with fulfilled items whose org has the
   *  returns module enabled. */
  returnPath?: string | null;
}

interface Props {
  initialToken: string;
  initialId: string;
  initialEmail: string;
}

type TrackStepKey = keyof Pick<
  TrackResult,
  | 'createdAt'
  | 'approvedAt'
  | 'packingSlipGeneratedAt'
  | 'stagedAt'
  | 'inTransitAt'
  | 'signedAt'
  | 'completedAt'
>;

/** The step for the signature (B22), in the packing slip's and the
 *  completion email's words for that moment. */
export const SIGNED_FOR_STEP_LABEL = 'Signed for';

/**
 * The steps this order goes through, each read from the timestamp the order
 * row records for it (B22). The page used one fixed list for every order, so
 * a pickup showed an In transit step it never takes and ended Delivered, and
 * the signature had no step although the read sends signedAt.
 *   - A pickup is collected at the counter: it is never in transit, and its
 *     last step is the completed status's word for a pickup, Handed over
 *     (core's orderStatusLabelForFulfillment, the rule the order page, the
 *     orders list and the phone use), so the status line and the last step
 *     always agree.
 *   - Signed for comes before the last step. Both signature paths, on screen
 *     and on paper, stamp signed_at at every hand-over, in full or in part,
 *     and completed_at only when nothing is still owed (0395
 *     confirm_order_signature and confirm_physical_signature), so a short
 *     hand-over shows Signed for done and the last step still to come.
 *   - An order completed with no signature (completed before signatures were
 *     recorded) has no Signed for step: it never happened and never will.
 */
export function trackSteps(
  result: Pick<TrackResult, 'fulfillmentType' | 'signedAt' | 'completedAt'>,
): Array<{ key: TrackStepKey; label: string }> {
  const steps: Array<{ key: TrackStepKey; label: string }> = [
    { key: 'createdAt', label: 'Submitted' },
    { key: 'approvedAt', label: 'Approved' },
    { key: 'packingSlipGeneratedAt', label: 'Packed' },
    { key: 'stagedAt', label: 'Staged' },
  ];
  if (result.fulfillmentType !== 'pickup') {
    steps.push({ key: 'inTransitAt', label: 'In transit' });
  }
  if (result.signedAt || !result.completedAt) {
    steps.push({ key: 'signedAt', label: SIGNED_FOR_STEP_LABEL });
  }
  steps.push({ key: 'completedAt', label: trackStatusLabel('completed', result.fulfillmentType) });
  return steps;
}

/** A status's words on this page, given the order's fulfilment: its own map
 *  below, with core's rule for a completed pickup (Handed over). */
export function trackStatusLabel(
  status: string,
  fulfillmentType: string | null | undefined,
): string {
  return orderStatusLabelForFulfillment(status, STATUS_LABELS[status] ?? status, fulfillmentType);
}

export const STATUS_LABELS: Record<string, string> = {
  pending_confirmation: 'Waiting for your confirmation',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  pick_slip_generated: 'Pick slip generated',
  picking_in_progress: 'Picking in progress',
  picking_complete: 'Picking complete',
  packing_slip_generated: 'Packaging',
  staged_for_pickup: 'Staged for pickup',
  staged_for_delivery: 'Ready for delivery',
  in_transit: 'In transit',
  // CONFLICTS D14: a short hand-over leaves the order backordered; the page
  // printed the raw key. The word is the app's own (ORDER_STATUS_META).
  backordered: 'Backordered',
  // A delivery's word. A completed pickup reads Handed over (trackStatusLabel).
  completed: 'Delivered',
  denied: 'Denied',
  cancelled: 'Cancelled',
};

export function TrackForm({ initialToken, initialId, initialEmail }: Props) {
  const [token, setToken] = useState(initialToken);
  const [id, setId] = useState(initialId);
  const [email, setEmail] = useState(initialEmail);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TrackResult | null>(null);
  const [notFound, setNotFound] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    if (!id.trim() || !email.trim() || !token.trim()) return;

    setLoading(true);
    setNotFound(false);
    setResult(null);
    try {
      const url = new URL(
        `/api/v1/public/order-requests/${encodeURIComponent(id.trim())}`,
        window.location.origin,
      );
      url.searchParams.set('email', email.trim());
      url.searchParams.set('token', token.trim());
      const res = await fetch(url.toString());
      if (res.status === 404 || !res.ok) {
        setNotFound(true);
        return;
      }
      const json = (await res.json()) as TrackResult;
      setResult(json);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <ExternalCard>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="track-id">Request ID</Label>
            <Input
              id="track-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="From your confirmation email"
              required
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="track-email">Email</Label>
            <Input
              id="track-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          {!initialToken ? (
            <div className="space-y-2">
              <Label htmlFor="track-token">Tracking link key</Label>
              <Input
                id="track-token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste the full link or just the key"
                required
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-muted-foreground text-xs">
                This is the long string at the end of the link your school /
                partner shared with you.
              </p>
            </div>
          ) : null}
          <Button type="submit" className="h-11 w-full" disabled={loading}>
            {loading ? 'Looking up…' : 'Find my order'}
          </Button>
        </form>
      </ExternalCard>

      {/* role="alert": a screen reader says the miss when the panel appears,
          after "Find my order" was pressed. */}
      {notFound ? (
        <div
          role="alert"
          className="bg-destructive-wash text-destructive rounded-lg border border-transparent p-[18px] text-[13.5px] leading-[20.25px]"
        >
          We couldn&apos;t find that order. Double-check the email address
          and request ID from your confirmation email and try again.
        </div>
      ) : null}

      {result ? <TrackResultBlock result={result} /> : null}

      {result?.status === 'in_transit' ? (
        <DeliveryMap orderId={id.trim()} token={token.trim()} email={email.trim()} />
      ) : null}
    </div>
  );
}

function TrackResultBlock({ result }: { result: TrackResult }) {
  const statusLabel = trackStatusLabel(result.status, result.fulfillmentType);
  const isTerminalNegative =
    result.status === 'denied' || result.status === 'cancelled';

  return (
    <div className="space-y-4">
      <ExternalCard>
        <ExternalEyebrow>Status</ExternalEyebrow>
        <h2 className="font-display text-foreground mt-1 text-[22px] font-medium leading-[1.25] tracking-[-0.02em]">
          {statusLabel}
        </h2>
        {result.status === 'pending_confirmation' ? (
          <p className="text-muted-foreground mt-2 text-[13.5px] leading-[20.25px]">
            Check your inbox (and spam folder) for a confirmation email from
            StockPilot. Until you click the link, your request stays on hold
            and no one on the team can see it.
          </p>
        ) : null}
        {result.warehouseName ? (
          <p className="text-muted-foreground mt-1 text-[13.5px]">
            {result.fulfillmentType === 'pickup' ? 'Pickup' : 'From'}:{' '}
            {result.warehouseName}
          </p>
        ) : null}
        {result.requesterName ? (
          <p className="text-muted-foreground mt-0.5 text-[13.5px]">
            Requester: {result.requesterName}
          </p>
        ) : null}

        {/* Timeline — only for non-terminal-negative paths and only
            once the requester has confirmed (pending_confirmation
            rows haven't "created" yet from the team's view). The steps
            follow the order's fulfilment (trackSteps). Done steps carry a
            check and ink words; open steps a hollow circle and quiet words,
            so the state never rests on colour alone. */}
        {!isTerminalNegative && result.status !== 'pending_confirmation' ? (
          <Timeline className="border-border mt-5 border-t pt-5">
            {trackSteps(result).map((step) => {
              const ts = result[step.key];
              const done = Boolean(ts);
              return (
                <TimelineEntry
                  key={step.key}
                  tone={done ? 'accent' : 'muted'}
                  icon={done ? <CheckCircle2 /> : <Circle />}
                  title={
                    <span className={cn('font-medium', !done && 'text-muted-foreground')}>
                      {step.label}
                    </span>
                  }
                  meta={ts ? formatDate(ts) : undefined}
                />
              );
            })}
          </Timeline>
        ) : null}

        {result.status === 'denied' ? (
          <div className="bg-destructive-wash mt-5 rounded-md p-4">
            <div className="text-destructive flex items-center gap-2 text-[13.5px] font-medium">
              <XCircle className="h-4 w-4" />
              Request denied
            </div>
            {result.deniedReason ? (
              <p className="text-foreground mt-1 text-[13.5px]">
                Reason: {result.deniedReason}
              </p>
            ) : null}
          </div>
        ) : null}

        {result.status === 'cancelled' ? (
          <div className="text-muted-foreground mt-5 text-[13.5px]">
            This request was cancelled
            {result.cancelledAt ? ` on ${formatDate(result.cancelledAt)}` : ''}.
          </div>
        ) : null}

        {/* Returns-access Unit A: a delivered order with fulfilled items
            links straight into the self-service return portal. The API only
            sends returnPath when the order is completed, something was
            fulfilled, and the org's returns module is on. */}
        {result.returnPath ? (
          <div className="border-border mt-5 border-t pt-4">
            <p className="text-muted-foreground text-[13.5px]">
              Need to send something back?
            </p>
            <Button asChild variant="outline" className="mt-2">
              <a href={result.returnPath}>Request a return</a>
            </Button>
          </div>
        ) : null}
      </ExternalCard>

      {/* Lines */}
      {result.lines.length > 0 ? (
        <ExternalCard title="Items" headingLevel={3}>
          <ul className="divide-border -my-2 divide-y">
            {result.lines.map((l, i) => (
              <li
                key={i}
                className="flex items-baseline justify-between gap-4 py-2 text-[13.5px]"
              >
                <span className="flex-1 truncate">{l.itemName}</span>
                {/* Mono for the figures only; the words stay in the body face. */}
                <span className="text-muted-foreground tabular-nums text-xs">
                  {l.quantityFulfilled > 0 ? (
                    <>
                      <span className="font-mono">
                        {l.quantityFulfilled} / {l.quantityRequested}
                      </span>
                      {returnedFragment(l.returnedQuantity) ? (
                        <> · {returnedFragment(l.returnedQuantity)}</>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="font-mono">{l.quantityRequested}</span> requested
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </ExternalCard>
      ) : null}

      {result.notes ? (
        <ExternalCard title="Your notes" headingLevel={3}>
          <p className="text-muted-foreground whitespace-pre-line text-[13.5px]">
            {result.notes}
          </p>
        </ExternalCard>
      ) : null}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
