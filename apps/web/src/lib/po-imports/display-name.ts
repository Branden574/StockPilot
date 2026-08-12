import { PO_IMPORT_DISPLAY_NAME_MAX, stripUnsafeDisplayNameChars } from '@stockpilot/core';

/**
 * Turns an uploaded FILENAME into a first-draft human name for the "PO name"
 * field on the upload form. A suggestion only — the field stays fully editable,
 * and the real uploaded file is never renamed by any of this.
 *
 * `Aug_2026-DC4__book   order.final.pdf` → `Aug 2026 DC4 book order.final`
 *
 *   • the LAST extension is dropped (only the last: `.final.pdf` keeps
 *     `.final`, because that is a word the user typed, not a file type);
 *   • underscores and hyphens become spaces, since that is what they stood in
 *     for in a filename;
 *   • control characters and bidi overrides are DROPPED, not carried through;
 *   • runs of whitespace collapse and the ends are trimmed;
 *   • the result is clipped to the same ceiling the column enforces.
 *
 * That third rule is the load-bearing one, and it is a rule about the SERVER,
 * not about tidiness: `optionalPoImportDisplayNameSchema` refuses those
 * characters, and on the upload form the refusal would land AFTER the file has
 * already been PUT to Storage — an orphaned object, and an error message about
 * characters the user cannot see in a field they never typed into. A suggestion
 * this function produces must always be a name the rules accept. (Text the user
 * types is a different case and is still REFUSED, never laundered.)
 *
 * Returns '' when there is nothing usable left (e.g. a dotfile) — the caller
 * then just shows the placeholder.
 */
export function prettifyFileNameForDisplay(fileName: string): string {
  const base = stripUnsafeDisplayNameChars(fileName).replace(/\.[^./\\]+$/, '');
  return base
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PO_IMPORT_DISPLAY_NAME_MAX);
}
