import 'server-only';

import { currentUserIsPlatformAdmin } from '@/lib/auth/platform-admin';
import { getServerSession } from '@/lib/auth/session';
import { getActiveImpersonation } from '@/server/services/platform/impersonation';

import { ImpersonationStrip } from './impersonation-strip';

/**
 * Loud, persistent banner shown across the dashboard while a platform admin is
 * acting as an org. Self-contained: does its own (service-role) check and
 * renders nothing for normal users — so it never touches the shared
 * org-context hot path. Placed once in the dashboard layout.
 */
export async function ImpersonationBanner() {
  const session = await getServerSession();
  if (!session || !(await currentUserIsPlatformAdmin())) return null;

  const active = await getActiveImpersonation(session.userId);
  if (!active) return null;

  return <ImpersonationStrip />;
}
