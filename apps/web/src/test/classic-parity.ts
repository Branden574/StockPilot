/**
 * The classic-output proof for a Liquid Glass restructure, in the unit suite
 * (stockpilot-work/liquid-glass/IMPLEMENTATION-PLAN.md 4.6 and 4.7 item 3;
 * DECISIONS.md "PROOF NORMALISATION").
 *
 * A page that glass composes differently (an M2 page) first gets its hooks in
 * a commit that must change no classic output. These helpers render the same
 * tree with the same data before and after that commit and compare its markup
 * with every inert hook removed, exactly as the lab's parity run normalises
 * the page:
 *  - the inert hook attributes data-glass, any data-glass-*, data-classic-only
 *    and data-appearance-exempt are stripped (they change no pixel, computed
 *    style or accessibility node);
 *  - [data-glass-only] elements are removed (under the `off` rollout none may
 *    be rendered at all: glassOnlyElements() must then be empty);
 *  - React's useId values become stable tokens in order of appearance, so a
 *    hook that renders one more id earlier in the tree does not renumber the
 *    rest.
 * Nothing else is normalised: classes, text, order, other attributes and the
 * element tree must be byte-identical.
 */

/** The attributes the proof strips: inert hooks that no classic CSS selects. */
export const INERT_HOOK_ATTRIBUTE = /^data-(?:glass(?:-[\w-]+)?|classic-only|appearance-exempt)$/u;

/** React useId values in every form React 19 writes them («r1», :r1:, _r_1_), alone or inside an id. */
const USE_ID = /«[rR][\w]*»|:[rR][\w]*:|_[rR]_[\w]*?_/gu;

/** The glass-only elements under a root (none may exist under the `off` rollout). */
export function glassOnlyElements(root: ParentNode): Element[] {
  return [...root.querySelectorAll('[data-glass-only]')];
}

/** The root's markup with the inert hooks stripped, glass-only elements removed and ids tokenised. */
export function classicMarkup(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  for (const el of glassOnlyElements(clone)) el.remove();
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const name of el.getAttributeNames()) {
      if (INERT_HOOK_ATTRIBUTE.test(name)) el.removeAttribute(name);
    }
  }
  const ids = new Map<string, string>();
  const html = clone.outerHTML.replace(USE_ID, (id) => {
    if (!ids.has(id)) ids.set(id, `«id${ids.size}»`);
    return ids.get(id)!;
  });
  // One tag per line, so a failing comparison names the element that moved.
  return html.replace(/></gu, '>\n<');
}
