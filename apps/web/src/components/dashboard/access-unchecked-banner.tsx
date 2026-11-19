'use client';

import { RefreshCw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Shown above every dashboard page when the organization's authenticator
 * policy could not be read for this request (the organization row came back
 * hidden, or with a value that is not a policy) and the member has no verified
 * authenticator.
 *
 * The member is held to the strictest policy, so every page that is not open
 * before set-up shows its "couldn't check your access" card in place of its
 * content (requireOrgContext(), lib/auth/step-up-gate.ts), and an action
 * answers that its access could not be checked. Whether the organization asks
 * for an authenticator is not known, so the strip does not say set one up: it
 * says what is true, in the words of that card, and offers Try again.
 *
 * TRY AGAIN IS A FULL PAGE LOAD, as on ModulesUnreadBanner: the page under the
 * strip may be showing its error state, which a refresh of the server
 * components would keep. Nothing is opened by it: the page checks again on
 * that load.
 *
 * The caution strip of ModulesUnreadBanner and MfaRequiredBanner: the warning
 * wash with a hairline, the icon in the warning tone beside the words (never
 * colour alone).
 */
export function AccessUncheckedBanner() {
  return (
    <div
      role="status"
      data-access-unchecked=""
      className="border-warning/30 bg-warning-wash text-foreground flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 text-[13.5px] sm:px-8"
    >
      <TriangleAlert className="text-warning size-4 shrink-0" strokeWidth={1.8} aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">We couldn&apos;t check your access just now.</span>{' '}
        <span className="text-[var(--ed-ink-2)]">
          Some pages may be unavailable. This is usually temporary.
        </span>
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => window.location.reload()}
      >
        <RefreshCw aria-hidden /> Try again
      </Button>
    </div>
  );
}
