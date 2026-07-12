import type { ReactNode } from 'react';

// P4: /r/<token> shares the internal storefront's design system.
// storefront.css scopes every rule under .sp-storefront and the sfp-*
// public additions under .sf-public, so neither affects /r/track or
// /r/confirm (which render no .sp-storefront wrapper).
import '@/components/orders/storefront/storefront.css';
import '@/components/orders/public-v2/public-orders.css';

/**
 * Layout for the public order-request surface (`/r/<token>` and
 * `/r/track`). Deliberately bare — no dashboard chrome, no sidebar, no
 * topbar. School principals and external partners hit these pages from
 * an emailed link on a phone, so we render a clean, mobile-first
 * container and keep the page content driving the experience.
 *
 * The root layout still wraps this in <html>/<body> + theme provider +
 * Toaster, so toasts surface and dark mode just works.
 */
export default function PublicOrderRequestLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Open the TLS connection to the book-cover CDN before the catalog
          markup references it, so covers (shipped in the initial payload)
          start downloading a round-trip sooner. Next hoists these into
          <head>. crossOrigin matches the <img> anonymous fetch. */}
      <link rel="preconnect" href="https://covers.openlibrary.org" crossOrigin="anonymous" />
      <link rel="dns-prefetch" href="https://covers.openlibrary.org" />
      {/* Wide enough for the storefront's two-column shell (catalog +
          372px request rail) on desktop; /r/track and /r/confirm keep
          their own max-w-md inner containers. */}
      <main className="mx-auto w-full max-w-[1480px] px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
      <footer className="text-muted-foreground mx-auto max-w-[1480px] px-4 pb-10 text-center text-[11px] sm:px-6">
        Powered by StockPilot
      </footer>
    </div>
  );
}
