'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';

/**
 * Asks the server for the page again: `router.refresh()`, which re-runs every
 * server component on the current route (layouts included) for this URL,
 * search params and all. A link to the same URL is not a retry here: the
 * client router may serve a render up to 90 s old (next.config.ts staleTimes),
 * the very answer the person is retrying.
 *
 * While the new answer loads the icon spins and further presses are ignored.
 * The button is not disabled, so a keyboard user's focus stays on it; if the
 * read fails again, the same button is there to press.
 */
export function TryAgainButton({
  children = 'Try again',
  onClick,
  variant = 'outline',
  ...props
}: Omit<ButtonProps, 'asChild' | 'type'>) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      {...props}
      type="button"
      variant={variant}
      aria-disabled={pending || undefined}
      data-pending={pending ? 'true' : undefined}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || pending) return;
        startTransition(() => {
          router.refresh();
        });
      }}
    >
      {pending ? <Loader2 aria-hidden className="animate-spin" /> : <RefreshCw aria-hidden />}
      {children}
    </Button>
  );
}
