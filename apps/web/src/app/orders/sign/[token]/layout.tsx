import type { ReactNode } from 'react';

/**
 * Layout for the public order-signature surface (`/orders/sign/<token>`).
 * Deliberately bare — no dashboard chrome, no sidebar, no topbar. The
 * recipient hits this page from the QR code on the printed packing
 * slip, on a phone, at the loading dock. We render a clean, mobile-
 * first container and let the page content drive the experience.
 *
 * The root layout still wraps this in <html>/<body> + theme provider +
 * Toaster, so toasts surface and dark mode just works.
 */
export default function OrderSignLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background text-foreground min-h-screen">
      <main className="mx-auto w-full max-w-md px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>
      <footer className="text-muted-foreground mx-auto max-w-md px-4 pb-10 text-center text-[11px] sm:px-6">
        Powered by StockPilot
      </footer>
    </div>
  );
}
