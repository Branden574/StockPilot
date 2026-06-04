import * as React from 'react';

/**
 * Cold-launch gate. While the branded ColdLaunchSplash is on screen, the
 * BiometricLockScreen (rendered UNDERNEATH the splash for a blank-frame-free
 * crossfade) must NOT auto-fire Face ID — otherwise the system prompt scans
 * behind the splash and is already done by the time it fades. The splash flips
 * `splashActive` to false at hand-off, which releases the lock's auto-prompt.
 *
 * Default `false` so a WARM re-lock (no splash) auto-prompts immediately, exactly
 * as before. Only the cold-launch path holds it true until hand-off.
 */
const ColdLaunchGateContext = React.createContext<{ splashActive: boolean }>({
  splashActive: false,
});

export function ColdLaunchGateProvider({
  splashActive,
  children,
}: {
  splashActive: boolean;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({ splashActive }), [splashActive]);
  return (
    <ColdLaunchGateContext.Provider value={value}>
      {children}
    </ColdLaunchGateContext.Provider>
  );
}

export function useColdLaunchGate(): { splashActive: boolean } {
  return React.useContext(ColdLaunchGateContext);
}
