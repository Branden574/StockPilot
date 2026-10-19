import type { ReactNode } from 'react';

import { ExternalShell } from '@/components/auth/external-shell';

/**
 * Layout for the public order-signature surface (`/orders/sign/<token>`).
 * Deliberately bare — no dashboard chrome, no sidebar, no topbar. The
 * recipient hits this page from the QR code on the printed packing
 * slip, on a phone, at the loading dock. The shared external frame gives a
 * clean, mobile-first column and the "Powered by StockPilot" line, and reads
 * no session.
 *
 * The root layout still wraps this in <html>/<body> + theme provider +
 * Toaster, so toasts surface and dark mode just works.
 */
export default function OrderSignLayout({ children }: { children: ReactNode }) {
  return (
    <ExternalShell width="md" poweredBy>
      {children}
    </ExternalShell>
  );
}
