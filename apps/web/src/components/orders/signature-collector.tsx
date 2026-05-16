'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { SignaturePad, type SignaturePadHandle } from '@/components/shipments/signature-pad';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { submitOrderSignatureAction } from '@/server/actions/order-signature';

import type { OrderSignSummary } from '@/app/orders/sign/[token]/page';

/**
 * Public signature surface for `/orders/sign/<token>`.
 *
 * Reuses the canvas-based `<SignaturePad>` from the shipment-signature
 * flow (imperative handle: `isEmpty`, `toDataURL`, `clear`) instead of
 * re-inlining a second canvas implementation. That component already
 * handles DPR scaling, pointer-capture across stroke edges, quadratic-
 * curve smoothing, ResizeObserver re-init on rotation, and replay-on-
 * resize so a half-drawn signature survives orientation changes.
 *
 * Form is intentionally tiny — name, email, signature, submit. No
 * react-hook-form ceremony; the signature pad is imperative-handle and
 * the two text fields are short enough that local state is clearer than
 * a resolver setup.
 */
export function SignatureCollector({
  token,
  summary,
}: {
  token: string;
  summary: OrderSignSummary;
}) {
  const router = useRouter();
  const padRef = React.useRef<SignaturePadHandle>(null);
  const [padEmpty, setPadEmpty] = React.useState(true);
  const [signerName, setSignerName] = React.useState(summary.requesterName ?? '');
  const [signerEmail, setSignerEmail] = React.useState(summary.requesterEmail ?? '');
  const [submitting, setSubmitting] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);

  async function submit() {
    if (!signerName.trim()) {
      toast.error('Enter the name of who is signing.');
      return;
    }
    if (!signerEmail.trim()) {
      toast.error('Enter an email so we can confirm delivery.');
      return;
    }
    const pad = padRef.current;
    if (!pad || pad.isEmpty()) {
      toast.error('Sign in the box above first.');
      return;
    }
    const dataUrl = pad.toDataURL();
    if (!dataUrl || !dataUrl.startsWith('data:image/png')) {
      toast.error("Couldn't capture the signature. Clear the box and sign again.");
      return;
    }
    setSubmitting(true);
    const res = await submitOrderSignatureAction({
      token,
      signerName: signerName.trim(),
      signerEmail: signerEmail.trim(),
      signatureDataUrl: dataUrl,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setSubmitted(true);
    router.refresh();
  }

  if (submitted) {
    return (
      <div className="border-border bg-card rounded-2xl border p-6 text-center">
        <h2 className="font-display text-xl">Thank you</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          The order is marked completed. A digital receipt is on its way to{' '}
          <span className="text-foreground font-medium">{signerEmail.trim()}</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="border-border bg-card space-y-2 rounded-2xl border p-4">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">
          Order summary
        </p>
        <p className="text-sm">
          {summary.lines.length} item{summary.lines.length === 1 ? '' : 's'} ·{' '}
          {summary.fulfillmentType === 'pickup' ? 'Pickup' : 'Delivery'} ·{' '}
          {summary.warehouseName ?? 'Warehouse'}
          {summary.charterName ? ` → ${summary.charterName}` : ''}
        </p>
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">Show items</summary>
          <ul className="mt-2 space-y-1">
            {summary.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="flex-1 truncate">{l.itemName}</span>
                <span className="tabular-nums">
                  {l.quantityPicked || l.quantityRequested}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      <section className="border-border bg-card space-y-3 rounded-2xl border p-4">
        <div className="space-y-2">
          <Label htmlFor="signer-name">Your name</Label>
          <Input
            id="signer-name"
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            placeholder="Full name"
            maxLength={120}
            autoComplete="name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="signer-email">Email</Label>
          <Input
            id="signer-email"
            type="email"
            value={signerEmail}
            onChange={(e) => setSignerEmail(e.target.value)}
            placeholder="you@example.com"
            maxLength={254}
            autoComplete="email"
            inputMode="email"
          />
        </div>
        <div className="space-y-2">
          <Label>Signature</Label>
          <SignaturePad ref={padRef} onChange={(empty) => setPadEmpty(empty)} />
          <p className="text-muted-foreground text-xs">
            Use your finger or stylus. Tap{' '}
            <span className="font-medium">Clear</span> to start over.
          </p>
        </div>
        <Button
          onClick={submit}
          disabled={submitting || padEmpty}
          className="w-full"
          size="lg"
          variant="gradient"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm & complete'}
        </Button>
        <p className="text-muted-foreground text-center text-[11px]">
          By signing, you confirm the items listed above were received.
        </p>
      </section>
    </div>
  );
}
