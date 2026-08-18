'use client';

import * as React from 'react';

import { BrandGlyph, Wordmark } from './brand';

import { ThemeToggle } from '@/components/theme/theme-toggle';
import { capture } from '@/lib/analytics';

/**
 * The landing navigation — an opaque chrome plate, present and measurable at
 * first paint.
 *
 * THIS COMPONENT CARRIES THE LOADING INTRO'S CONTRACT. Four things are load
 * bearing and none of them fail loudly:
 *
 *  1. `id="sp-nav"` with a `.brand` child. The intro queries `'#sp-nav .brand'`
 *     ONCE, when it flips to running, and measures its rect to fly the mark
 *     home. Rename the id, move the brand out, or mount it late and the flight
 *     silently degrades to a plain fade — nothing logs.
 *  2. This nav must render INSIDE `#sp-landing`. The intro adds
 *     `.li-brand-hidden` to whatever matches `#sp-nav .brand`, but the CSS that
 *     actually hides it is scoped `#sp-landing .brand.li-brand-hidden`. Break
 *     the outer scope and both logos show at once through the whole intro.
 *  3. The glyph comes FIRST, and `.brand` carries no left padding. The flight
 *     aligns LEFT EDGES (`transform-origin: left center`), so putting the
 *     wordmark first moves the landing point.
 *  4. It is server-rendered. The E2E suite asserts `#sp-nav .brand` is visible
 *     with JavaScript disabled, so nothing here may be gated behind a mounted
 *     flag. `scrolled` only ever ADDS a hairline — it never changes layout.
 *
 * Deliberately NOT transparent-over-hero-then-fill: that pattern forces a brand
 * colour inversion during exactly the window the intro lands its mark in, and
 * makes the header's appearance depend on image decode timing.
 */

/** Only real destinations. Every one of these routes exists. */
const NAV = [
  { href: '#flow', label: 'How it works' },
  { href: '#modules', label: 'Product' },
  { href: '#compare', label: 'Compare' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/support', label: 'Support' },
];

/**
 * The canonical app entry. `/dashboard` is deliberate, not `/signin`:
 *  - signed in  → the dashboard, with gates A–D enforced at the destination by
 *                 `(dashboard)/layout.tsx` + `requireOrgContext()`, so this can
 *                 never be a shortcut past onboarding, MFA or a disabled account
 *  - anonymous  → the proxy rewrites to `/signin?redirect=/dashboard`, and the
 *                 sign-in form continues there afterwards
 * That is server-side and flash-free, and it costs `/` nothing: the landing
 * stays outside the proxy matcher and stays statically rendered.
 */
export const APP_ENTRY = '/dashboard';
export const SIGN_IN = '/signin';

export function LandingNav() {
  const [scrolled, setScrolled] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close the sheet on Escape — the menu is the only focus-trapping surface here.
  React.useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const onEnter = (where: string) => () => capture('landing_app_entry_clicked', { where });

  return (
    <>
      <header className={`sp-nav${scrolled ? ' scrolled' : ''}`} id="sp-nav">
        {/* Glyph first, no padding before it — the intro lands on this rect. */}
        <a className="brand" href="#top" aria-label="StockPilot home">
          <BrandGlyph />
          <Wordmark />
        </a>

        <nav className="nav-links" aria-label="Primary">
          {NAV.map((n) => (
            <a key={n.href} href={n.href}>
              {n.label}
            </a>
          ))}
        </nav>

        <div className="nav-right">
          <span className="nav-status" aria-hidden>
            <span className="live" />
            Operational
          </span>
          <span className="nav-theme">
            <ThemeToggle />
          </span>
          <a className="nav-signin" href={SIGN_IN} onClick={onEnter('nav-signin')}>
            Sign in
          </a>
          <a className="nav-cta" href={APP_ENTRY} onClick={onEnter('nav-open-app')}>
            Open app
          </a>
          <button
            className="menu-btn"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="sp-mobile-menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M3 7h18M3 12h18M3 17h18" />}
            </svg>
          </button>
        </div>
      </header>

      {/* A numbered manifest, not a list of links — it reads as a directory of
          the operation rather than a shrunken desktop nav. */}
      {menuOpen ? (
        <div className="mobile-menu" id="sp-mobile-menu">
          <ol>
            {NAV.map((n, i) => (
              <li key={n.href}>
                <a href={n.href} onClick={() => setMenuOpen(false)}>
                  <span className="mm-i mono">{String(i + 1).padStart(2, '0')}</span>
                  {n.label}
                  <span className="mm-arrow" aria-hidden>
                    →
                  </span>
                </a>
              </li>
            ))}
          </ol>
          <div className="mm-foot">
            <span className="mm-rule mono">Account</span>
            <a className="mm-signin" href={SIGN_IN} onClick={onEnter('menu-signin')}>
              Sign in
            </a>
            <a className="mm-cta" href={APP_ENTRY} onClick={onEnter('menu-open-app')}>
              Open app
            </a>
          </div>
        </div>
      ) : null}
    </>
  );
}
