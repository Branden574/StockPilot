import type { ReactNode } from 'react';

import { ExternalFooter } from '@/components/auth/external-shell';

// P4: /r/<token> shares the internal storefront's design system.
// storefront.css scopes every rule under .sp-storefront and the sfp-*
// public additions under .sf-public, so neither affects /r/track or
// /r/confirm (which render no .sp-storefront wrapper). The order matters:
// public-orders.css is an override layer on the storefront base (redesign
// P5.1 step B), so it is imported second.
import '@/components/orders/storefront/storefront.css';
import '@/components/orders/public-v2/public-orders.css';

/**
 * Layout for the public order-request surface (`/r/<token>`, `/r/track`
 * and `/r/confirm`). Deliberately bare — no dashboard chrome, no sidebar, no
 * topbar. School principals and external partners hit these pages from
 * an emailed link on a phone, so we render a clean, mobile-first
 * container and keep the page content driving the experience.
 *
 * The root layout still wraps this in <html>/<body> + theme provider +
 * Toaster, so toasts surface and dark mode just works.
 */
export default function PublicOrderRequestLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background text-foreground min-h-screen">
      {/* Open the TLS connection to the book-cover CDN before the catalog
          markup references it, so covers (shipped in the initial payload)
          start downloading a round-trip sooner. Next hoists these into
          <head>. crossOrigin matches the <img> anonymous fetch. */}
      <link rel="preconnect" href="https://covers.openlibrary.org" crossOrigin="anonymous" />
      <link rel="dns-prefetch" href="https://covers.openlibrary.org" />
      {/* The redesign's content width (1320 px, as the New order page):
          the storefront's two-column shell (catalog + 372px request rail)
          from 1281 px; /r/track and /r/confirm keep their own md column
          (the ExternalShell column). */}
      <main className="mx-auto w-full max-w-[1320px] px-4 py-8 sm:px-6 sm:py-10">{children}</main>
      <ExternalFooter className="max-w-[1320px]" />
    </div>
  );
}
