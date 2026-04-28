import Link from 'next/link';
import type { ReactNode } from 'react';

import { ThemeToggle } from '@/components/theme/theme-toggle';
import { IconMark } from '@/components/ui/icon-mark';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-mesh" />
      <header className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/">
          <IconMark />
        </Link>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">{children}</div>
      </main>
      <footer className="container mx-auto max-w-7xl px-4 py-6 text-center text-xs text-muted-foreground sm:px-6">
        <p>
          By continuing you agree to our{' '}
          <Link href="/legal/terms" className="underline hover:text-foreground">
            Terms
          </Link>{' '}
          and{' '}
          <Link href="/legal/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
      </footer>
    </div>
  );
}
