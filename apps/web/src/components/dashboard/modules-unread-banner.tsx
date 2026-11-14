import { TriangleAlert } from 'lucide-react';

import { TryAgainButton } from './try-again-button';

/**
 * Shown above every dashboard page when the organization's module state could
 * not be read for this request (the layout's module read: lib/dashboard/
 * request-cache readModulesForRequest answered "rows unreadable" and no comp
 * decides them).
 *
 * The menu is then drawn from what is known to be on, which is the core
 * sections only. That is not the organization's menu, and without these words
 * it would look like every optional module had been switched off. So the
 * strip says what happened and offers Try again, which asks the server for
 * the page (and this layout) again. Nothing is opened by it: a page still
 * checks its own module, and says "could not check" on the same read.
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
          Some menu items may be missing. This is usually temporary.
        </span>
      </p>
      <TryAgainButton size="sm" className="shrink-0" />
    </div>
  );
}
