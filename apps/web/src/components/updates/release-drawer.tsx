'use client';

import { RefreshCw, WifiOff, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import type { ClientReleaseEntry } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { LocalDate } from '@/components/ui/local-date';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ReleaseLoad } from '@/lib/updates/update-store';
import { utcDateLabel } from '@/lib/utc-date-label';
import { cn } from '@/lib/utils';

import { TOUCH_TARGET, TOUCH_TARGET_ICON } from './constants';
import { ReleaseEntryCard } from './release-entry-card';

const LABEL = 'text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-3)]';

export interface ReleaseDrawerProps {
  open: boolean;
  detail: ReleaseLoad;
  /** This tab is behind production. Feature links are held back until it refreshes. */
  refreshRequired: boolean;
  /** Set when a rollback is why a refresh is needed: there is nothing "new" to apply. */
  rolledBack: boolean;
  blockedBy: Array<{ id: string; label: string }>;
  saveFailed: boolean;
  onClose: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  onRefreshAnyway: () => void;
  onKeepWorking: () => void;
  onLinkClick: (entry: ClientReleaseEntry) => void;
  /** Where focus goes when the drawer closes and what opened it no longer exists. */
  returnFocusTo?: () => HTMLElement | null;
}

/**
 * "What's New", over the current page. A real dialog (Radix): focus moves in,
 * Tab stays in, Escape closes, focus goes back out. The page underneath is not
 * navigated and not re-rendered, so a half-filled form keeps its values.
 *
 * Statically imported, NOT lazy-loaded, and that is a correctness decision: the
 * tab most likely to open this is one deployment behind, exactly when the old
 * deployment's chunks may already be gone. A lazy chunk would 404 at the one
 * moment it is needed. Only the release JSON crosses the network.
 */
export function ReleaseDrawer({
  open,
  detail,
  refreshRequired,
  rolledBack,
  blockedBy,
  saveFailed,
  onClose,
  onRetry,
  onRefresh,
  onRefreshAnyway,
  onKeepWorking,
  onLinkClick,
  returnFocusTo,
}: ReleaseDrawerProps) {
  const release = detail.phase === 'ready' ? detail.release : null;
  const withdrawn = release?.status === 'withdrawn';
  const confirmTitleId = React.useId();
  const confirmBodyId = React.useId();
  const refreshRef = React.useRef<HTMLButtonElement>(null);
  const handBackFocus = React.useRef(false);
  const confirming = blockedBy.length > 0;

  // "Keep working" removes the button that had focus. Put focus back on the
  // control the person came from, and only after THAT button: the confirmation
  // also clears by itself once the work is saved.
  React.useEffect(() => {
    if (confirming || !handBackFocus.current) return;
    handBackFocus.current = false;
    refreshRef.current?.focus();
  }, [confirming]);
  const linkDisabledReason = withdrawn
    ? null
    : refreshRequired && !rolledBack
      ? 'Available after you refresh.'
      : null;

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side="right"
        hideClose
        className="flex flex-col gap-0 p-0 sm:max-w-[600px] md:max-w-[600px] lg:max-w-[600px]"
        onCloseAutoFocus={(e) => {
          // The notice that opened this is hidden while the drawer is up, so the
          // node Radix would restore focus to may be gone. Send it somewhere real.
          const target = returnFocusTo?.();
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
      >
        <header className="flex items-start justify-between gap-4 border-b px-6 py-5">
          <div className="min-w-0">
            <SheetTitle className="font-display text-xl">What’s New</SheetTitle>
            <SheetDescription className="mt-1">
              The latest improvements to StockPilot
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <button
              type="button"
              aria-label="Close What’s New"
              className={cn(
                TOUCH_TARGET_ICON[10],
                'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring -mr-2 grid shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2',
              )}
            >
              <X className="size-4" aria-hidden />
            </button>
          </SheetClose>
        </header>

        <SheetBody className="px-6 py-5" aria-busy={detail.phase === 'loading'}>
          {detail.phase === 'loading' ? (
            <div role="status" aria-label="Loading release details" className="space-y-4">
              <div className="bg-muted h-6 w-2/3 animate-pulse rounded" />
              <div className="bg-muted h-4 w-1/3 animate-pulse rounded" />
              <div className="bg-muted h-24 w-full animate-pulse rounded-xl" />
              <div className="bg-muted h-40 w-full animate-pulse rounded-xl" />
              <div className="bg-muted h-40 w-full animate-pulse rounded-xl" />
            </div>
          ) : null}

          {detail.phase === 'error' ? (
            <div role="alert" className="rounded-xl border p-5">
              <div className="flex items-start gap-3">
                {detail.offline ? (
                  <WifiOff className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                ) : null}
                <div>
                  <h3 className="text-sm font-semibold">
                    {detail.offline ? 'You are offline' : 'The release details could not be loaded'}
                  </h3>
                  <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                    {detail.offline
                      ? 'Release details need a connection. Nothing on the page behind this panel was changed.'
                      : 'Nothing on the page behind this panel was changed. You can try again, or close this and carry on.'}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn('mt-3', TOUCH_TARGET)}
                    onClick={onRetry}
                  >
                    Try again
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {detail.phase === 'idle' ? (
            <p className="text-muted-foreground text-sm">
              There are no release notes for you to read yet.
            </p>
          ) : null}

          {release ? (
            <div className="space-y-5">
              <div>
                <h2 className="font-display text-[22px] font-medium leading-tight tracking-[-0.02em]">
                  {release.title}
                </h2>
                <p className="mt-1.5 text-[12.5px] text-[var(--ed-ink-3)]">
                  {release.version ? (
                    <>
                      <span className="text-foreground/80 font-medium">{release.version}</span>
                      <span aria-hidden> · </span>
                    </>
                  ) : null}
                  <LocalDate
                    iso={release.publishedAt}
                    fallback={utcDateLabel(release.publishedAt)}
                  />
                </p>
                <p className="mt-3">
                  <span
                    className={
                      'inline-flex rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium ' +
                      (withdrawn
                        ? 'border-border text-[var(--ed-ink-3)]'
                        : refreshRequired && !rolledBack
                          ? 'border-amber-600/40 text-amber-700 dark:text-amber-400'
                          : 'border-emerald-600/30 text-emerald-700 dark:text-emerald-400')
                    }
                  >
                    {withdrawn
                      ? 'Withdrawn'
                      : refreshRequired && !rolledBack
                        ? 'Refresh required'
                        : 'Available now'}
                  </span>
                </p>
              </div>

              {saveFailed ? (
                <p
                  role="status"
                  className="rounded-lg border border-amber-600/40 px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-400"
                >
                  We could not save that you read this, so it may show as unread again.
                </p>
              ) : null}

              {withdrawn ? (
                <div className="rounded-xl border p-4">
                  <p className={LABEL}>This release was withdrawn</p>
                  <p className="mt-1.5 text-sm leading-relaxed">
                    {release.withdrawnNote ?? 'These changes are not available at the moment.'}
                  </p>
                </div>
              ) : (
                <>
                  <section aria-labelledby="release-highlights">
                    <h3 id="release-highlights" className={LABEL}>
                      Highlights
                    </h3>
                    <p className="mt-1.5 text-sm leading-relaxed">{release.summary}</p>
                  </section>

                  <section aria-label="Changes in this release" className="space-y-3">
                    {release.entries.map((entry) => (
                      <ReleaseEntryCard
                        key={entry.id}
                        entry={entry}
                        linkDisabledReason={linkDisabledReason}
                        onLinkClick={onLinkClick}
                      />
                    ))}
                  </section>
                </>
              )}
            </div>
          ) : null}
        </SheetBody>

        <SheetFooter className="flex-col gap-3 px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between">
          {confirming ? (
            <div className="w-full" role="group" aria-labelledby={confirmTitleId}>
              <p id={confirmTitleId} className="text-sm font-semibold">
                Refresh StockPilot?
              </p>
              <p id={confirmBodyId} className="text-muted-foreground mt-1 text-sm leading-relaxed">
                You have unsaved changes in {blockedBy.map((b) => b.label).join(', ')}. Save your
                work before refreshing to avoid losing those changes.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className={TOUCH_TARGET}
                  aria-describedby={confirmBodyId}
                  onClick={() => {
                    handBackFocus.current = true;
                    onKeepWorking();
                  }}
                  autoFocus
                >
                  Keep working
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className={TOUCH_TARGET}
                  onClick={onRefreshAnyway}
                >
                  Refresh anyway
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Link
                href="/dashboard/whats-new"
                onClick={onClose}
                className={cn(
                  TOUCH_TARGET,
                  'text-primary focus-visible:ring-ring inline-flex items-center rounded-md px-1 text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2',
                )}
              >
                View release history
              </Link>
              {refreshRequired ? (
                <Button ref={refreshRef} size="sm" className={TOUCH_TARGET} onClick={onRefresh}>
                  <RefreshCw className="size-3.5" aria-hidden /> Refresh to update
                </Button>
              ) : null}
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
