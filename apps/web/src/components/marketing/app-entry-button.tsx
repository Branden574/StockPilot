'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';

/**
 * An app-entry CTA (→ /signin). Uses a plain anchor (a full navigation) rather
 * than a client route so entering the app is a clean document load. Use anywhere
 * a marketing surface links into the app.
 */
export function AppEntryButton({
  children,
  variant,
  size = 'lg',
  className,
  href = '/signin',
}: {
  children: React.ReactNode;
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
  className?: string;
  href?: string;
}) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <a href={href}>
        {children}
      </a>
    </Button>
  );
}
