import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type AtRule, type ChildNode, type Root, type Rule } from 'postcss';

/**
 * Shared by the Liquid Glass CSS guards (glass-scope.guard.test.ts,
 * compiled-css.guard.test.ts, glass-tokens.validity.test.ts,
 * glass-visibility.test.ts): the glass source files, a top-level selector
 * splitter, and the walk that knows which at-rules surround a rule.
 */

export const GLASS_DIR = __dirname;

/** The one root every glass selector starts with (quotes optional, as minifiers drop them). */
export const GLASS_ROOT = /^:root\[data-appearance=(["']?)liquid-glass\1\]/;

/** One quote style, so prettier's single quotes and the generator's double quotes compare equal. */
export const normaliseQuotes = (selector: string) => selector.replace(/"/g, "'");

/** The classic hide rule of visibility.css (plan 4.4), the one glass rule outside @media screen. */
export const CLASSIC_HIDE_RULE = ":root:not([data-appearance='liquid-glass']) [data-glass-only]";

/** The classic hide rule however it was written: quoted (source) or unquoted (minified build). */
export const isClassicHideRule = (selector: string) =>
  selector.replace(/["']/g, '') === CLASSIC_HIDE_RULE.replace(/'/g, '');

/** The only selectors that may not start with the glass root (visibility.css, print.css). */
export const UNSCOPED_ALLOWED = new Set([CLASSIC_HIDE_RULE, '[data-glass-only]']);

/** Files that restyle UNLAYERED classic CSS, so they stay outside every layer (plan 4.1, R22). */
export const isUnlayeredCompanion = (file: string) => file.endsWith('.glass.css');

/** Where the page compositions live: each is imported by its own route (plan 4.1, 4.6). */
export const PAGES_DIR = 'pages';

/**
 * Every glass stylesheet: the global ones in this folder and the page
 * compositions under pages/ (named "pages/<name>.css"), so every guard reads
 * the route-imported files too.
 */
export function glassSourceFiles(): { file: string; text: string }[] {
  const top = readdirSync(GLASS_DIR).filter((f) => f.endsWith('.css'));
  const pagesDir = join(GLASS_DIR, PAGES_DIR);
  const pages = existsSync(pagesDir)
    ? readdirSync(pagesDir)
        .filter((f) => f.endsWith('.css'))
        .map((f) => `${PAGES_DIR}/${f}`)
    : [];
  return [...top, ...pages]
    .sort()
    .map((file) => ({ file, text: readFileSync(join(GLASS_DIR, file), 'utf8') }));
}

export function parse(text: string, from?: string): Root {
  return postcss.parse(text, from ? { from } : undefined);
}

/** Split a selector list at top-level commas only (not inside :is(), :not() or [..]). */
export function splitSelectors(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The at-rules around a node, innermost first, as "@name params". */
export function enclosing(node: ChildNode): string[] {
  const out: string[] = [];
  let parent = node.parent as ChildNode | Root | undefined;
  while (parent && parent.type !== 'root') {
    if (parent.type === 'atrule')
      out.push(`@${(parent as AtRule).name} ${(parent as AtRule).params}`);
    parent = (parent as ChildNode).parent as ChildNode | Root | undefined;
  }
  return out;
}

/** True when the rule is a keyframe step (inside @keyframes). */
export function inKeyframes(rule: Rule): boolean {
  return enclosing(rule).some((a) => /^@(-webkit-)?keyframes /.test(a));
}

export const inMedia = (rule: Rule, query: 'screen' | 'print') =>
  enclosing(rule).some((a) => a.replace(/\s+/g, ' ').trim() === `@media ${query}`);
