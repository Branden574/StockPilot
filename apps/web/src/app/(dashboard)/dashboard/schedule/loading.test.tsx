// @vitest-environment node
// Rendered to a string, as the server renders the fallback on a hard load: a
// `window` access anywhere in it fails here instead of in production.
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { value: '/dashboard/schedule' } }));
vi.mock('next/navigation', () => ({ usePathname: () => pathnameRef.value }));

import { scheduleSkeletonKind } from '@/components/schedule/schedule-skeleton';

import ScheduleLoading from './loading';

function fallbackFor(pathname: string): string {
  pathnameRef.value = pathname;
  return renderToString(<ScheduleLoading />);
}

const shapeOf = (html: string) => html.match(/data-schedule-skeleton="([a-z]+)"/)?.[1];
const dayCells = (html: string) => html.split('data-skeleton-day=""').length - 1;

/**
 * Next wraps a folder's child routes in its loading.tsx as well, so this one
 * file is what an event's page and the New and Edit event forms show while
 * they load, not only the calendar. It drew the calendar's 1,320 px month
 * grid for all four, so opening an event flashed a month of empty days before
 * a narrow page. It now draws the shape of the page on the path. No
 * loading.tsx is added (the late-skeleton guard pins the list).
 */
describe('schedule loading.tsx', () => {
  it('runs without a DOM (the node docblock is in place)', () => {
    expect(typeof window).toBe('undefined');
  });

  it.each([
    ['/dashboard/schedule', 'calendar'],
    ['/dashboard/schedule/', 'calendar'],
    ['/dashboard/schedule/new', 'form'],
    ['/dashboard/schedule/new/', 'form'],
    ['/dashboard/schedule/0b6f3c1e-1d2a-4c55-9f1e-6a1f0e3b2c4d', 'event'],
    ['/dashboard/schedule/0b6f3c1e-1d2a-4c55-9f1e-6a1f0e3b2c4d/edit', 'form'],
    ['/dashboard/schedule/0b6f3c1e/edit/', 'form'],
  ])('%s shows the %s shape', (pathname, kind) => {
    expect(scheduleSkeletonKind(pathname)).toBe(kind);
    expect(shapeOf(fallbackFor(pathname))).toBe(kind);
  });

  it('a path it does not know falls back to the calendar at the folder root and to the narrow page below it', () => {
    expect(scheduleSkeletonKind(null)).toBe('calendar');
    expect(scheduleSkeletonKind('/dashboard/schedule-x')).toBe('calendar');
    expect(scheduleSkeletonKind('/dashboard/schedule/a/b/c')).toBe('event');
  });

  it('the calendar keeps its month grid in the wide page box', () => {
    const html = fallbackFor('/dashboard/schedule');
    expect(dayCells(html)).toBe(42);
    expect(html).toContain('max-w-[1320px]');
    expect(html).not.toContain('max-w-3xl');
  });

  it.each(['/dashboard/schedule/ev-1', '/dashboard/schedule/new', '/dashboard/schedule/ev-1/edit'])(
    '%s draws no month grid, in the narrow page box its page uses',
    (pathname) => {
      const html = fallbackFor(pathname);
      expect(dayCells(html)).toBe(0);
      expect(html).toContain('max-w-3xl');
      expect(html).not.toContain('max-w-[1320px]');
    },
  );

  it.each([
    '/dashboard/schedule',
    '/dashboard/schedule/ev-1',
    '/dashboard/schedule/new',
    '/dashboard/schedule/ev-1/edit',
  ])('%s is marked busy and draws grey bars only: no words, no numbers', (pathname) => {
    const html = fallbackFor(pathname);
    expect(html).toMatch(/^<div aria-busy="true"/);
    expect(html.replace(/<[^>]*>/g, '')).toBe('');
  });
});
