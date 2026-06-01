'use client';

import {
  Check,
  CheckCircle2,
  ExternalLink,
  FileDown,
  Loader2,
  PackageCheck,
  Truck,
  X,
  XCircle,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/utils';
import {
  approveReturnAction,
  buyReturnLabelAction,
  cancelReturnAction,
  closeReturnAction,
  denyReturnAction,
  receiveReturnAction,
} from '@/server/actions/returns';

import type { ReturnStatus } from '@/server/services/returns';

/** The subset of the return label (carrier_shipments) the panel renders. */
interface ReturnLabel {
  status: string;
  carrier: string | null;
  service: string | null;
  rate_cents: number | null;
  currency: string | null;
  tracking_code: string | null;
  tracking_url: string | null;
  label_url: string | null;
}

interface Props {
  returnId: string;
  status: ReturnStatus;
  /**
   * True when the shipping module is enabled AND the viewer holds
   * shipping:manage — only then is the "Buy return label" affordance shown.
   */
  canManageShipping?: boolean;
  /** The already-purchased reverse label, if one exists. */
  returnLabel?: ReturnLabel | null;
}

type BusyKey = 'approve' | 'deny' | 'receive' | 'close' | 'cancel' | 'returnLabel' | null;

const TERMINAL: ReturnStatus[] = ['closed', 'denied', 'cancelled'];

/** Statuses at which a reverse label can be bought. */
const LABELABLE: ReturnStatus[] = ['approved', 'received'];

export function ReturnActionsPanel({
  returnId,
  status,
  canManageShipping = false,
  returnLabel = null,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<BusyKey>(null);
  const [denyOpen, setDenyOpen] = React.useState(false);
  const [denyReason, setDenyReason] = React.useState('');

  async function run(
    key: Exclude<BusyKey, null>,
    fn: () => Promise<{ ok: boolean; error?: { message: string } }>,
    successMessage: string,
  ) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error?.message ?? 'Something went wrong.');
      return false;
    }
    toast.success(successMessage);
    router.refresh();
    return true;
  }

  async function approve() {
    await run('approve', () => approveReturnAction(returnId), 'Return approved.');
  }

  async function deny() {
    const reason = denyReason.trim();
    if (!reason) {
      toast.error('Enter a reason before denying.');
      return;
    }
    const ok = await run(
      'deny',
      () => denyReturnAction({ id: returnId, reason }),
      'Return denied.',
    );
    if (ok) {
      setDenyOpen(false);
      setDenyReason('');
    }
  }

  async function receive() {
    await run('receive', () => receiveReturnAction(returnId), 'Return marked received.');
  }

  async function close() {
    await run(
      'close',
      () => closeReturnAction(returnId),
      'Return closed — disposition applied to inventory.',
    );
  }

  async function cancel() {
    await run('cancel', () => cancelReturnAction(returnId), 'Return cancelled.');
  }

  async function buyReturnLabel() {
    await run(
      'returnLabel',
      () => buyReturnLabelAction(returnId),
      'Return label purchased.',
    );
  }

  const showLabelSection =
    canManageShipping && (LABELABLE.includes(status) || returnLabel !== null);

  return (
    <section className="bg-card rounded-xl border">
      <div className="border-border border-b px-4 py-3">
        <h2 className="text-sm font-medium">Return actions</h2>
        <p className="text-muted-foreground mt-0.5 text-[11.5px]">
          Move this return through its lifecycle. Closing a received return
          restocks or scraps each line.
        </p>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap gap-2">
          {status === 'requested' && (
            <>
              <Button variant="gradient" onClick={approve} disabled={busy !== null}>
                {busy === 'approve' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Approve
              </Button>
              <Button
                variant="destructive"
                onClick={() => setDenyOpen(true)}
                disabled={busy !== null}
              >
                <X className="h-3.5 w-3.5" />
                Deny
              </Button>
              <Button variant="outline" onClick={cancel} disabled={busy !== null}>
                {busy === 'cancel' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <XCircle className="h-3.5 w-3.5" />
                )}
                Cancel
              </Button>
            </>
          )}

          {status === 'approved' && (
            <>
              <Button variant="gradient" onClick={receive} disabled={busy !== null}>
                {busy === 'receive' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PackageCheck className="h-3.5 w-3.5" />
                )}
                Mark received
              </Button>
              <Button variant="outline" onClick={cancel} disabled={busy !== null}>
                {busy === 'cancel' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <XCircle className="h-3.5 w-3.5" />
                )}
                Cancel
              </Button>
            </>
          )}

          {status === 'received' && (
            <Button variant="gradient" onClick={close} disabled={busy !== null}>
              {busy === 'close' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              Close & apply disposition
            </Button>
          )}

          {TERMINAL.includes(status) && !showLabelSection && (
            <div className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <CheckCircle2 className="h-3.5 w-3.5" />
              No further actions — this return is in a terminal state.
            </div>
          )}
        </div>

        {/* Reverse-label section: buy/show the RMA return label. Gated on the
            shipping module + shipping:manage (resolved server-side). */}
        {showLabelSection && (
          <div className="border-border space-y-3 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Return label</h3>
                <p className="text-muted-foreground mt-0.5 text-[11.5px]">
                  A reverse carrier label so the item ships back to your
                  warehouse.
                </p>
              </div>
              {!returnLabel && LABELABLE.includes(status) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={buyReturnLabel}
                  disabled={busy !== null}
                >
                  {busy === 'returnLabel' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Truck className="h-3.5 w-3.5" />
                  )}
                  Buy return label
                </Button>
              )}
            </div>

            {returnLabel ? (
              <dl className="space-y-2 text-[12px]">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Carrier</dt>
                  <dd className="text-right">
                    {returnLabel.carrier ?? '—'}
                    {returnLabel.service ? (
                      <span className="text-muted-foreground"> · {returnLabel.service}</span>
                    ) : null}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Tracking #</dt>
                  <dd className="text-right font-mono">
                    {returnLabel.tracking_url && returnLabel.tracking_code ? (
                      <a
                        href={returnLabel.tracking_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 hover:underline"
                      >
                        {returnLabel.tracking_code}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      (returnLabel.tracking_code ?? '—')
                    )}
                  </dd>
                </div>
                {returnLabel.rate_cents != null && (
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Cost</dt>
                    <dd className="text-right tabular-nums">
                      {formatCurrency(
                        returnLabel.rate_cents / 100,
                        returnLabel.currency ?? 'USD',
                      )}
                    </dd>
                  </div>
                )}
                {returnLabel.label_url && (
                  <div className="pt-1">
                    <Button variant="outline" size="sm" asChild>
                      <a href={returnLabel.label_url} target="_blank" rel="noopener noreferrer">
                        <FileDown className="h-3.5 w-3.5" />
                        Download return label
                      </a>
                    </Button>
                  </div>
                )}
              </dl>
            ) : (
              !LABELABLE.includes(status) && (
                <Badge variant="outline" className="text-muted-foreground">
                  No return label.
                </Badge>
              )
            )}
          </div>
        )}
      </div>

      {/* Deny-reason dialog */}
      <Dialog
        open={denyOpen}
        onOpenChange={(v) => {
          if (busy === 'deny') return;
          setDenyOpen(v);
          if (!v) setDenyReason('');
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Deny this return?</DialogTitle>
            <DialogDescription>
              No inventory will move. This action can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="return-deny-reason">Reason</Label>
            <Textarea
              id="return-deny-reason"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Brief explanation"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDenyOpen(false)}
              disabled={busy === 'deny'}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={deny}
              disabled={busy === 'deny' || !denyReason.trim()}
            >
              {busy === 'deny' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Deny return
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
