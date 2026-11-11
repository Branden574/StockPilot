import Link from 'next/link';
import type { ReactNode } from 'react';

import { AuthStage } from '@/components/auth/auth-stage';
import { liquidGlassRollout } from '@/components/theme/appearance-flag';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { IconMark } from '@/components/ui/icon-mark';
import './auth.css';
// Liquid Glass's restyling of this shell: unlayered like auth.css, so it comes right after it.
import '@/styles/liquid-glass/auth.glass.css';

/**
 * The authentication shell — shared by /signin, /signin/mfa, /signup, /reset,
 * /reset/complete and /account-disabled. Every one of them gets the same
 * composition, so there is no point in the flow where a user drops from a
 * premium screen onto a bare one.
 *
 * DESKTOP is a split: a live StockPilot operation on a flat inset surface on
 * the left (the redesign draws no gradient ground), the form on the right.
 * TABLET narrows the visual side. MOBILE drops the split entirely — a
 * squeezed split-screen at 390px serves nobody, so the phone gets a compact
 * branded header and then the form, immediately.
 *
 * THE FORM IS NEVER BLOCKED BY THE DECORATION. The visual column is `aria-hidden`
 * and renders independently; nothing in the form waits on it. It also loads no
 * media at all — no canvas, no video, no image, and none of the landing page's
 * frame sequence.
 *
 * The branded landing intro deliberately does NOT run here. It belongs to `/`.
 * Someone signing in for the third time today should not watch a title sequence.
 *
 * LIQUID GLASS (Auth-SignIn.dc.html, Auth-States.dc.html): the same markup,
 * restyled by styles/liquid-glass/auth.glass.css (unlayered, right after
 * auth.css) into one column on the scene, plus two glass-only links the board
 * draws: "Contact the team" in the top bar and "Security" with the help links.
 * Both open public pages (no data, no permission gate), exist only in glass
 * (`data-glass-only`, hidden in classic by styles/liquid-glass/visibility.css)
 * and are not rendered at all under the `off` rollout, so the classic shell is
 * today's markup (auth-layout.classic-parity.test.tsx). They are listed in
 * tests/e2e/appearance/glass-only-allowlist.json. The Security link sits in a
 * glass-only span because auth.css styles every help link (`nav a`,
 * unlayered) with a display a layered rule could not hide.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  const glass = liquidGlassRollout() !== 'off';
  const panelBrand = (
    <Link href="/" aria-label="StockPilot home" className="auth-panel-brand">
      <IconMark />
    </Link>
  );
  return (
    <div className="auth-shell">
      {/* Visual column — desktop and tablet only. */}
      <aside className="auth-visual">
        <div className="auth-visual-inner">
          <Link href="/" aria-label="StockPilot home" className="auth-visual-brand">
            <IconMark />
          </Link>
          <AuthStage />
        </div>
      </aside>

      {/* Form column. */}
      <div className="auth-panel">
        {/* Glass's top bar adds the glass-only Contact the team link. Under
            `off` the bar is today's element exactly: a `{glass ? link :
            null}` child would leave a null in its children, and so in the
            static page's React payload, that today's page does not have. */}
        {glass ? (
          <header className="auth-panel-head">
            {panelBrand}
            <ThemeToggle />
            <Link href="/contact" data-glass-only="" className="auth-glass-contact">
              Contact the team
            </Link>
          </header>
        ) : (
          <header className="auth-panel-head">
            {panelBrand}
            <ThemeToggle />
          </header>
        )}

        <main className="auth-panel-main">
          <div className="auth-panel-col">{children}</div>
        </main>

        <footer className="auth-panel-foot">
          <p>StockPilot is an invite-only inventory system.</p>
          {/* Someone who cannot get in needs to know whether it is them or us. */}
          {/* Glass adds the glass-only Security link; under `off` the list is
              today's element exactly, as the top bar above. */}
          {glass ? (
            <nav aria-label="Help">
              <Link href="/support">Support</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
              <span data-glass-only="" className="auth-glass-help">
                <Link href="/security">Security</Link>
              </span>
            </nav>
          ) : (
            <nav aria-label="Help">
              <Link href="/support">Support</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
            </nav>
          )}
        </footer>
      </div>
    </div>
  );
}
