'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { requestBootSplash } from '@/lib/boot-handoff';

/**
 * An app-entry CTA (→ /signin). Uses a plain anchor (a full navigation) so the
 * root-layout <BootSplash> re-mounts at the destination and plays once, and arms
 * it via requestBootSplash() just before navigating. Use anywhere a marketing
 * surface links into the app so the branded entry is consistent.
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
      <a href={href} onClick={requestBootSplash}>
        {children}
      </a>
    </Button>
  );
}
