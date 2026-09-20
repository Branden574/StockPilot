import { rmSync } from 'node:fs';

import { test as teardown } from '@playwright/test';

import { authStatePath, identityPath } from './paths';
import { endSavedSession } from './session';

/**
 * Ends the session the setup opened and deletes it from disk.
 *
 * A saved storage state is a live signed-in session for a real account. It is
 * needed for the length of a run and not a second longer. Playwright skips this
 * project when a run is interrupted, so auth.setup.ts also sweeps anything left
 * behind before it signs in again.
 */
teardown('sign out and delete the saved session', async () => {
  await endSavedSession(authStatePath());
  rmSync(identityPath(), { force: true });
});
