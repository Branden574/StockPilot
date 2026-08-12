import { normalizePoImportDisplayName } from '@stockpilot/core';

/**
 * Builds the `displayNames` field the PO scan endpoint expects.
 *
 * THE WIRE CONTRACT (authoritative copy lives in the POST header of
 * apps/web/src/app/api/po-imports/scan/route.ts — mig 0333):
 *
 *   • `displayNames` is ONE multipart field holding a JSON ARRAY of
 *     (string | null), index-aligned with the imports the request creates.
 *   • SEPARATE mode — one import per file, so exactly ONE ENTRY PER FILE, and
 *     entry[i] names file[i].
 *   • COMBINED mode — the files are pages of ONE purchase order, so exactly
 *     ONE entry, naming that single import.
 *   • Omitted entirely — every import is created unnamed. That is the
 *     old-client path and stays a success.
 *   • A length that does not match the import count is a 400, never a guess.
 *     So this helper never pads or truncates to "fix" a mismatch: it derives
 *     the length from the files that are ACTUALLY being sent.
 *
 * THE SHARP EDGE THIS EXISTS FOR: the scan screen DROPS frames whose resize
 * failed (see app/scan-po/index.tsx). The names the user typed are aligned with
 * the frames they CAPTURED, but the array on the wire must align with the files
 * actually UPLOADED. Sending the captured-order names after a middle frame was
 * dropped would slide every later name onto the wrong purchase order —
 * permanently, and looking exactly like the user's own typo. `sentIndices` is
 * therefore the post-drop list, and every entry is looked up THROUGH it.
 *
 * Names are validated SERVER-SIDE against the shared schema; the input's
 * maxLength is a courtesy. This helper only normalizes (trim, blank → null) via
 * the shared `normalizePoImportDisplayName`, so mobile cannot drift from the
 * rule the route and the DB CHECK enforce.
 */

/** The `mode` field value the request sends alongside the files. */
export type PoScanMode = 'separate' | 'combined';

export interface BuildDisplayNamesArgs {
  /**
   * What the user typed, INDEX-ALIGNED with the CAPTURED frames. Index 0 doubles
   * as the single combined-mode field, which is why it is read directly (and not
   * through `sentIndices`) when the request creates one merged import.
   */
  names: readonly (string | null | undefined)[];
  /**
   * Indices (into `names`) of the frames actually being uploaded, in wire order.
   * Post-drop: a frame that failed to resize is absent here.
   */
  sentIndices: readonly number[];
  /** The `mode` value this request sends. */
  mode: PoScanMode;
}

/**
 * Returns the array to JSON-encode into the `displayNames` field, or `null`
 * meaning OMIT THE FIELD ENTIRELY — which keeps an unnamed scan byte-identical
 * to the request this screen sent before naming existed.
 */
export function buildDisplayNames(args: BuildDisplayNamesArgs): (string | null)[] | null {
  const { names, sentIndices, mode } = args;

  // Nothing is being uploaded — there is no import to name.
  if (sentIndices.length === 0) return null;

  let entries: (string | null)[];
  if (mode === 'separate' && sentIndices.length >= 2) {
    // One import per uploaded file, named by ITS OWN frame.
    entries = sentIndices.map((i) => normalizePoImportDisplayName(names[i]));
  } else if (mode === 'separate') {
    // Asked for separate, but drops left a single file — the route downgrades
    // this to combined (`mode === 'separate' && files.length >= 2`), so exactly
    // one entry is expected. It must be the SURVIVING frame's name, never
    // names[0]: in separate mode every name belongs to a specific frame, and
    // reaching for index 0 when index 0 is the frame that got dropped is the
    // mis-association this module exists to prevent.
    entries = [normalizePoImportDisplayName(names[sentIndices[0]!])];
  } else {
    // Combined: the pages merge into ONE import, named by the single name
    // field, which is index 0 regardless of which frames survived.
    entries = [normalizePoImportDisplayName(names[0])];
  }

  // Every slot blank → send nothing at all rather than an array of nulls.
  return entries.some((e) => e !== null) ? entries : null;
}
