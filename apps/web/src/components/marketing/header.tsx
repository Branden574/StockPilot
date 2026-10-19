'use client';

import { ArrowRight, Menu, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { IconMark } from '@/components/ui/icon-mark';
import { cn } from '@/lib/utils';

// Standard marketing nav. Section links use absolute `/#id` so they also work
// from sub-pages (/pricing, /support…) — clicking jumps to the landing section.
const NAV: Array<{ href: string; label: string }> = [
  { href: '/#product', label: 'Features' },
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/#compare', label: 'Compare' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/support', label: 'Support' },
];

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
    // An opaque header (redesign P5.1: no glass, no blur). It sits on the page
    // ground and takes its hairline once the page scrolls under it.
    <header
      className={cn(
        'bg-background sticky top-0 z-30 w-full border-b border-transparent transition-colors',
        scrolled && 'border-border',
      )}
    >
      <div className="mx-auto flex h-14 max-w-[1280px] items-center px-4 sm:px-8">
        <Link href="/" aria-label="Home">
          <IconMark size={22} />
        </Link>

        <nav className="ml-9 hidden items-center gap-6 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2"
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden items-center gap-2 md:flex">
            <ThemeToggle />
            {/* Plain anchors (not <Link>): entering the app is a full document
                load, not a client route transition. */}
            <Button asChild variant="ghost" size="sm">
              <a href="/signin">Sign in</a>
            </Button>
            <Button asChild size="sm" className="gap-1.5">
              <a href="/signin">
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
        <div className="border-border bg-background border-t md:hidden">
          <div className="container mx-auto flex max-w-7xl flex-col gap-1 px-4 py-3">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setMobileOpen(false)}
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex min-h-11 items-center rounded-md px-3 text-sm"
              >
                {n.label}
              </Link>
            ))}
            <div className="mt-2 flex gap-2">
              <Button asChild className="h-11 flex-1">
                <a href="/signin" onClick={() => setMobileOpen(false)}>
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
