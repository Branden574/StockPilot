'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';

import { isGlassShowing, noteGlassCrash } from './appearance-cookie';
import { isLiquidGlassEnabled } from './appearance-flag';
import { isLiquidGlassStored, switchToClassicOnThisDevice } from './appearance-recovery-plain';

/** The stored appearance does not change while an error page shows. */
const subscribeToNothing = () => () => {};

/**
 * "Use classic appearance" in an error boundary (Liquid Glass plan 5.6). A
 * Reload alone does not get a person out of a glass layer that throws, because
 * the reload comes straight back into glass, so every error boundary renders
 * this next to its own actions.
 *
 * It renders NOTHING in the classic appearances (and on the server and the
 * first client render), so a classic error page is unchanged. After mount,
 * when Liquid Glass is selected on this device (and this build offers it):
 *   - it records the one-time crash fallback if glass was on screen, so the
 *     next load in this tab is classic, with a notice, while the stored
 *     choice stays as it is (appearance-cookie.ts noteGlassCrash);
 *   - it offers the button, which returns this device to the person's last
 *     classic choice for good and reloads.
 */
export function AppearanceRecovery({
  size,
  variant = 'outline',
}: {
  size?: 'sm' | 'default';
  variant?: 'outline' | 'ghost';
}) {
  // Read after hydration only: the server and the first client render say
  // false, so a classic error page is byte-for-byte what it was.
  const offered = React.useSyncExternalStore(
    subscribeToNothing,
    () => isLiquidGlassEnabled() && (isGlassShowing() || isLiquidGlassStored()),
    () => false,
  );

  React.useEffect(() => {
    if (isLiquidGlassEnabled()) noteGlassCrash();
  }, []);

  if (!offered) return null;
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={() => {
        switchToClassicOnThisDevice();
        window.location.reload();
      }}
    >
      Use classic appearance
    </Button>
  );
}
