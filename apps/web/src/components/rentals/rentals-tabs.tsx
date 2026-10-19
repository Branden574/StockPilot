import { Tabs } from '@/components/patterns/tabs';

interface RentalsTabsProps {
  activeTab: 'activity' | 'items';
}

const TABS: Array<{ id: 'activity' | 'items'; label: string; href: string }> = [
  { id: 'activity', label: 'Activity', href: '/dashboard/rentals' },
  { id: 'items', label: 'Items', href: '/dashboard/rentals/items' },
];

/**
 * The Rentals section tabs, Activity (the checkouts) and Items (the rental
 * catalog), drawn by the shared in-page tab strip (DESIGN-SPEC 6.21, P2.6
 * Tabs): the same two links and words, `role="tablist"` named "Rentals
 * section", `role="tab"` with `aria-selected` on each, an underline on the
 * current one and instant feedback on a click while the page loads.
 *
 * PATTERN-IMPOSED CHANGE (review finding, for the owner's review): the shared
 * strip links the CURRENT tab to the address bar as it is and cancels a click
 * on it (patterns/tabs.tsx), so clicking Activity on `?status=returned`, or
 * Items on a filtered or paged list, no longer resets that view or those
 * filters as the old strip's fixed links did. The Out status view and the
 * table's clear-filters control still do it. The other tab links to its fixed
 * URL as before. patterns/** is locked to this package; the integrator was
 * asked for a Tabs prop (`activeLinksToHref`) that keeps `item.href` on the
 * current tab and skips the click cancel, for this strip to pass.
 */
export function RentalsTabs({ activeTab }: RentalsTabsProps) {
  return <Tabs aria-label="Rentals section" activeId={activeTab} items={TABS} />;
}
