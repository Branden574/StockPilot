'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * What the schedule folder's loading.tsx draws. Next wraps a folder's child
 * routes in its loading boundary as well, so that one file stands in for the
 * team calendar, an event's page and the New and Edit event forms. Each gets
 * its own page's shape, picked from the path the way the (dashboard) group's
 * fallback picks its shape: a month grid for the calendar, and the narrow
 * header-and-cards page for an event or a form, so opening an event no longer
 * flashes a month grid before its page. Same boundary, no new read; grey bars
 * only: no words, no numbers.
 */
export type ScheduleSkeletonKind = 'calendar' | 'event' | 'form';

const BASE = '/dashboard/schedule';

/** The page a schedule path shows: the calendar, an event, or an event form. */
export function scheduleSkeletonKind(pathname: string | null): ScheduleSkeletonKind {
  const path = (pathname ?? BASE).replace(/\/+$/, '');
  if (!path.startsWith(`${BASE}/`)) return 'calendar';
  const [first, second, ...more] = path.slice(BASE.length + 1).split('/');
  if (first === 'new' && second === undefined) return 'form';
  if (second === 'edit' && more.length === 0) return 'form';
  return 'event';
}

export function ScheduleSkeleton() {
  const kind = scheduleSkeletonKind(usePathname());
  if (kind === 'event') return <EventSkeleton />;
  if (kind === 'form') return <FormSkeleton />;
  return <CalendarSkeleton />;
}

/** The page boxes the pages use: the calendar is wide, an event and its forms narrow. */
const PAGE_BOX = 'mx-auto flex w-full flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';
const CARD = 'border-border bg-card overflow-hidden rounded-lg border';

/** The team calendar: the page header, the month toolbar and the 7 x 6 month grid. */
function CalendarSkeleton() {
  return (
    <div
      aria-busy="true"
      data-schedule-skeleton="calendar"
      className={cn(PAGE_BOX, 'max-w-[1320px]')}
    >
      <div className="min-w-0">
        <Skeleton className="h-3 w-40" />
        <div className="mt-2 flex h-[42px] items-center">
          <Skeleton className="h-[26px] w-56" />
        </div>
        <Skeleton className="mt-1 h-3 w-full max-w-xl" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
          <Skeleton className="ml-1 h-7 w-14" />
        </div>
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className={CARD}>
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="border-border bg-sunk grid h-[37px] grid-cols-7 items-center border-b">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} className="mx-auto h-2 w-8" />
              ))}
            </div>
            <div className="grid grid-cols-7">
              {Array.from({ length: 42 }).map((_, i) => (
                <div
                  key={i}
                  data-skeleton-day=""
                  className={cn(
                    'border-border min-h-[112px] border-b border-r p-1.5',
                    i % 7 === 6 && 'border-r-0',
                    i >= 35 && 'border-b-0',
                  )}
                >
                  <Skeleton className="h-4 w-5" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A titled card (DetailSection): the 49 px header line, then the body. */
function CardSkeleton({ children }: { children: ReactNode }) {
  return (
    <div className={CARD}>
      <div className="border-border flex min-h-[49px] items-center border-b px-[18px] py-2.5">
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="p-[18px]">{children}</div>
    </div>
  );
}

/** The back link above the title, then the title's 42 px line. */
function BackAndTitle({ titleWidth, badge = false }: { titleWidth: string; badge?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex h-5 items-center">
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="flex h-[42px] items-center gap-3">
        <Skeleton className={cn('h-[26px] max-w-full', titleWidth)} />
        {badge ? <Skeleton className="h-5 w-20 rounded-full" /> : null}
      </div>
    </div>
  );
}

/** An event's page: title with its status and date line, its actions, then its cards. */
function EventSkeleton() {
  return (
    <div aria-busy="true" data-schedule-skeleton="event" className={cn(PAGE_BOX, 'max-w-3xl')}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <BackAndTitle titleWidth="w-56" badge />
          <div className="mt-0.5 flex h-5 items-center">
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-14" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-[72px]" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <CardSkeleton key={i}>
            <Skeleton className="h-3 w-40 max-w-full" />
            <Skeleton className="mt-2 h-2.5 w-24" />
          </CardSkeleton>
        ))}
      </div>
      <CardSkeleton>
        <div className="space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </CardSkeleton>
    </div>
  );
}

/** A labelled field: the 13 px label line, then the 32 px box (44 px on a phone). */
function Field({ tall = false }: { tall?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Skeleton className="h-3 w-16" />
      <Skeleton className={cn('w-full', tall ? 'h-[110px]' : 'h-8 max-sm:h-11')} />
    </div>
  );
}

/** New event and Edit event: the title, then the form card with its save bar. */
function FormSkeleton() {
  return (
    <div aria-busy="true" data-schedule-skeleton="form" className={cn(PAGE_BOX, 'max-w-3xl')}>
      <BackAndTitle titleWidth="w-40" />
      <CardSkeleton>
        <div className="space-y-5">
          <Field />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field />
            <Field />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-3 w-14" />
          </div>
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="grid gap-3 sm:grid-cols-2">
              <Field />
              <Field />
            </div>
          ))}
          <div className="border-border bg-sunk space-y-3 rounded-lg border p-4">
            <Skeleton className="h-3 w-36" />
            <Skeleton className="h-2.5 w-full max-w-md" />
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <Field />
              </div>
              <Field />
            </div>
          </div>
          <Field tall />
          <div className="border-border -mx-[18px] -mb-[18px] flex justify-end border-t px-[18px] py-3.5">
            <Skeleton className="h-8 w-28" />
          </div>
        </div>
      </CardSkeleton>
    </div>
  );
}
