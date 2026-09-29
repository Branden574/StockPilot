'use client';

import { ArrowUpFromLine, CalendarClock, Loader2, Lock, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { describeHoldResult, holdLeftShort, HOLD_AVAILABLE_STOCK_LABEL } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { holdOrderStockAction } from '@/server/actions/order-requests';

import {
  READINESS_TONE_STYLES,
  ReadinessIcon,
  type ReadinessStripPutAway,
  type ReadinessStripView,
} from './readiness-view';

/**
 * The order's readiness, above the lines table (F2-1). The words come from the
 * server (readinessStripView, core readiness-copy); this only renders them and
 * offers "Check again", which re-renders the page and so reads readiness
 * again. Every answer carries when it was checked; a failed read says
 * "Couldn't check readiness" with Try again, never a green or empty answer.
 *
 * "Hold available stock" (F2-2): when `holdOrderId` is set (the page decides,
 * core shouldOfferHoldStock: an approver, a hold status, some line not held or
 * partly held), it tops the order's holds up as far as free stock allows and
 * says what it held and what is still short, in core's words. A refusal is
 * the service's sentence (no write access to the warehouse, the order moved
 * on, someone else is changing it). The page is read again either way, so the
 * lines show their holds as they now are.
 *
 * "Put away N items" (F2-3): when items on the order sit in Staging, where
 * picking cannot take them, a link to the Staging list filtered to just those
 * items, from this order (the page decides, readinessStripPutAway). A viewer
 * without the permission Place asserts gets core's sentence instead. A plain
 * link: nothing here writes, and the Staging page leaves its ?item / ?order
 * params as they came.
 */
export function ReadinessStrip({
  view,
  holdOrderId = null,
  putAway = null,
}: {
  view: ReadinessStripView;
  holdOrderId?: string | null;
  putAway?: ReadinessStripPutAway | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [holding, setHolding] = React.useState(false);
  const tone = READINESS_TONE_STYLES[view.tone];
  const text = view.mode === 'full' ? view.headline : view.sentence;

  async function holdAvailableStock() {
    if (!holdOrderId) return;
    setHolding(true);
    const res = await holdOrderStockAction({ id: holdOrderId });
    setHolding(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    const sentence = describeHoldResult(res.data);
    if (holdLeftShort(res.data)) toast.warning(sentence, { duration: 8000 });
    else toast.success(sentence);
    startTransition(() => router.refresh());
  }

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
        <div className="flex flex-wrap items-center gap-1.5">
          {putAway?.kind === 'link' && (
            <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs">
              <Link href={putAway.href} data-testid="readiness-put-away">
                <ArrowUpFromLine className="size-3.5" aria-hidden />
                {putAway.label}
              </Link>
            </Button>
          )}
          {holdOrderId && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void holdAvailableStock()}
              disabled={holding || pending}
              data-testid="readiness-hold-stock"
            >
              {holding ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Lock className="size-3.5" aria-hidden />
              )}
              {HOLD_AVAILABLE_STOCK_LABEL}
            </Button>
          )}
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
      </div>
      {view.mode === 'full' && view.detail && (
        <p className="text-muted-foreground mt-1" data-testid="readiness-detail">
          {view.detail}
        </p>
      )}
      {view.mode === 'full' && view.details.length > 0 && (
        <p className="text-muted-foreground mt-1 tabular-nums" data-testid="readiness-details">
          {view.details.join(' · ')}
        </p>
      )}
      {putAway?.kind === 'needs_permission' && (
        <p className="text-muted-foreground mt-1" data-testid="readiness-put-away-permission">
          {putAway.message}
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
