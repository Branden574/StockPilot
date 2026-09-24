import AsyncStorage from '@react-native-async-storage/async-storage';

import type { LiveScope } from './outbox-scope';
import { supabase } from './supabase';

/**
 * The workspace and account live on the device right now, read the same way
 * api() reads them for a request: the saved workspace (the key use-workspace.ts
 * writes and api.ts orgHeader() sends) and the current auth session.
 *
 * Read per outbox row, never cached: a workspace switch or a sign-out can land
 * between two rows of one drain. Any failure reads as "nobody" (userId null),
 * which holds every row instead of sending it under a guess.
 */
export const ACTIVE_ORG_STORAGE_KEY = 'workspace.activeOrgId';

export async function liveOutboxScope(): Promise<LiveScope> {
  const [orgId, userId] = await Promise.all([
    AsyncStorage.getItem(ACTIVE_ORG_STORAGE_KEY).catch(() => null),
    supabase.auth.getSession().then(
      ({ data }) => data.session?.user?.id ?? null,
      () => null,
    ),
  ]);
  return { orgId: orgId || null, userId };
}
