import type { ReactNode } from 'react';

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
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>
      <footer className="text-muted-foreground mx-auto max-w-3xl px-4 pb-10 text-center text-[11px] sm:px-6">
        Powered by StockPilot
      </footer>
    </div>
  );
}
