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
 */
export function RentalsTabs({ activeTab }: RentalsTabsProps) {
  return <Tabs aria-label="Rentals section" activeId={activeTab} items={TABS} />;
}
