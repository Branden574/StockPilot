'use client';

import { usePathname, useSearchParams } from 'next/navigation';

import { Tabs, type TabItem } from '@/components/patterns/tabs';

import { type DetailTabId } from './item-detail-tabs-shared';

// Re-export so existing call sites that import { DetailTabId, ItemDetailTabs }
// from this file continue to work without a sweep. parseDetailTab lives in
// the shared module and must be imported from there for server-component use.
export type { DetailTabId };

const TABS: ReadonlyArray<{ id: DetailTabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'movements', label: 'Movements' },
  { id: 'activity', label: 'Activity' },
];

/**
 * The item page's tab strip (Overview / Movements / Activity), drawn by the
 * shared in-page tab pattern (components/patterns/tabs.tsx). Every tab is a
 * link, so `?tab=activity` deep links render the right tab on the very first
 * paint (no client round trip) and the URL stays canonical for sharing.
 *
 * INSTANT FEEDBACK (owner report 2026-09-22: Movements/Activity took ~10 s and
 * he clicked about ten times). A tab is a query-only navigation that re-renders
 * the whole item page on the server, and that render makes its Supabase calls
 * in series, so one stalled call stalls the tab. The underline used to follow
 * `activeTab`, which only changes when the server's answer lands: in the logged
 * incidents that was 3.6-6.6 s with nothing on screen, because the top progress
 * bar skipped same-path navigations too, and no loading.tsx fallback can show
 * for a query-only change (Next keys the page's React tree WITHOUT the query,
 * layout-router.js `createRouterCacheKey(activeSegment, true)`, so the page
 * stays mounted inside a transition). The pattern keeps every rule this strip
 * has always had (item-detail-tabs.feedback.test.tsx pins them here, and
 * tabs.test.tsx in the pattern):
 *
 *   1. The clicked tab is shown selected at once, and its underline pulses for
 *      as long as next/link reports that navigation pending (useLinkStatus).
 *   2. A click on the tab already shown selected does nothing. Next treats a
 *      link to the exact current URL as "refresh this page"
 *      (segment-cache/navigation.js `isSamePageNavigation`), which re-ran every
 *      server read to render the same thing; and a repeat click on the tab that
 *      is still loading restarted its navigation from zero.
 *   3. The optimistic tab never outlives the navigation it stands for. It is
 *      tied to the URL it was clicked on, so once the URL moves (the navigation
 *      landed, Back was pressed) the URL decides again; and when next/link says
 *      the navigation is over while the URL has NOT moved (another link took
 *      over), it is dropped and the real tab shows again.
 *
 * Each tab keeps the id its panel names (`item-detail-tab-<id>`, and
 * `aria-controls="item-detail-panel-<id>"`), and `scroll={false}` keeps the
 * page where it is on a tab switch.
 */
export function ItemDetailTabs({ activeTab }: { activeTab: DetailTabId }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams?.toString() ?? '';

  // Preserve any other query params (filters, the validated return target)
  // when swapping tabs. The tab the server rendered is linked to the address
  // bar exactly as it is by the pattern itself, so its href and the URL agree
  // even when the URL spells the tab another way (?tab=overview, an unknown
  // ?tab=): NavProgressBar compares the two to decide whether a click is a
  // navigation at all.
  function hrefFor(tab: DetailTabId): string {
    const params = new URLSearchParams(query);
    if (tab === 'overview') {
      params.delete('tab');
    } else {
      params.set('tab', tab);
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  const items: TabItem[] = TABS.map((t) => ({ id: t.id, label: t.label, href: hrefFor(t.id) }));

  return (
    <Tabs
      items={items}
      activeId={activeTab}
      aria-label="Item detail sections"
      idPrefix="item-detail"
      scroll={false}
    />
  );
}
