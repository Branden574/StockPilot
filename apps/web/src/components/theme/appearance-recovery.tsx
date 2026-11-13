'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';

import { isGlassShowing, noteGlassCrash } from './appearance-cookie';
import { isLiquidGlassEnabled } from './appearance-flag';
import { useAppearanceActions } from './appearance-provider';
import { isServerRenderError, switchToClassicOnThisDevice } from './appearance-recovery-plain';

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
 *   - for an error thrown in the browser, it records the one-time crash
 *     fallback, so the next load in this tab is classic, with a notice, while
 *     the stored choice stays as it is (appearance-cookie.ts noteGlassCrash).
 *     A server render error (it carries a digest) does not: the server renders
 *     the same page in every design, so glass did not cause it, and under the
 *     `default` rollout holding the tab in classic would take the default away
 *     from everyone who hits a passing server error;
 *   - it offers the button, which sets the Design to Classic for good (the
 *     Theme is kept) and reloads. The Design is marked dirty for the account
 *     only when a page named the signed-in person to the provider; a leftover
 *     sync record is never taken for that (appearance-recovery-plain.ts).
 */
export function AppearanceRecovery({
  error,
  size,
  variant = 'outline',
}: {
  /** The boundary's error: a server render error never arms the crash fallback. */
  error?: unknown;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'ghost';
}) {
  // The actions only: this button shows nothing of the appearance, so it
  // never renders again for it.
  const appearance = useAppearanceActions();
  // Read after hydration only: the server and the first client render say
  // false, so a classic error page is byte-for-byte what it was.
  const offered = React.useSyncExternalStore(
    subscribeToNothing,
    () => isLiquidGlassEnabled() && isGlassShowing(),
    () => false,
  );

  const fromServer = isServerRenderError(error);
  React.useEffect(() => {
    if (isLiquidGlassEnabled() && !fromServer) noteGlassCrash();
  }, [fromServer]);

  if (!offered) return null;
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={() => {
        switchToClassicOnThisDevice(appearance?.signedInUserId() ?? null);
        window.location.reload();
      }}
    >
      Use classic design
    </Button>
  );
}
