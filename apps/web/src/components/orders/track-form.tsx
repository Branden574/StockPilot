'use client';

import { CheckCircle2, Circle, XCircle } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface TrackResult {
  id: string;
  status: string;
  requesterName: string | null;
  warehouseName: string | null;
  lines: Array<{
    itemName: string;
    quantityRequested: number;
    quantityFulfilled: number;
  }>;
  createdAt: string;
  approvedAt: string | null;
  packagingAt: string | null;
  readyAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  deniedReason: string | null;
  notes: string | null;
}

interface Props {
  initialToken: string;
  initialId: string;
  initialEmail: string;
}

const TIMELINE: Array<{
  key: keyof Pick<
    TrackResult,
    'createdAt' | 'approvedAt' | 'packagingAt' | 'readyAt' | 'deliveredAt'
  >;
  label: string;
}> = [
  { key: 'createdAt', label: 'Submitted' },
  { key: 'approvedAt', label: 'Approved' },
  { key: 'packagingAt', label: 'Packaging' },
  { key: 'readyAt', label: 'Ready' },
  { key: 'deliveredAt', label: 'Delivered' },
];

const STATUS_LABELS: Record<string, string> = {
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
  signature_requested: 'Awaiting signature',
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
    <div className="space-y-6">
      <form
        onSubmit={handleSubmit}
        className="border-border bg-card space-y-3 rounded-2xl border p-5"
      >
        <div>
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
        <div>
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
          <div>
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
            <p className="text-muted-foreground mt-1 text-xs">
              This is the long string at the end of the link your school /
              partner shared with you.
            </p>
          </div>
        ) : null}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Looking up…' : 'Find my order'}
        </Button>
      </form>

      {notFound ? (
        <div className="border-destructive/40 bg-destructive/5 text-destructive rounded-2xl border p-5 text-sm">
          We couldn&apos;t find that order. Double-check the email address
          and request ID from your confirmation email and try again.
        </div>
      ) : null}

      {result ? <TrackResultBlock result={result} /> : null}
    </div>
  );
}

function TrackResultBlock({ result }: { result: TrackResult }) {
  const statusLabel = STATUS_LABELS[result.status] ?? result.status;
  const isTerminalNegative =
    result.status === 'denied' || result.status === 'cancelled';

  return (
    <div className="space-y-5">
      <div className="border-border bg-card rounded-2xl border p-5">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
          Status
        </p>
        <h2 className="font-display mt-1 text-2xl">{statusLabel}</h2>
        {result.status === 'pending_confirmation' ? (
          <p className="text-muted-foreground mt-2 text-sm">
            Check your inbox (and spam folder) for a confirmation email from
            StockPilot. Until you click the link, your request stays on hold
            and no one on the team can see it.
          </p>
        ) : null}
        {result.warehouseName ? (
          <p className="text-muted-foreground mt-1 text-sm">
            Pickup: {result.warehouseName}
          </p>
        ) : null}
        {result.requesterName ? (
          <p className="text-muted-foreground mt-0.5 text-sm">
            Requester: {result.requesterName}
          </p>
        ) : null}

        {/* Timeline — only for non-terminal-negative paths and only
            once the requester has confirmed (pending_confirmation
            rows haven't "created" yet from the team's view). */}
        {!isTerminalNegative && result.status !== 'pending_confirmation' ? (
          <ol className="mt-5 space-y-3">
            {TIMELINE.map((step) => {
              const ts = result[step.key];
              const done = Boolean(ts);
              return (
                <li key={step.key} className="flex items-start gap-3 text-sm">
                  {done ? (
                    <CheckCircle2 className="text-primary mt-0.5 h-4 w-4" />
                  ) : (
                    <Circle className="text-muted-foreground/50 mt-0.5 h-4 w-4" />
                  )}
                  <div className="flex-1">
                    <div
                      className={cn(
                        'font-medium',
                        !done && 'text-muted-foreground',
                      )}
                    >
                      {step.label}
                    </div>
                    {ts ? (
                      <div className="text-muted-foreground text-xs">
                        {formatDate(ts)}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}

        {result.status === 'denied' ? (
          <div className="bg-destructive/5 border-destructive/40 mt-5 rounded-xl border p-4">
            <div className="text-destructive flex items-center gap-2 text-sm font-medium">
              <XCircle className="h-4 w-4" />
              Request denied
            </div>
            {result.deniedReason ? (
              <p className="text-muted-foreground mt-1 text-sm">
                Reason: {result.deniedReason}
              </p>
            ) : null}
          </div>
        ) : null}

        {result.status === 'cancelled' ? (
          <div className="text-muted-foreground mt-5 text-sm">
            This request was cancelled
            {result.cancelledAt ? ` on ${formatDate(result.cancelledAt)}` : ''}.
          </div>
        ) : null}
      </div>

      {/* Lines */}
      {result.lines.length > 0 ? (
        <div className="border-border bg-card rounded-2xl border p-5">
          <h3 className="font-display text-base">Items</h3>
          <ul className="divide-border mt-3 divide-y">
            {result.lines.map((l, i) => (
              <li
                key={i}
                className="flex items-baseline justify-between gap-4 py-2 text-sm"
              >
                <span className="flex-1 truncate">{l.itemName}</span>
                <span className="text-muted-foreground tabular-nums text-xs">
                  {l.quantityFulfilled > 0 ? (
                    <>
                      {l.quantityFulfilled} / {l.quantityRequested}
                    </>
                  ) : (
                    <>{l.quantityRequested} requested</>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.notes ? (
        <div className="border-border bg-card rounded-2xl border p-5">
          <h3 className="font-display text-base">Your notes</h3>
          <p className="text-muted-foreground mt-2 whitespace-pre-line text-sm">
            {result.notes}
          </p>
        </div>
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
