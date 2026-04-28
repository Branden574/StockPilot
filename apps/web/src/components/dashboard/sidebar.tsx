'use client';

import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  Boxes,
  Building2,
  ClipboardList,
  CreditCard,
  LayoutDashboard,
  type LucideIcon,
  Settings,
  ShoppingCart,
  Tag,
  Truck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { IconMark } from '@/components/ui/icon-mark';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/dashboard/inventory', label: 'Items', icon: Boxes },
      { href: '/dashboard/locations', label: 'Locations', icon: Building2 },
      { href: '/dashboard/categories', label: 'Categories', icon: Tag },
      { href: '/dashboard/suppliers', label: 'Suppliers', icon: Truck },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/dashboard/purchase-orders', label: 'Purchase orders', icon: ClipboardList },
      { href: '/dashboard/movements', label: 'Stock movements', icon: ArrowLeftRight },
      { href: '/dashboard/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/dashboard/team', label: 'Team', icon: Users },
      { href: '/dashboard/settings/billing', label: 'Billing', icon: CreditCard },
      { href: '/dashboard/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        'flex h-full w-60 shrink-0 flex-col border-r border-border/60 bg-muted/20',
        className,
      )}
    >
      <div className="flex h-16 items-center px-5">
        <Link href="/dashboard" className="text-base">
          <IconMark />
        </Link>
      </div>
      <Separator />
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="flex flex-col gap-6">
          {NAV.map((group) => (
            <div key={group.label}>
              <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const active =
                    pathname === item.href ||
                    (pathname.startsWith(item.href) && item.href !== '/dashboard');
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                        active
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </ScrollArea>
      <Separator />
      <div className="px-4 py-3 text-xs text-muted-foreground">
        <Link href="/dashboard/settings/billing" className="flex items-center gap-2 hover:text-foreground">
          <ShoppingCart className="h-3.5 w-3.5" />
          Upgrade plan
        </Link>
      </div>
    </aside>
  );
}
