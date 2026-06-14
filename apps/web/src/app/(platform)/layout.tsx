import Link from 'next/link';
import type { ReactNode } from 'react';

import { PlatformNav } from '@/components/platform/platform-nav';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';

/**
 * Platform Super-Admin Console shell. This layout is the single hard gate
 * for the entire `/platform` tree: `requirePlatformAdmin()` requires a
 * signed-in session + the email on the deploy-time allowlist + MFA at AAL2,
 * and 404s (not 403s) on any failure so the console's existence is never
 * revealed. Deliberately NOT nested under the org-scoped (dashboard) group.
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const session = await requirePlatformAdmin();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-4">
            <Link href="/platform" className="font-display text-[15px] font-semibold tracking-[-0.01em]">
              StockPilot <span className="text-[var(--ed-ink-4)]">/ Platform</span>
            </Link>
            <PlatformNav />
          </div>
          <div className="flex items-center gap-3 text-[12px] text-[var(--ed-ink-3)]">
            <span className="hidden sm:inline">{session.email}</span>
            <Link
              href="/dashboard"
              className="rounded-md border border-border px-2.5 py-1.5 font-medium hover:border-[var(--ed-line-strong)]"
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
