'use client';

import { Gift, RefreshCw, TriangleAlert, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { LocalDate } from '@/components/ui/local-date';
import { utcDateLabel } from '@/lib/utc-date-label';
import { cn } from '@/lib/utils';

import { TOUCH_TARGET, TOUCH_TARGET_ICON } from './constants';

/**
 * The bottom-right product-update notice. PRESENTATIONAL: everything it shows
 * and does arrives as props, so each state below is a test.
 *
 * NONMODAL, and it never takes focus on its own. It appears because a deploy
 * happened somewhere else, not because the person did anything, so stealing
 * focus would interrupt whatever they were typing. The ONE exception is the
 * unsaved-work confirmation: that is the direct result of the person pressing
 * Refresh, so focus moves to the safe answer.
 *
 * Reading the notes and applying the update are separate buttons on purpose.
 * "What's New" never reloads; "Refresh to update" never opens anything.
 */

export type UpdateCardModel =
  | { kind: 'update'; release: { title: string; version?: string; publishedAt: string } | null }
  | { kind: 'rollback' }
  | { kind: 'unread'; release: { title: string; version?: string; publishedAt: string } }
  | { kind: 'reload-failed' };

export interface UpdateCardProps {
  model: UpdateCardModel;
  /** Non-empty = the last refresh request was blocked by these. */
  blockedBy: Array<{ id: string; label: string }>;
  onWhatsNew: () => void;
  onRefresh: () => void;
  onRefreshAnyway: () => void;
  onKeepWorking: () => void;
  onDismiss: () => void;
  className?: string;
}

const COPY: Record<UpdateCardModel['kind'], { title: string; body: string }> = {
  update: {
    title: 'A new StockPilot update is available',
    body: 'See what changed and how it affects your work.',
  },
  rollback: {
    title: 'StockPilot was restored to an earlier version',
    body: 'Refresh when convenient so this tab matches what everyone else is using.',
  },
  unread: {
    title: 'What’s new in StockPilot',
    body: 'Explore the latest changes and see what they mean for your work.',
  },
  'reload-failed': {
    title: 'The update did not load',
    body: 'This tab is still on the previous version. Your work is untouched. Try again in a minute.',
  },
};

export function UpdateCard({
  model,
  blockedBy,
  onWhatsNew,
  onRefresh,
  onRefreshAnyway,
  onKeepWorking,
  onDismiss,
  className,
}: UpdateCardProps) {
  const keepWorkingRef = React.useRef<HTMLButtonElement>(null);
  const refreshRef = React.useRef<HTMLButtonElement>(null);
  const handBackFocus = React.useRef(false);
  const confirmTitleId = React.useId();
  const confirmBodyId = React.useId();
  const confirming = blockedBy.length > 0;

  // The person just pressed Refresh and was stopped: put focus on the safe
  // choice. The button is DESCRIBED BY the explanation, so a screen reader says
  // why focus moved, not just "Keep working, button".
  React.useEffect(() => {
    if (confirming) keepWorkingRef.current?.focus();
  }, [confirming]);

  // "Keep working" unmounts the button that had focus, which drops focus to
  // <body> and sends a keyboard user back to the top of the page. Hand it back
  // to where they were. ONLY after that button: the confirmation also clears by
  // itself once the work is saved, and then focus is theirs, somewhere else.
  React.useEffect(() => {
    if (confirming || !handBackFocus.current) return;
    handBackFocus.current = false;
    refreshRef.current?.focus();
  }, [confirming]);

  const release = model.kind === 'update' || model.kind === 'unread' ? model.release : null;
  const copy = COPY[model.kind];
  // With no release attached there is nothing to read: say the honest thing.
  const body =
    model.kind === 'update' && !release
      ? 'Refresh when convenient to use the latest version.'
      : copy.body;
  const Icon =
    model.kind === 'unread' ? Gift : model.kind === 'reload-failed' ? TriangleAlert : RefreshCw;
  const canRefresh = model.kind !== 'unread';

  return (
    <section
      aria-label="Product update"
      data-update-notice
      className={cn(
        'bg-card text-card-foreground border-border pointer-events-auto relative w-full rounded-xl border p-4 font-sans shadow-lg duration-200 animate-in fade-in slide-in-from-bottom-2 sm:w-[400px]',
        className,
      )}
    >
      {confirming ? (
        <div role="group" aria-labelledby={confirmTitleId} aria-describedby={confirmBodyId}>
          <h2 id={confirmTitleId} className="text-sm font-semibold tracking-tight">
            Refresh StockPilot?
          </h2>
          <p id={confirmBodyId} className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
            You have unsaved changes in {blockedBy.map((b) => b.label).join(', ')}. Save your work
            before refreshing to avoid losing those changes.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              ref={keepWorkingRef}
              size="sm"
              aria-describedby={confirmBodyId}
              onClick={() => {
                handBackFocus.current = true;
                onKeepWorking();
              }}
              className={TOUCH_TARGET}
            >
              Keep working
            </Button>
            <Button size="sm" variant="outline" onClick={onRefreshAnyway} className={TOUCH_TARGET}>
              Refresh anyway
            </Button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss update notice"
            className={cn(
              TOUCH_TARGET_ICON[8],
              'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring absolute right-1 top-1 grid place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 sm:right-2 sm:top-2',
            )}
          >
            <X className="size-4" aria-hidden />
          </button>
          <div className="flex items-start gap-3 pr-10 sm:pr-8">
            <span className="bg-primary/10 text-primary mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg">
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold tracking-tight">{copy.title}</h2>
              <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{body}</p>
              {release ? (
                // The DATE never truncates; a long release title does. With no
                // version label the title stands in for it, and a title can be
                // a whole sentence.
                <p className="mt-2 flex min-w-0 items-baseline gap-1.5 text-[12px] text-[var(--ed-ink-3)]">
                  <span className="text-foreground/80 min-w-0 truncate font-medium">
                    {release.version ?? release.title}
                  </span>
                  <span aria-hidden className="shrink-0">
                    ·
                  </span>
                  <LocalDate
                    iso={release.publishedAt}
                    fallback={utcDateLabel(release.publishedAt)}
                    className="shrink-0"
                  />
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {release ? (
              <Button size="sm" onClick={onWhatsNew} className={TOUCH_TARGET}>
                <Gift className="size-3.5" aria-hidden /> What’s New
              </Button>
            ) : null}
            {canRefresh ? (
              <Button
                size="sm"
                variant={release ? 'outline' : 'default'}
                ref={refreshRef}
                onClick={onRefresh}
                className={TOUCH_TARGET}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                {model.kind === 'reload-failed' ? 'Try again' : 'Refresh to update'}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * One short sentence for the screen-reader announcement. While a refresh is
 * being held back it says THAT: the card's content was swapped and focus moved,
 * and an unchanged live region would have announced nothing about either.
 */
export function updateAnnouncement(
  model: UpdateCardModel,
  blockedBy: ReadonlyArray<{ label: string }> = [],
): string {
  if (blockedBy.length > 0)
    return `Refresh paused. You have unsaved changes in ${blockedBy.map((b) => b.label).join(', ')}.`;
  const copy = COPY[model.kind];
  return model.kind === 'update' && !model.release ? copy.title : `${copy.title}. ${copy.body}`;
}
