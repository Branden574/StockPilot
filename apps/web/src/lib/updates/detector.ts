/**
 * PURE update detection: given the build this tab is running and the build
 * production is serving, what should the tab believe? No fetch, no DOM, no
 * clock, so every case below is a unit test.
 *
 * A DEPLOYMENT is not a RELEASE. This file knows only about deployments
 * ("does this tab need a refresh?"). Whether there is anything worth reading
 * is a separate question answered from the reader's release state.
 *
 * Builds are compared for EQUALITY, and ordered only by build time. Ids are
 * hashes: comparing them alphabetically, or treating "different" as "newer",
 * is how a rollback gets announced as a new version.
 */

export interface BuildIdentity {
  /** Opaque hash. '' = unknown (development, tests). */
  build: string;
  /** ISO instant the bundle was built, or null when unknown. */
  builtAt: string | null;
}

export type UpdateStatus =
  /** This tab runs what production serves. */
  | 'current'
  /** Production serves a build made AFTER this tab's. */
  | 'update_available'
  /** Production serves a build made BEFORE this tab's: a rollback. */
  | 'rolled_back'
  /** Cannot tell (no loaded identity, or nothing served yet). Stay silent. */
  | 'unknown';

function instant(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function compareBuilds(loaded: BuildIdentity, served: BuildIdentity | null): UpdateStatus {
  if (!loaded.build || !served || !served.build) return 'unknown';
  if (served.build === loaded.build) return 'current';
  const loadedAt = instant(loaded.builtAt);
  const servedAt = instant(served.builtAt);
  // Only a build we can PROVE is older counts as a rollback. With either time
  // missing (an older deployment that predates builtAt) assume forward motion,
  // which is what the previous notifier assumed for every change.
  if (loadedAt !== null && servedAt !== null && servedAt < loadedAt) return 'rolled_back';
  return 'update_available';
}

/** Does this tab have to reload to run what production serves? */
export function refreshRequired(status: UpdateStatus): boolean {
  return status === 'update_available' || status === 'rolled_back';
}

/**
 * Parse GET /api/version leniently. Old deployments answer `{ build }` only,
 * newer ones add fields, and a proxy error page answers HTML: anything that is
 * not a usable build is null, never a throw.
 */
export interface ServedVersion extends BuildIdentity {
  /** Opaque: changes when the served release registry does. Null when absent. */
  releasesKey: string | null;
}

export function parseServedVersion(json: unknown): ServedVersion | null {
  if (json === null || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (typeof o.build !== 'string' || o.build.length === 0) return null;
  return {
    build: o.build,
    builtAt: typeof o.builtAt === 'string' && o.builtAt.length > 0 ? o.builtAt : null,
    releasesKey:
      typeof o.releasesKey === 'string' && o.releasesKey.length > 0 ? o.releasesKey : null,
  };
}
