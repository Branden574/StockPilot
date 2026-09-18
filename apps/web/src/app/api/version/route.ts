import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import { LOADED_BUILD, LOADED_BUILT_AT } from '@/lib/build-info';
import { registryFingerprint } from '@/lib/releases/logic';
import { RELEASES } from '@/lib/releases/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stable per-process fallback. In dev (where no build identity is baked in) this
 * stays the same for the life of the dev server, so a client's "version changed"
 * check doesn't fire on every poll.
 */
const FALLBACK_BUILD_ID = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * "Which build is production serving right now?" Whichever deployment holds the
 * production alias answers this, so the value changes when a deployment is
 * PROMOTED (or rolled back), not when a build merely succeeds, and a preview
 * deployment only ever answers for its own URL.
 *
 * `build` is the identity baked into this deployment at build time
 * (lib/build-info.ts, next.config.ts "Build identity"): the SAME constant the
 * client bundle of this deployment carries, so a tab and the deployment that
 * served it can never disagree with each other. It is an opaque hash; the raw
 * git SHA used to ship here, which let unauthenticated callers pin the exact
 * commit deployed and narrow the diff window for source recon.
 *
 * THE SHAPE IS ADDITIVE, FOREVER. Tabs still running the previous notifier poll
 * this and read `build` alone; renaming or removing it would silently stop their
 * update prompts. New fields:
 *   builtAt  orders builds (ids cannot): a served build older than the loaded
 *            one is a rollback, not a new version.
 *   env      production | preview | development, for diagnostics.
 *   releasesKey  an opaque hash of this deployment's release registry. It
 *            changes when a release is published, re-announced or withdrawn,
 *            and says nothing else: no slug, no revision, no audience. Release
 *            TEXT is per-reader and lives behind auth at /api/v1/me/releases; a
 *            tab uses the key to know its list is stale without polling that.
 */
function servedBuild(): string {
  if (LOADED_BUILD) return LOADED_BUILD;
  const raw = process.env.NEXT_PUBLIC_BUILD_ID ?? FALLBACK_BUILD_ID;
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

function releasesKey(): string | null {
  const fingerprint = registryFingerprint(RELEASES);
  return fingerprint ? createHash('sha256').update(fingerprint).digest('hex').slice(0, 12) : null;
}

export async function GET() {
  return NextResponse.json(
    {
      build: servedBuild(),
      builtAt: LOADED_BUILT_AT || null,
      env: process.env.VERCEL_ENV ?? 'development',
      releasesKey: releasesKey(),
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } },
  );
}
