import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';

/**
 * Client crash beacon (cybersecurity monitoring Phase 1). The error
 * boundaries (app/error.tsx, app/global-error.tsx) fire-and-forget a POST
 * here so production CLIENT render crashes reach the same ERROR_WEBHOOK_URL
 * feed as server errors — previously they died in the user's console
 * (exactly how the 2026-06-02 orders-page crash stayed invisible).
 *
 * Abuse posture: authenticated users only (a public beacon is a spam
 * funnel), 10 reports/user/hour fail-OPEN (losing a crash signal is worse
 * than an extra webhook post), 2KB body cap, fields truncated server-side.
 * Always returns 204 — the boundary never cares.
 */
export async function POST(request: Request) {
  try {
    const ctx = await withApiContext(request);
    if (!ctx) return new NextResponse(null, { status: 204 });

    const rl = await checkRateLimit(`client-error:${ctx.userId}`, 10, 60 * 60 * 1000, 'open');
    if (!rl.allowed) return new NextResponse(null, { status: 204 });

    const raw = await request.text();
    if (raw.length > 2048) return new NextResponse(null, { status: 204 });
    const body = JSON.parse(raw) as {
      message?: unknown;
      digest?: unknown;
      path?: unknown;
      boundary?: unknown;
    };

    const s = (v: unknown, max: number) =>
      typeof v === 'string' ? v.slice(0, max) : undefined;

    void reportError(new Error(s(body.message, 500) ?? 'Client render error'), {
      tag: 'client.boundary',
      level: 'error',
      organizationId: ctx.organizationId,
      extra: {
        digest: s(body.digest, 100) ?? null,
        path: s(body.path, 200) ?? null,
        boundary: s(body.boundary, 40) ?? null,
      },
    });
  } catch {
    // Never let the beacon become its own error source.
  }
  return new NextResponse(null, { status: 204 });
}
