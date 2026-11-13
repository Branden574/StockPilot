/**
 * KITS THE SERVER LISTS AS ACTIVE BUT THE PHONE LACKS (S75).
 *
 * The snapshot sends kits changed since the phone's cursor, beside the
 * complete list of active kit ids (`activeBundleIds`), and the pull deletes
 * every cached kit that list does not name (sync.ts). It never fetched a kit
 * it lacked. A pull that carries no kits (a member not allowed to see them,
 * or the bundles module off: the server sends empty lists) empties the
 * phone's kits, and once access returns, the delta pulls bring only kits
 * edited since the cursor: an unchanged kit stayed missing until a full pull
 * (a workspace switch, a reinstall).
 *
 * So after a pull's upserts, a list that names a kit the phone does not hold
 * makes the NEXT pull a full one. Once: the ids are remembered with the
 * request, and a full pull that still leaves some missing (the server names a
 * kit it never sends) is reported and remembered, so the same ids never ask
 * for another full pull. Only a delta that names a kit not already remembered
 * asks again. Saved under BUNDLE_REFILL_META_KEY with the pull's rows.
 *
 * The full pull is the last one asked for, whatever its answer says about
 * kits: an answer with no active list at all (an older server, a failed read
 * of the list) ends the request too, and keeps the ids already remembered, so
 * a kit still missing after it asks for no second full pull until the
 * missing set changes. No answer the server can give makes every pull a full
 * one. The answer for a member who may not see kits (no kits, an empty
 * active list) names nothing missing, so it never asks, and ends a request.
 *
 * Cycle counts need none of this: the snapshot reads open counts with no
 * cursor (apps/web/src/app/api/v1/mobile/snapshot/route.ts, the counts read),
 * so every pull carries the complete open list and the pull upserts all of
 * it (sync.ts, the counts block).
 *
 * Pure: no device store, no network; tested in bundle-refill.test.ts and
 * through the pull in sync.snapshot-removals.test.ts.
 */

export const BUNDLE_REFILL_META_KEY = 'bundles_refill';

export interface BundleRefillState {
  /** Active kit ids the phone lacked after the last pull that sent the list. */
  missing: string[];
  /** The next pull goes in full to fetch them. */
  fullPullOwed: boolean;
}

const NOTHING_MISSING: BundleRefillState = { missing: [], fullPullOwed: false };

/** The saved state; nothing missing when absent or unreadable. */
export function parseBundleRefill(raw: string | null): BundleRefillState {
  if (raw == null) return NOTHING_MISSING;
  try {
    const v = JSON.parse(raw) as { missing?: unknown; fullPullOwed?: unknown };
    const missing = Array.isArray(v.missing)
      ? v.missing.filter((id): id is string => typeof id === 'string')
      : [];
    return { missing, fullPullOwed: v.fullPullOwed === true };
  } catch {
    return NOTHING_MISSING;
  }
}

export function serializeBundleRefill(state: BundleRefillState): string {
  return JSON.stringify({ missing: state.missing, fullPullOwed: state.fullPullOwed });
}

/**
 * After a pull: what to remember, and, after a full pull, the ids it still
 * did not bring (to report), or null. `activeIds` is null when the answer
 * carried no active list.
 */
export function bundleRefillStep(input: {
  fullPull: boolean;
  activeIds: readonly string[] | null;
  cachedIds: ReadonlySet<string>;
  previous: BundleRefillState;
}): { next: BundleRefillState; stillMissing: string[] | null } {
  if (input.activeIds === null) {
    // Nothing said about kits: a full pull still ends the request, and the
    // ids remembered stay remembered; a delta changes nothing.
    return {
      next: input.fullPull ? { ...input.previous, fullPullOwed: false } : input.previous,
      stillMissing: null,
    };
  }
  const missing = [...new Set(input.activeIds.filter((id) => !input.cachedIds.has(id)))].sort();
  if (input.fullPull) {
    // A full pull sent every kit it could: what is still missing is reported
    // and remembered, and asks for no further full pull.
    return {
      next: { missing, fullPullOwed: false },
      stillMissing: missing.length > 0 ? missing : null,
    };
  }
  if (missing.length === 0) return { next: NOTHING_MISSING, stillMissing: null };
  const remembered = new Set(input.previous.missing);
  const anyNew = missing.some((id) => !remembered.has(id));
  return {
    next: { missing, fullPullOwed: anyNew || input.previous.fullPullOwed },
    stillMissing: null,
  };
}
