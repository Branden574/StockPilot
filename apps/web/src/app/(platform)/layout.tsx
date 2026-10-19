import Link from 'next/link';
import type { ReactNode } from 'react';

import { PlatformNav } from '@/components/platform/platform-nav';
import { buttonVariants } from '@/components/ui/button';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { cn } from '@/lib/utils';

/**
 * Platform Super-Admin Console shell. This layout is the single hard gate
 * for the entire `/platform` tree: `requirePlatformAdmin()` requires a
 * signed-in session + the email on the deploy-time allowlist + MFA at AAL2,
 * and 404s (not 403s) on any failure so the console's existence is never
 * revealed. Deliberately NOT nested under the org-scoped (dashboard) group:
 * no org sidebar, realtime, activity beacon, banners or warehouse filter.
 *
 * The top bar is the redesign's topbar (56 px, an opaque surface, no blur).
 * It WRAPS instead of overflowing: on a wide screen the mark, the console nav
 * and the operator's email with the way back to the workspace share one row;
 * below `lg` the nav takes a row of its own, and on a phone that row scrolls
 * inside itself, so the page never scrolls sideways (it used to be ~578 px
 * wide at a 390 px viewport) and "My workspace" is always on screen.
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const session = await requirePlatformAdmin();

  return (
    <div className="bg-background min-h-screen">
      <header
        data-slot="platform-topbar"
        className="border-border bg-background sticky top-0 z-30 border-b"
      >
        <div
          data-slot="platform-topbar-row"
          className="mx-auto flex min-h-14 w-full min-w-0 max-w-[1320px] flex-wrap items-center gap-x-4 px-4 max-lg:pt-2 sm:px-6"
        >
          <Link
            href="/platform"
            className="order-1 inline-flex h-10 shrink-0 items-center gap-2.5 rounded-md font-display text-[15px] font-semibold tracking-[-0.01em]"
          >
            <span
              aria-hidden
              className="bg-foreground text-background inline-grid size-[22px] place-items-center rounded-[5px] text-[13px] font-semibold"
            >
              S
            </span>
            <span>
              StockPilot <span className="text-muted-foreground">/ Platform</span>
            </span>
          </Link>
          <PlatformNav className="order-3 basis-full max-lg:pb-2 lg:order-2 lg:flex-1 lg:basis-auto" />
          <div className="order-2 ml-auto flex min-w-0 items-center gap-3 lg:order-3">
            <span className="text-muted-foreground hidden min-w-0 truncate text-[12.5px] sm:inline">
              {session.email}
            </span>
            <Link
              href="/dashboard"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}
            >
              ← My workspace
            </Link>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
