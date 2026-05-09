import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stable per-process fallback. In dev (where neither Vercel env var is
 * present) this stays the same for the life of the dev server, so the
 * client's "version changed" check doesn't fire on every poll.
 */
const FALLBACK_BUILD_ID = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Returns an opaque short hash of the deployment identifier. The raw
 * git SHA used to ship here, which let unauthenticated callers pin
 * the exact commit deployed and narrow the diff window for source
 * recon. Hashing makes it useful for the client's "did the deploy
 * change?" poll without leaking the upstream commit.
 */
function getBuildId(): string {
  const raw =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.NEXT_PUBLIC_BUILD_ID ??
    FALLBACK_BUILD_ID;
  // First 12 hex chars of sha256 — same shape as the previous SHA
  // prefix, but irreversible.
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

export async function GET() {
  return NextResponse.json(
    { build: getBuildId() },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    },
  );
}
