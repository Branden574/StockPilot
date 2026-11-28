'use client';

import Link from 'next/link';

import { AUTHENTICATOR_SET_UP_URL } from '@stockpilot/core';

import { Button } from '@/components/ui/button';

import type { SupplierRiskOutcome } from './step-up';

/**
 * A refused or failed write, said in words (role="alert", so a screen reader
 * hears it when it appears): the database's refusal in core's words, a link
 * to set up the authenticator when that is owed, and Reload when the draft
 * moved since the page read it.
 */
export function SupplierRiskOutcomeNote({
  outcome,
  onReload,
}: {
  outcome: SupplierRiskOutcome | null;
  onReload?: () => void;
}) {
  if (!outcome) return null;
  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive-wash text-foreground flex flex-col gap-2 rounded-md border px-3 py-2 text-[13px] sm:flex-row sm:items-center sm:justify-between"
    >
      <p>{outcome.text}</p>
      {outcome.setUp ? (
        <Button asChild size="sm" variant="outline">
          <Link href={AUTHENTICATOR_SET_UP_URL}>Set up a second step</Link>
        </Button>
      ) : null}
      {outcome.reload && onReload ? (
        <Button size="sm" variant="outline" onClick={onReload}>
          Reload
        </Button>
      ) : null}
    </div>
  );
}
