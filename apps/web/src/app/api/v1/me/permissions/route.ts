// apps/web/src/app/api/v1/me/permissions/route.ts
import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns the caller's EFFECTIVE permission set for the active org — static
 * role defaults with org role/user overrides applied (mig 0207). The mobile
 * app uses this to gate its drawer nav (so a revoked permission hides its link)
 * the same way the web sidebar does via ctx.permissions. Honors the
 * X-Organization-Id header through withApiContext.
 *
 * Never the static role permissions (docket S19). withApiContext always sets
 * the effective set, and refuses the request when it cannot read it. A context
 * without one is refused the same way, as a 5xx the phone retries while it
 * keeps its last good set: the role's defaults would hand back every
 * permission the organization took away, and a platform-managed key
 * StockPilot may have denied this member.
 */
export async function GET(req: Request): Promise<Response> {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!ctx.permissions) throw new PermissionsUnavailableError();

  return NextResponse.json(
    { role: ctx.role, permissions: [...ctx.permissions] },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
