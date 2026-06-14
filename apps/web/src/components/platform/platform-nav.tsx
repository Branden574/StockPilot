'use client';

import { Building2, FileLock2, LifeBuoy, PlusCircle, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/platform', label: 'Organizations', icon: Building2, exact: true },
  { href: '/platform/provision', label: 'Provision', icon: PlusCircle },
  { href: '/platform/support', label: 'Support', icon: LifeBuoy },
  { href: '/platform/audit', label: 'Audit', icon: FileLock2 },
];

export function PlatformNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((l) => {
        const active = l.exact ? pathname === l.href : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
              active
                ? 'bg-foreground text-background'
                : 'text-[var(--ed-ink-3)] hover:bg-card hover:text-foreground'
            }`}
          >
            <l.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            {l.label}
          </Link>
        );
      })}
      <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-[var(--ed-line-strong)] px-2 py-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
        <ShieldAlert className="h-3 w-3" strokeWidth={2} />
        Platform admin
      </span>
    </nav>
  );
}
