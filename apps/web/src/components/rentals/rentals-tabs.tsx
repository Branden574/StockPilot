import Link from 'next/link';

import { cn } from '@/lib/utils';

interface RentalsTabsProps {
  activeTab: 'activity' | 'items';
}

const TABS: Array<{ id: 'activity' | 'items'; label: string; href: string }> = [
  { id: 'activity', label: 'Activity', href: '/dashboard/rentals' },
  { id: 'items', label: 'Items', href: '/dashboard/rentals/items' },
];

export function RentalsTabs({ activeTab }: RentalsTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Rentals section"
      className="flex items-center gap-1 border-b"
    >
      {TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            role="tab"
            aria-selected={isActive}
            className={cn(
              'relative px-4 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t-full bg-foreground" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
