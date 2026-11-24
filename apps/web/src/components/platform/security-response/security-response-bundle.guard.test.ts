// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE CARDS' TEXT STAYS IN THE PANEL'S LAZY CHUNK.
 *
 * No route carries the how-to-respond cards in its first load. Pinned here,
 * as imports and names:
 *   - the cards' text (core's security-response-cards.ts) is named by the
 *     panel (security-response-panel.tsx) and by no other file of the app;
 *   - core's small module (security-response.ts: ids, levels, words), which
 *     every entry's control uses, brings no card text with it;
 *   - the panel is reached only through next/dynamic with ssr: false in the
 *     host (security-response-host.tsx);
 *   - the host, the control and the panel are client modules.
 * Core is marked free of side effects (security-map-bundle.guard.test.ts),
 * so a page gets only the core modules it names. The build proof in the
 * work notes measures the same thing on the built pages.
 */

const SRC = join(__dirname, '..', '..', '..');
const CORE = join(SRC, '..', '..', '..', 'packages', 'core', 'src');
const DIR = 'components/platform/security-response';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((abs) => ({
  rel: relative(SRC, abs).split(sep).join('/'),
  text: readFileSync(abs, 'utf8'),
}));
const fileText = (rel: string) => files.find((f) => f.rel === rel)!.text;
/** The code only, comments taken out: a comment that names a thing proves nothing. */
const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** What core's cards module exports: every name that carries card text. */
const CARD_EXPORTS = [
  'SECURITY_RESPONSE_CARDS',
  'SECURITY_RESPONSE_STEPS',
  'SECURITY_RESPONSE_STEP_IDS',
  'securityResponseCard',
  'securityResponseStepShown',
  'securityResponseRoutes',
];

const STATIC_FORMS = [
  /^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gms,
  /^import\s+['"]([^'"]+)['"]/gm,
  /^export\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gms,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const staticSources = (text: string) =>
  STATIC_FORMS.flatMap((form) => [...text.matchAll(form)].map((m) => m[1]!));
const staticImporters = (from: RegExp) =>
  files
    .filter(({ text }) => staticSources(text).some((source) => from.test(source)))
    .map((f) => f.rel)
    .sort();
const dynamicImporters = (from: RegExp) =>
  files
    .filter(({ text }) =>
      [...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].some((m) => from.test(m[1]!)),
    )
    .map((f) => f.rel)
    .sort();
/** Files whose code names `name` as a word. */
const namers = (name: string) =>
  files
    .filter(({ text }) => new RegExp(`\\b${name}\\b`).test(codeOf(text)))
    .map((f) => f.rel)
    .sort();

describe("the cards' text stays in the panel's lazy chunk", () => {
  it('the list of card names is what core exports from the cards module', () => {
    const cards = readFileSync(join(CORE, 'security', 'security-response-cards.ts'), 'utf8');
    const exported = [
      ...codeOf(cards).matchAll(/^export\s+(?:const|function)\s+([A-Za-z_]\w*)/gm),
    ].map((m) => m[1]);
    expect(exported.sort()).toEqual([...CARD_EXPORTS].sort());
  });

  it('only the panel names the cards', () => {
    const panel = `${DIR}/security-response-panel.tsx`;
    for (const name of CARD_EXPORTS) {
      for (const rel of namers(name)) expect(rel, name).toBe(panel);
    }
    // The panel itself does: the check would see a name if one were there.
    expect(namers('securityResponseCard')).toEqual([panel]);
    expect(namers('securityResponseStepShown')).toEqual([panel]);
    // No file of the app reaches core's cards module by its own path.
    expect(staticImporters(/security-response-cards/)).toEqual([]);
    expect(dynamicImporters(/security-response-cards/)).toEqual([]);
  });

  it("core's small module, used by every control, brings no card text", () => {
    const small = readFileSync(join(CORE, 'security', 'security-response.ts'), 'utf8');
    expect(staticSources(small).filter((s) => /security-response-cards/.test(s))).toEqual([]);
    expect(small).not.toMatch(/import\(\s*['"][^'"]*security-response-cards/);
  });

  it('the panel is reached only by next/dynamic, ssr: false, from the host', () => {
    expect(staticImporters(/(^|\/)security-response-panel$/)).toEqual([]);
    expect(dynamicImporters(/(^|\/)security-response-panel$/)).toEqual([
      `${DIR}/security-response-host.tsx`,
    ]);
    const host = codeOf(fileText(`${DIR}/security-response-host.tsx`));
    expect(host).toMatch(/const loadPanel = \(\) => import\('\.\/security-response-panel'\);/);
    expect(host).toMatch(
      /dynamic<SecurityResponsePanelProps>\(\s*\(\) => loadPanel\(\)\.then\(\(m\) => m\.SecurityResponsePanel\),\s*\{\s*ssr: false,/,
    );
    expect(host.match(/\bssr:/g)).toHaveLength(1);
    // The host brings in the panel's types only.
    expect(staticSources(host).filter((s) => /security-response-panel/.test(s))).toEqual([]);
  });

  it('the host, the control and the panel are client modules', () => {
    for (const name of [
      'security-response-host.tsx',
      'security-response-button.tsx',
      'security-response-panel.tsx',
    ]) {
      expect(fileText(`${DIR}/${name}`).startsWith("'use client';"), name).toBe(true);
    }
  });
});
