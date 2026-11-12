/**
 * The classic DOM of a rendered tree, normalised the way the Liquid Glass
 * classic proof normalises a page (stockpilot-work/liquid-glass/baseline/
 * PROOF-FORMAT.md, N1-N8; DECISIONS.md "PROOF NORMALISATION DECIDED"), so a
 * unit test can show that a change to a page's code leaves its Classic
 * output exactly as it was:
 *
 *   - every [data-glass-only] element is dropped with its subtree (it does
 *     not exist in Classic: hidden there, and not rendered at all under the
 *     `off` rollout);
 *   - the inert hook attributes are dropped: data-glass and any data-glass-*
 *     (data-glass-variant, data-glass-size, data-glass-role, ...),
 *     data-classic-only and data-appearance-exempt (no CSS but the glass files
 *     reads them, and those only under :root[data-appearance="liquid-glass"]);
 *   - attributes are sorted by name; React useId values are numbered in order
 *     of first appearance (they follow render order, not output);
 *   - whitespace runs collapse to one space; comments are not written.
 *
 * One node per line, indented by depth, so a difference reads as a diff.
 */

const HOOK_ATTRIBUTE = /^(data-glass(-[\w-]+)?|data-classic-only|data-appearance-exempt)$/u;
/** React useId shapes: «r1», «R2», :r3:, _r_4_. */
const USE_ID = /«[rR][^»]*»|:[rR][0-9a-z]*:|_[rR]_[0-9a-z]+_/gu;

/** True for the attributes the proof drops (exported for its own test). */
export function isHookAttribute(name: string): boolean {
  return HOOK_ATTRIBUTE.test(name);
}

export function classicDom(root: Element): string {
  const ids = new Map<string, string>();
  const stable = (text: string) =>
    text.replace(USE_ID, (id) => {
      if (!ids.has(id)) ids.set(id, `«id${ids.size + 1}»`);
      return ids.get(id)!;
    });
  const lines: string[] = [];
  const walk = (node: Node, depth: number) => {
    const pad = '  '.repeat(depth);
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').replace(/\s+/gu, ' ');
      if (text.trim() === '') {
        if (lines[lines.length - 1] !== `${pad}␣`) lines.push(`${pad}␣`);
      } else {
        lines.push(`${pad}${JSON.stringify(stable(text))}`);
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (el.hasAttribute('data-glass-only')) return;
    const attrs = [...el.attributes]
      .filter((a) => !isHookAttribute(a.name))
      .map((a) => `${a.name}="${stable(a.value)}"`)
      .sort();
    lines.push(`${pad}<${el.tagName.toLowerCase()}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
    for (const child of el.childNodes) walk(child, depth + 1);
  };
  for (const child of root.childNodes) walk(child, 0);
  return `${lines.join('\n')}\n`;
}

/** The number of [data-glass-only] elements in a tree (none may render under `off`). */
export function glassOnlyCount(root: Element): number {
  return root.querySelectorAll('[data-glass-only]').length;
}

/**
 * The structural pseudo-classes a Classic rule can select by: the place of an
 * element among its siblings and whether it is empty (Tailwind's first:,
 * last:, only:, empty:, *-of-type: and the space-* and divide-* utilities,
 * which select :not(:last-child), are written with these).
 */
const STRUCTURAL = [
  ':first-child',
  ':last-child',
  ':only-child',
  ':first-of-type',
  ':last-of-type',
  ':only-of-type',
] as const;

/** :empty as browsers match it (no child but comments; text, even white space, counts).
 *  Computed here: happy-dom's :empty ignores text nodes. */
const isEmpty = (el: Element) => [...el.childNodes].every((n) => n.nodeType === 8);

/**
 * Where each element the classic proof keeps stands among its siblings, as
 * the browser sees it: the structural pseudo-classes it matches in the REAL
 * tree, glass-only elements included. classicDom() drops a glass-only element
 * before comparing, so it cannot see that a hidden glass-only sibling still
 * counts for :last-child (display:none changes no selector match): a
 * glass-only element added after a Classic element's last child takes that
 * child's :last-child, and with it any Classic rule written on it. Under
 * `off` no glass-only element renders, so the `off` structure is today's;
 * the `default` structure must be the same, element for element.
 *
 * One line per kept element: its path (tag and position among the kept
 * siblings, from the root) and the pseudo-classes it matches ("-" for none).
 */
export function classicStructure(root: Element): string {
  const lines: string[] = [];
  const walk = (parent: Element, prefix: string) => {
    let position = 0;
    for (const child of parent.children) {
      if (child.hasAttribute('data-glass-only')) continue;
      position += 1;
      const path = `${prefix}${child.tagName.toLowerCase()}[${position}]`;
      const flags = [
        ...STRUCTURAL.filter((pseudo) => child.matches(pseudo)),
        ...(isEmpty(child) ? [':empty'] : []),
      ].join('');
      lines.push(`${path} ${flags || '-'}`);
      walk(child, `${path}/`);
    }
  };
  walk(root, '');
  return `${lines.join('\n')}\n`;
}
