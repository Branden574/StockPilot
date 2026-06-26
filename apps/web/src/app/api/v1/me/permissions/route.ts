// apps/web/src/app/api/v1/me/permissions/route.ts
import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';

import { ROLE_PERMISSIONS } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns the caller's EFFECTIVE permission set for the active org — static
 * role defaults with org role/user overrides applied (mig 0207). The mobile
 * app uses this to gate its drawer nav (so a revoked permission hides its link)
 * the same way the web sidebar does via ctx.permissions. Honors the
 * X-Organization-Id header through withApiContext.
 *
 * Falls back to the static role permissions if ctx.permissions is somehow unset
 * (withApiContext loads them fail-safe, so this is belt-and-suspenders).
 */
export async function GET(req: Request): Promise<Response> {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const permissions = ctx.permissions
    ? [...ctx.permissions]
    : [...ROLE_PERMISSIONS[ctx.role]];

  return NextResponse.json(
    { role: ctx.role, permissions },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
