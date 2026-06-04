'use client';

import { ArrowRight, Menu, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { IconMark } from '@/components/ui/icon-mark';
import { requestBootSplash } from '@/lib/boot-handoff';
import { cn } from '@/lib/utils';

// Internal-company tool — no public pricing/customer pages. The marketing
// landing is mostly a welcome screen for staff that arrive at the root URL.
const NAV: Array<{ href: string; label: string }> = [];

export function MarketingHeader() {
  const [scrolled, setScrolled] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        'sticky top-0 z-30 w-full border-b border-transparent transition-colors',
        scrolled && 'border-border bg-[color-mix(in_oklab,_hsl(var(--background))_88%,_transparent)] backdrop-blur-md',
      )}
    >
      <div className="mx-auto flex h-14 max-w-[1280px] items-center px-8">
        <Link href="/" aria-label="Home">
          <IconMark size={22} />
        </Link>

        <nav className="ml-9 hidden items-center gap-6 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="text-[13px] text-[var(--ed-ink-3)] transition-colors hover:text-foreground"
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden items-center gap-2 md:flex">
            <ThemeToggle />
            {/* Plain anchors (not <Link>): a full navigation re-mounts the root
                layout at /signin so the branded BootSplash plays once on app
                entry. requestBootSplash() arms it just before navigating. */}
            <Button asChild variant="ghost" size="sm">
              <a href="/signin" onClick={requestBootSplash}>
                Sign in
              </a>
            </Button>
            <Button asChild size="sm" className="gap-1.5">
              <a href="/signin" onClick={requestBootSplash}>
                Open app
                <ArrowRight className="h-3 w-3" />
              </a>
            </Button>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {mobileOpen && (
        <div className="border-t border-border bg-background/95 backdrop-blur-md md:hidden">
          <div className="container mx-auto flex max-w-7xl flex-col gap-1 px-4 py-3">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setMobileOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-[var(--ed-ink-3)] hover:bg-muted hover:text-foreground"
              >
                {n.label}
              </Link>
            ))}
            <div className="mt-2 flex gap-2">
              <Button asChild size="sm" className="flex-1">
                <a
                  href="/signin"
                  onClick={() => {
                    requestBootSplash();
                    setMobileOpen(false);
                  }}
                >
                  Sign in
                </a>
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
