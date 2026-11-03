'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';

import { isGlassShowing, noteGlassCrash } from './appearance-cookie';
import { isLiquidGlassEnabled } from './appearance-flag';
import { switchToClassicOnThisDevice } from './appearance-recovery-plain';

/** The attribute on <html> does not change while an error page shows. */
const subscribeToNothing = () => () => {};

/**
 * "Use classic design" in an error boundary (plan 5.6; plans/REVISION-
 * DEFAULT.md R13). A Reload alone does not get a person out of a glass layer
 * that throws, because the reload comes straight back into glass, so every
 * error boundary renders this next to its own actions.
 *
 * It is offered whenever Liquid Glass is SHOWN, read from the attribute on
 * <html> (isGlassShowing), so it follows the rollout's default, the person's
 * choice and the print route alike, and never appears in classic. It renders
 * NOTHING in classic, under the `off` rollout, on the server and on the first
 * client render, so a classic error page is unchanged. In glass:
 *   - it records the one-time crash fallback, so the next load in this tab is
 *     classic, with a notice, while the stored choice stays as it is
 *     (appearance-cookie.ts noteGlassCrash);
 *   - it offers the button, which sets the Design to Classic for good (the
 *     Theme is kept) and reloads.
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
    () => isLiquidGlassEnabled() && isGlassShowing(),
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
      Use classic design
    </Button>
  );
}
