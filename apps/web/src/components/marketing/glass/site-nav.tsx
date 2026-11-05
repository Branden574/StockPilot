import Link from 'next/link';

import { AppEntryLink } from './landing/app-entry-link';
import { SiteBrand } from './site-brand';
import { SITE_NAV, SIGN_IN_PATH, type SitePage } from './site-links';
import { SiteMenuButton, SiteMenuPanel, SiteMenuRoot } from './site-menu';
import { buttonClass } from './ui';

import { ThemeToggle } from '@/components/theme/theme-toggle';

/**
 * SiteNav.dc.html: the floating glass bar of the marketing twins. The brand,
 * five links (the page's own one marked current), the header appearance menu,
 * Contact the team, Sign in, and the phone menu below 900 px.
 *
 * Without JavaScript the head script never marks <html> as glass, so the twin
 * shows on classic CSS (plans/REVISION-DEFAULT.md R8, accepted): the utility
 * classes here keep that readable, the links wrap instead of folding into the
 * menu (whose button needs JavaScript and stays hidden), and every target is
 * still a plain link. The glass look is pages/site.css.
 *
 * The appearance menu stays on phones too (the board hides it under 900 px):
 * on a marketing page it is the one-tap way back to Classic (R13).
 *
 * The phone menu's panel is the nav's next sibling inside the navbar, as the
 * board draws it (`div.s-navbar > nav.s-nav + div#site-menu`): SiteMenuRoot
 * is the navbar element and holds the open state for the button in the nav's
 * right-hand row and the panel after the nav.
 */
export function SiteNav({ active }: { active: SitePage }) {
  return (
    <SiteMenuRoot className="lgs-navbar relative z-30 px-3 pt-3 sm:px-6 sm:pt-4">
      <nav
        aria-label="Primary"
        className="lgs-nav mx-auto flex min-h-14 max-w-[1180px] flex-wrap items-center gap-1.5 py-1 pl-4 pr-2"
      >
        <SiteBrand maskId="lgs-nav-mark" />
        <div className="lgs-links ml-5 flex flex-wrap items-center gap-0.5">
          {SITE_NAV.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={link.page === active ? 'page' : undefined}
              className="lgs-link inline-flex h-9 items-center rounded-[10px] px-3 text-sm font-medium"
            >
              {link.label}
            </Link>
          ))}
        </div>
        <div className="lgs-right ml-auto flex items-center gap-1.5">
          <ThemeToggle className="lgs-appearance rounded-full" />
          <Link
            href="/contact"
            aria-current={active === 'contact' ? 'page' : undefined}
            className={`${buttonClass('ghost')} lgs-hide-sm`}
          >
            Contact the team
          </Link>
          {/* A plain anchor: entering the app is a whole-document load. On the
              landing it sends the classic landing nav's analytics event. */}
          {active === 'home' ? (
            <AppEntryLink href={SIGN_IN_PATH} where="nav-signin" className={buttonClass('primary')}>
              Sign in
            </AppEntryLink>
          ) : (
            <a href={SIGN_IN_PATH} className={buttonClass('primary')}>
              Sign in
            </a>
          )}
          <SiteMenuButton />
        </div>
      </nav>
      <SiteMenuPanel links={SITE_NAV} active={active} />
    </SiteMenuRoot>
  );
}
