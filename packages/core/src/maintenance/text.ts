/**
 * Client-safe plain-text sanitizers for maintenance email building.
 *
 * sanitizeSubjectLine is the collapsing variant (the toPlainTextLine
 * semantics from storefront-logic.ts:272-275): correct for SUBJECTS, where a
 * newline could forge a header-looking line.
 *
 * sanitizeDescriptionBlock is the NEW newline-PRESERVING variant (audit
 * Q14): the description's intentional line breaks are content (brief
 * section 7) and the collapsing variant would destroy them. C1 passthrough
 * is a documented scope boundary — every egress is percent-encoded.
 *
 * The control-character ranges below are built from `String.fromCharCode`
 * rather than written as backslash-u escape literals, so this file's source
 * bytes stay plain ASCII (no raw control bytes, no ambiguous escapes) while
 * the resulting regular expressions are identical to the C0 (0x00-0x1F) +
 * DEL (0x7F) ranges the brief specifies.
 *
 * Fix 2f: a tab (HT, 0x09) inside a description is a word separator, not
 * noise — `sanitizeSubjectLine` already SUBSTITUTES a space for every C0
 * character (including HT) via its collapse-to-space pass, so a subject's
 * tab was never a problem. `sanitizeDescriptionBlock` used to fall through
 * HT to the generic C0-deletion regex, which DELETED it outright, gluing
 * adjacent words together (`'plus\ttab'` -> `'plustab'`). HT is now replaced
 * with a single space FIRST, then excluded from the deletion range below so
 * it is never processed twice.
 */
const NUL = String.fromCharCode(0x00);
const US = String.fromCharCode(0x1f);
const BS = String.fromCharCode(0x08); // one before HT — HT is handled separately below
const HT = String.fromCharCode(0x09); // \t — the tab that sits inside C0
const VT = String.fromCharCode(0x0b); // one past LF (0x0A)
const DEL = String.fromCharCode(0x7f);

/** C0 (0x00-0x1F) + DEL, as one run — used to collapse subjects. */
const ALL_C0_AND_DEL = new RegExp(`[${NUL}-${US}${DEL}]+`, 'g');

/** Every tab, globally — replaced with a single space (Fix 2f), never
 *  deleted, so description words never glue together across a tab. */
const ALL_HT = new RegExp(HT, 'g');

/** C0 EXCEPT the newline (0x0A) and the tab (0x09, handled separately via
 *  `ALL_HT` above), plus DEL — used to strip descriptions without touching
 *  intentional line breaks or (post-substitution) tabs. */
const C0_EXCEPT_LF_HT_AND_DEL = new RegExp(`[${NUL}-${BS}${VT}-${US}${DEL}]`, 'g');

export function sanitizeSubjectLine(value: string): string {
  return value.replace(ALL_C0_AND_DEL, ' ').replace(/\s+/g, ' ').trim();
}

export function sanitizeDescriptionBlock(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(ALL_HT, ' ')
    .replace(C0_EXCEPT_LF_HT_AND_DEL, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
