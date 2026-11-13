/**
 * The navigation of the Liquid Glass marketing twins (SiteNav.dc.html,
 * SiteFooter.dc.html). Plain data, no imports: the server nav, the client
 * phone menu and the footer read the same lists.
 *
 * Every target the classic marketing chrome links to is still here
 * (tests/e2e/appearance/twin-structure.spec.ts compares the sets): sign in,
 * contact, support, pricing and the legal links, /privacy#california included.
 * The landing's own sections are the glass landing's (#product, #workflow,
 * #mobile); the glass landing is a different page by design (plan 4.6 M3).
 */

/** Sign-in: a whole-document load, never a client route change (as the classic header). */
export const SIGN_IN_PATH = '/signin';

/**
 * The app entry the classic landing's "Open app" uses: signed in, the
 * dashboard; signed out, the proxy shows sign-in and returns there after
 * (components/marketing/landing/nav.tsx APP_ENTRY). Kept as a glass target so
 * the feature stays.
 */
export const APP_ENTRY_PATH = '/dashboard';

/** The page a twin is, so its link in the nav carries aria-current. */
export type SitePage =
  'home' | 'contact' | 'pricing' | 'privacy' | 'security' | 'support' | 'terms';

export interface SiteLink {
  label: string;
  href: string;
  /** The twin this link opens, for aria-current. */
  page?: SitePage;
  /** Load the whole document (sign-in), not a client route change. */
  document?: boolean;
}

/** SiteNav.dc.html's five links. */
export const SITE_NAV: readonly SiteLink[] = [
  { label: 'Product', href: '/#product' },
  { label: 'How it works', href: '/#workflow' },
  { label: 'Web & mobile', href: '/#mobile' },
  { label: 'Security', href: '/security', page: 'security' },
  { label: 'Support', href: '/support', page: 'support' },
];

/** SiteFooter.dc.html's three columns, with the classic footer's California link kept. */
export const SITE_FOOTER: readonly { label: string; links: readonly SiteLink[] }[] = [
  {
    label: 'Product',
    links: [
      { label: 'Inventory & books', href: '/#product' },
      { label: 'How it works', href: '/#workflow' },
      { label: 'Web & mobile', href: '/#mobile' },
      { label: 'Pricing', href: '/pricing', page: 'pricing' },
    ],
  },
  {
    label: 'Help',
    links: [
      { label: 'Support', href: '/support', page: 'support' },
      { label: 'Contact the team', href: '/contact', page: 'contact' },
      { label: 'Sign in', href: SIGN_IN_PATH, document: true },
    ],
  },
  {
    label: 'Trust',
    links: [
      { label: 'Security', href: '/security', page: 'security' },
      { label: 'Privacy', href: '/privacy', page: 'privacy' },
      { label: 'Terms', href: '/terms', page: 'terms' },
      { label: 'California privacy', href: '/privacy#california' },
    ],
  },
];

/** The phone menu's closing line (SiteNav.dc.html). */
export const INVITE_ONLY_NOTE =
  'StockPilot is invite-only. Use the link in your invitation email to join.';
