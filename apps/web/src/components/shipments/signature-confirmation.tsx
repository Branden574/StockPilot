'use client';

import { CheckCircle2 } from 'lucide-react';

interface SignatureConfirmationProps {
  signedByName: string;
  email: string;
  workOrderNumber: string;
}

/**
 * Post-submit confirmation card shown after the recipient signs. Mirrors
 * the visual weight of the form it replaces so the page doesn't reflow
 * jarringly. Static — no interactivity beyond the link.
 */
export function SignatureConfirmation({
  signedByName,
  email,
  workOrderNumber,
}: SignatureConfirmationProps) {
  return (
    <div className="border-border bg-card rounded-2xl border p-6 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ed-accent,oklch(0.74_0.12_165))]/10">
        <CheckCircle2 className="h-7 w-7 text-[color:var(--ed-accent,#6cbfa3)]" aria-hidden />
      </div>
      <h2 className="font-display mt-4 text-xl">Thanks, {signedByName}</h2>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        We recorded your signature for{' '}
        <span className="text-foreground font-mono text-xs">{workOrderNumber}</span>.
      </p>
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
        A signed copy of the packing slip was emailed to{' '}
        <span className="text-foreground font-medium">{email}</span>.
      </p>
      <p className="text-muted-foreground mt-6 text-xs">
        You can safely close this page.
      </p>
    </div>
  );
}
