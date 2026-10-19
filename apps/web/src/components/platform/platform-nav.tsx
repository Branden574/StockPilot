'use client';

import { Building2, FileLock2, LifeBuoy, PlusCircle, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/platform', label: 'Organizations', icon: Building2 },
  { href: '/platform/provision', label: 'Provision', icon: PlusCircle },
  { href: '/platform/support', label: 'Support', icon: LifeBuoy },
  { href: '/platform/audit', label: 'Audit', icon: FileLock2 },
];

/**
 * Which console destination a path belongs to. Organizations is the directory
 * AND every organization's own page (`/platform/orgs/[id]`), so it stays lit
 * while an operator works inside one org; the other three match their own
 * path and anything under it.
 */
export function isPlatformNavActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === '/platform')
    return pathname === '/platform' || pathname.startsWith('/platform/orgs/');
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The console's own navigation: the sidebar item recipe laid out in the top
 * bar (32 px, the neutral hover fill, ink and weight on the current page),
 * then the "Platform admin" marker. On a phone the links drop their icons and
 * grow to 44 px, and the row scrolls inside itself rather than pushing the
 * page wider.
 */
export function PlatformNav({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Platform"
      data-slot="platform-nav"
      className={cn(
        'flex min-w-0 items-center gap-1 overflow-x-auto max-sm:-mx-4 max-sm:px-4 sm:flex-wrap',
        className,
      )}
    >
      {LINKS.map((l) => {
        const active = isPlatformNavActive(pathname, l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors max-sm:h-11',
              active
                ? 'bg-muted text-foreground font-medium'
                : 'text-ink-2 hover:bg-muted hover:text-foreground',
            )}
          >
            <l.icon className="hidden h-3.5 w-3.5 sm:block" strokeWidth={1.75} aria-hidden />
            {l.label}
          </Link>
        );
      })}
      <span className="border-line-strong text-muted-foreground ml-2 inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[10.5px] font-medium uppercase tracking-[0.08em]">
        <ShieldAlert className="h-3 w-3" strokeWidth={2} aria-hidden />
        Platform admin
      </span>
    </nav>
  );
}
