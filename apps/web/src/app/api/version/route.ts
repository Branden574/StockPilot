import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stable per-process fallback. In dev (where neither Vercel env var is
 * present) this stays the same for the life of the dev server, so the
 * client's "version changed" check doesn't fire on every poll.
 */
const FALLBACK_BUILD_ID = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function getBuildId(): string {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.NEXT_PUBLIC_BUILD_ID ??
    FALLBACK_BUILD_ID
  );
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
