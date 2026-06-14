import 'server-only';

import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { getServerSession } from '@/lib/auth/session';
import { getActiveImpersonation } from '@/server/services/platform/impersonation';

import { StopActingAsButton } from './stop-acting-as-button';

/**
 * Loud, persistent banner shown across the dashboard while a platform admin is
 * acting as an org. Self-contained: does its own (service-role) check and
 * renders nothing for normal users — so it never touches the shared
 * org-context hot path. Placed once in the dashboard layout.
 */
export async function ImpersonationBanner() {
  const session = await getServerSession();
  if (!session || !isPlatformAdmin(session.email)) return null;

  const active = await getActiveImpersonation(session.userId);
  if (!active) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-[13px] text-amber-900 dark:text-amber-200">
      <span className="font-medium">
        ⚠ You are acting as another organization — you are viewing and editing their live data.
      </span>
      <StopActingAsButton />
    </div>
  );
}
