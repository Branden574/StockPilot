'use client';

import { RefreshCw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Shown above every dashboard page when the organization's module state could
 * not be read for this request (the layout's module set is the unknown one:
 * lib/modules/module-state).
 *
 * The menu is then drawn from what is known to be on, which is the core
 * sections only, and a page that asks about a module shows its own "could not
 * check" state. Without these words that would look like every optional
 * module had been switched off. So the strip says what happened and that
 * pages and menu items may be unavailable.
 *
 * TRY AGAIN IS A FULL PAGE LOAD. The page under the strip may be showing its
 * error state, and an error boundary keeps its error through a refresh of
 * the server components: a refresh would bring the menu back and leave the
 * page's card. A full load reads everything again, so one press recovers the
 * menu and the page together. Nothing is opened by it: a page still checks
 * its own module on that read.
 *
 * The caution strip of MfaRequiredBanner: the warning wash with a hairline,
 * the icon in the warning tone beside the words (never colour alone).
 */
export function ModulesUnreadBanner() {
  return (
    <div
      role="status"
      data-modules-unread=""
      className="border-warning/30 bg-warning-wash text-foreground flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 text-[13.5px] sm:px-8"
    >
      <TriangleAlert className="text-warning size-4 shrink-0" strokeWidth={1.8} aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">We couldn&apos;t check which modules are on.</span>{' '}
        <span className="text-[var(--ed-ink-2)]">
          Some pages and menu items may be unavailable. This is usually temporary.
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
