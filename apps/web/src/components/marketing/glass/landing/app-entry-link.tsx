'use client';

import type { ReactNode } from 'react';

import { APP_ENTRY_PATH } from '../site-links';

import { capture } from '@/lib/analytics';

/**
 * The glass landing's way into the app: /dashboard, as the classic landing's
 * "Open app" (components/marketing/landing/nav.tsx APP_ENTRY). Signed in, the
 * dashboard opens; signed out, the proxy shows sign-in and returns there
 * after. A plain anchor (a whole-document load, never a client route change),
 * and the same analytics event the classic landing sends, with its own
 * `where`. Landing.dc.html labels these "Sign in". The landing's nav passes
 * the sign-in page as `href`, as the classic landing's nav "Sign in" does
 * (where: "nav-signin").
 */
export function AppEntryLink({
  href = APP_ENTRY_PATH,
  where,
  className,
  children,
}: {
  href?: string;
  where: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={() => capture('landing_app_entry_clicked', { where })}
    >
      {children}
    </a>
  );
}
