'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * The scrollytelling homepage brings its own integrated nav + footer, so the
 * shared marketing header/footer are suppressed on `/` only. Every other
 * marketing page (pricing, privacy, support…) keeps the standard chrome.
 */
export function HideOnHome({ children }: { children: ReactNode }) {
  return usePathname() === '/' ? null : <>{children}</>;
}
