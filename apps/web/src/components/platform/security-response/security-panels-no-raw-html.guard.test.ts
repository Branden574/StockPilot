// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * NO RAW HTML WHERE A STRANGER'S TEXT IS SHOWN.
 *
 * Security invariant. The how-to-respond panel shows the paths and query
 * strings scanners asked for ("What was asked for"), and the attack map shows
 * the record's names: text a stranger chose. Both folders render it as React
 * text nodes only. Pinned here: no file of either folder (its code, comments
 * taken out) sets HTML from a string: no dangerouslySetInnerHTML, no
 * innerHTML, outerHTML or insertAdjacentHTML write, no document.write, no
 * createContextualFragment, no DOMParser. A test file may READ innerHTML to
 * check what is on the page; it may not set it.
 */

const SRC = join(__dirname, '..', '..', '..');
const FOLDERS = ['components/platform/security-response', 'components/platform/security-map'];
const SELF = 'components/platform/security-response/security-panels-no-raw-html.guard.test.ts';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** The code only: a comment that names a thing proves nothing. */
const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RAW_HTML = [
  /dangerouslySetInnerHTML/,
  /\.(?:inner|outer)HTML\s*(?:\+?=)(?!=)/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\s*\.\s*write(?:ln)?\b/,
  /\bcreateContextualFragment\b/,
  /\bDOMParser\b/,
  /\bsrcdoc\b/,
];

const all = FOLDERS.flatMap((folder) =>
  files(join(SRC, folder)).map((abs) => ({
    rel: relative(SRC, abs).split(sep).join('/'),
    code: codeOf(readFileSync(abs, 'utf8')),
  })),
).filter((f) => f.rel !== SELF);

describe('no raw HTML in the panel and map folders', () => {
  it('reads both folders, the samples section among them', () => {
    const names = all.map((f) => f.rel);
    expect(names).toContain('components/platform/security-response/security-response-samples.tsx');
    expect(names).toContain('components/platform/security-response/security-response-panel.tsx');
    expect(names.some((n) => n.startsWith('components/platform/security-map/'))).toBe(true);
  });

  it('no file sets HTML from a string', () => {
    const found = all.flatMap(({ rel, code }) =>
      RAW_HTML.filter((rule) => rule.test(code)).map((rule) => `${rel}: ${rule.source}`),
    );
    expect(found).toEqual([]);
  });

  it('the rules see what they look for', () => {
    const hits = (code: string) => RAW_HTML.some((rule) => rule.test(codeOf(code)));
    expect(hits('<div dangerouslySetInnerHTML={{ __html: x }} />')).toBe(true);
    expect(hits('el.innerHTML = x;')).toBe(true);
    expect(hits('el.outerHTML += x;')).toBe(true);
    expect(hits("el.insertAdjacentHTML('beforeend', x);")).toBe(true);
    expect(hits('new DOMParser().parseFromString(x, "text/html");')).toBe(true);
    // Reading what is on the page is not setting it.
    expect(hits("expect(container.innerHTML).toBe('');")).toBe(false);
    expect(hits('if (el.innerHTML === x) {}')).toBe(false);
    // A comment that names it is not code.
    expect(hits('// never dangerouslySetInnerHTML here')).toBe(false);
  });
});
