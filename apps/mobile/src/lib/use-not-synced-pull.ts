import * as React from 'react';

import type { ScreenAccess } from './screen-access';
import { syncNow } from './sync';

/**
 * While a screen's access is 'not-synced' (screen-access.ts), the phone has
 * not pulled this workspace for this member yet. This asks for a sync once
 * each time the access becomes 'not-synced' (syncNow joins a pull already
 * out), and says whether it is still out, so the screen shows its spinner
 * meanwhile rather than a message. When the pull lands, the saved access is
 * read again (sync.ts) and the screen decides from it.
 */
export function useNotSyncedPull(access: ScreenAccess): boolean {
  const [out, setOut] = React.useState(false);
  React.useEffect(() => {
    if (access !== 'not-synced') return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the spinner while the sync asked for here is out; cleared after its await
    setOut(true);
    void syncNow().finally(() => {
      if (live) setOut(false);
    });
    return () => {
      live = false;
    };
  }, [access]);
  return access === 'not-synced' && out;
}
