'use client';

import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  Boxes,
  ChevronDown,
  ClipboardList,
  Cog,
  Home,
  type LucideIcon,
  MapPin,
  Tag,
  Truck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { IconMark } from '@/components/ui/icon-mark';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string | number;
  alert?: boolean;
}

interface NavSection {
  label?: string;
  items: NavItem[];
}

const NAV: NavSection[] = [
  {
    items: [{ href: '/dashboard', label: 'Overview', icon: Home }],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/dashboard/inventory', label: 'Items', icon: Boxes },
      { href: '/dashboard/categories', label: 'Categories', icon: Tag },
      { href: '/dashboard/movements', label: 'Movements', icon: ArrowLeftRight },
      { href: '/dashboard/purchase-orders', label: 'Purchase orders', icon: ClipboardList },
      { href: '/dashboard/locations', label: 'Locations', icon: MapPin },
      { href: '/dashboard/suppliers', label: 'Suppliers', icon: Truck },
      { href: '/dashboard/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
      { href: '/dashboard/team', label: 'Team', icon: Users },
      { href: '/dashboard/settings', label: 'Settings', icon: Cog },
    ],
  },
];

interface SidebarProps {
  className?: string;
  organizationName: string;
  userName: string | null;
  userRole?: string;
}

export function Sidebar({ className, organizationName, userName, userRole }: SidebarProps) {
  const pathname = usePathname();
  const initials = (userName || 'U')
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');

  return (
    <aside
      className={cn(
        'flex h-screen w-[232px] shrink-0 flex-col border-r border-border bg-background',
        className,
      )}
    >
      {/* Brand head */}
      <div className="flex h-13 items-center gap-2.5 border-b border-border px-3.5" style={{ height: 52 }}>
        <Link href="/dashboard">
          <IconMark size={22} />
        </Link>
      </div>

      {/* Org pill */}
      <button
        type="button"
        className="mx-3 mt-3 flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-[12px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)]"
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />
        <span className="flex-1 truncate text-left">{organizationName}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-2.5 scrollbar-thin">
        {NAV.map((section, idx) => (
          <div key={idx} className="px-1.5 pb-1 pt-2.5">
            {section.label && (
              <div className="px-2 pb-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
                {section.label}
              </div>
            )}
            {section.items.map((item) => {
              const active =
                pathname === item.href ||
                (pathname.startsWith(item.href) && item.href !== '/dashboard');
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 text-[13px] transition-colors',
                    active
                      ? 'border border-border bg-card text-foreground shadow-[0_1px_0_rgba(14,15,13,0.04),_0_1px_2px_rgba(14,15,13,0.04)]'
                      : 'border border-transparent text-[var(--ed-ink-2)] hover:bg-muted hover:text-foreground',
                  )}
                >
                  <item.icon
                    className={cn('h-4 w-4 shrink-0', active ? 'text-foreground' : 'text-[var(--ed-ink-3)]')}
                  />
                  <span className="flex-1">{item.label}</span>
                  {item.badge != null && (
                    <span
                      className={cn(
                        'shrink-0 rounded-[3px] border px-1.5 py-px font-mono text-[10.5px]',
                        item.alert
                          ? 'border-transparent bg-[hsl(var(--destructive)/0.16)] text-[hsl(var(--destructive))]'
                          : 'border-border bg-muted text-[var(--ed-ink-3)]',
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User foot */}
      <div className="flex items-center gap-2.5 border-t border-border px-3 py-2.5">
        <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] leading-tight">{userName ?? '—'}</div>
          <div className="truncate text-[11px] text-[var(--ed-ink-4)]">{userRole ?? 'Member'}</div>
        </div>
      </div>
    </aside>
  );
}
