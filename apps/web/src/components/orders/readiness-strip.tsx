'use client';

import { CalendarClock, Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { READINESS_TONE_STYLES, ReadinessIcon, type ReadinessStripView } from './readiness-view';

/**
 * The order's readiness, above the lines table (F2-1). The words come from the
 * server (readinessStripView, core readiness-copy); this only renders them and
 * offers "Check again", which re-renders the page and so reads readiness
 * again. Every answer carries when it was checked; a failed read says
 * "Couldn't check readiness" with Try again, never a green or empty answer.
 */
export function ReadinessStrip({ view }: { view: ReadinessStripView }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const tone = READINESS_TONE_STYLES[view.tone];
  const text = view.mode === 'full' ? view.headline : view.sentence;

  return (
    <div
      className={cn('border-border border-b px-4 py-2.5 text-xs', tone.band)}
      data-testid="readiness-strip"
      data-mode={view.mode}
      data-failed={view.failed ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <p
          className={cn('flex min-w-0 items-start gap-2 font-medium', tone.text)}
          role={view.failed ? 'alert' : undefined}
        >
          <ReadinessIcon icon={view.icon} className="mt-px size-3.5 shrink-0" />
          <span data-testid="readiness-headline">
            <span className="sr-only">{view.mode === 'full' ? 'Readiness: ' : 'Stock: '}</span>
            {text}
          </span>
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => startTransition(() => router.refresh())}
          disabled={pending}
          data-testid="readiness-recheck"
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          {view.failed ? 'Try again' : 'Check again'}
        </Button>
      </div>
      {view.mode === 'full' && view.details.length > 0 && (
        <p className="text-muted-foreground mt-1 tabular-nums" data-testid="readiness-details">
          {view.details.join(' · ')}
        </p>
      )}
      {view.mode === 'full' && view.neededBy && (
        <p
          className={cn(
            'mt-1 flex items-center gap-1.5 font-medium',
            READINESS_TONE_STYLES.warning.text,
          )}
          data-testid="readiness-needed-by"
        >
          <CalendarClock className="size-3.5 shrink-0" aria-hidden />
          {view.neededBy}
        </p>
      )}
      {view.checkedAt && (
        <p className="text-muted-foreground mt-1 text-[10.5px]" data-testid="readiness-checked-at">
          {view.checkedAt}
        </p>
      )}
    </div>
  );
}
