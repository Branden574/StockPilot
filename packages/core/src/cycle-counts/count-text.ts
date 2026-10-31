/**
 * The count a person typed into a cycle-count box: THE rule every count box
 * reads a box by, on the web count screen and on the phone (the count screen,
 * the AI shelf-scan review and the count scanner), so the same words record
 * the same count, or nothing, everywhere.
 *
 * A count is a plain number of zero or more: digits with at most one decimal
 * point ("5", "2.5", ".5", and "5." on the way to "5.5"). Spaces around it are
 * ignored. Anything else is not a count, and is never read as some other
 * number:
 *   - an empty box, a lone point, a lone minus sign;
 *   - a negative number ("-4");
 *   - a second point ("1.2.3") or a comma ("2,5"): the phone read these with
 *     parseFloat, so "1.2.3" saved 1.2 and "2,5" saved 2;
 *   - a sign, an exponent or another base ("+5", "1e3", "0x10"): Number()
 *     reads these as 5, 1000 and 16, and the web count screen saved them so.
 * A box that is not a count saves nothing; each screen then says so before it
 * posts (or confirms) anything, so a post never applies a number the box does
 * not show.
 *
 * The comma is not read as a decimal point, as the web count screen never
 * read it: an owner question (a phone set to a region that writes 2,5 shows a
 * comma on its decimal keypad).
 */
const PLAIN_COUNT = /^(?:\d+\.?\d*|\.\d+)$/;

/** The count a box holds, or null when it holds no count (see above). */
export function countFromText(raw: string): number | null {
  const text = raw.trim();
  if (!PLAIN_COUNT.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
