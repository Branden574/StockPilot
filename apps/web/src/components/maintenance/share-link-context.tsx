'use client';

import * as React from 'react';

/**
 * Session-local home of a freshly-generated /m/<token> share URL (mig 0330:
 * the token is hashed at rest, so the plaintext URL exists ONLY in the
 * server action's response and this client state — it is gone on reload and
 * never re-displayable).
 *
 * Two consumers on the maintenance detail page need the same fresh URL:
 * ShareLinkPanel (which generated it and offers Copy) and
 * MaintenanceEmailAction (which folds it into the Outlook/mailto draft
 * body). They are sibling client islands under a server component, so this
 * context is the seam between them. The default value is a no-op holder —
 * surfaces that mount MaintenanceEmailAction without the provider (the
 * post-create review screen) simply compose without a share URL, exactly
 * like an org with share links disabled.
 */
interface MaintenanceShareLinkContextValue {
  /** Plaintext URL generated THIS session, or null. */
  generatedUrl: string | null;
  setGeneratedUrl: (url: string | null) => void;
}

const MaintenanceShareLinkContext = React.createContext<MaintenanceShareLinkContextValue>({
  generatedUrl: null,
  setGeneratedUrl: () => undefined,
});

export function MaintenanceShareLinkProvider({ children }: { children: React.ReactNode }) {
  const [generatedUrl, setGeneratedUrl] = React.useState<string | null>(null);
  const value = React.useMemo(() => ({ generatedUrl, setGeneratedUrl }), [generatedUrl]);
  return (
    <MaintenanceShareLinkContext.Provider value={value}>
      {children}
    </MaintenanceShareLinkContext.Provider>
  );
}

export function useMaintenanceShareLink(): MaintenanceShareLinkContextValue {
  return React.useContext(MaintenanceShareLinkContext);
}
