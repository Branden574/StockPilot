/**
 * The text of a New Item section heading, from its React children.
 *
 * A heading written around an interpolation, `{sportsProfileLabel} VARIANT`,
 * arrives as an ARRAY of children (['SHOES', ' VARIANT']). `String()` of an
 * array joins with commas, so the phone showed and VoiceOver read
 * "SHOES, VARIANT". This joins the pieces the way React would render them:
 * strings and numbers as they are, null / undefined / booleans as nothing,
 * nested arrays flattened.
 */
export function sectionLabelText(children: unknown): string {
  if (children == null || typeof children === 'boolean') return '';
  if (Array.isArray(children)) return children.map(sectionLabelText).join('');
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  return '';
}
