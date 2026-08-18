import Link from 'next/link';
import type { ReactNode } from 'react';

import { AuthStage } from '@/components/auth/auth-stage';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { IconMark } from '@/components/ui/icon-mark';

/**
 * The authentication shell — shared by /signin, /signin/mfa, /signup, /reset,
 * /reset/complete and /account-disabled. Every one of them gets the same
 * composition, so there is no point in the flow where a user drops from a
 * premium screen onto a bare one.
 *
 * DESKTOP is a cinematic split: a live StockPilot operation on the left, the
 * form on the right. TABLET narrows the visual side. MOBILE drops the split
 * entirely — a squeezed split-screen at 390px serves nobody, so the phone gets
 * a compact branded header and then the form, immediately.
 *
 * THE FORM IS NEVER BLOCKED BY THE DECORATION. The visual column is `aria-hidden`
 * and renders independently; nothing in the form waits on it. It also loads no
 * media at all — no canvas, no video, no image, and none of the landing page's
 * frame sequence.
 *
 * The branded landing intro deliberately does NOT run here. It belongs to `/`.
 * Someone signing in for the third time today should not watch a title sequence.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      {/* Visual column — desktop and tablet only. */}
      <aside className="auth-visual">
        <div aria-hidden className="auth-visual-ground" />
        <div className="auth-visual-inner">
          <Link href="/" aria-label="StockPilot home" className="auth-visual-brand">
            <IconMark />
          </Link>
          <AuthStage />
        </div>
      </aside>

      {/* Form column. */}
      <div className="auth-panel">
        <header className="auth-panel-head">
          <Link href="/" aria-label="StockPilot home" className="auth-panel-brand">
            <IconMark />
          </Link>
          <ThemeToggle />
        </header>

        <main className="auth-panel-main">
          <div className="auth-panel-col">{children}</div>
        </main>

        <footer className="auth-panel-foot">
          <p>StockPilot is an invite-only inventory system.</p>
          {/* Someone who cannot get in needs to know whether it is them or us. */}
          <nav aria-label="Help">
            <Link href="/support">Support</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </nav>
        </footer>
      </div>
    </div>
  );
}
