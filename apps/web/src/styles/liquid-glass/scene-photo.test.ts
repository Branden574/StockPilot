// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  SCENE_OUTPUTS,
  checkScene,
} from '../../../../../scripts/liquid-glass/install-scene.mjs';

import { enclosing, glassSourceFiles, inMedia, normaliseQuotes, parse } from './glass-css';

/**
 * The scene illustration on the web. The illustrations were made for
 * StockPilot by Claude Design during the Liquid Glass design work (confirmed
 * 2026-11-05) and are committed in apps/web/public/liquid-glass. scene.css
 * names them in --lg-scene-photo, on the glass root only (Day the light files,
 * Night the dark ones), and only the glass material's --lg-scene-img reads it,
 * so Classic and the reduced, contrast, forced-colours and low-power materials
 * never request one. Nothing else names a scene file: no element, no head
 * style, no preload, no build flag. A missing or altered committed file fails
 * here instead of turning the scene off.
 */

const WEB = join(__dirname, '..', '..', '..');
const PUBLIC = join(WEB, 'public');
const DAY = ":root[data-appearance='liquid-glass']";
const NIGHT = ":root[data-appearance='liquid-glass'].dark";
const SCENE_FILE = /liquid-glass\/scene-|scene-(light|dark)[-.]/u;

const web = SCENE_OUTPUTS.filter((o) => o.app === 'web');

/** The image-set() a scheme must have, one option per entry: AVIF 1x and 2x, WebP 1x and 2x, then the original JPEG. */
function imageSet(scheme: 'light' | 'dark'): string[] {
  const of = (kind: string, width?: number) =>
    web.find((o) => o.scheme === scheme && o.kind === kind && o.width === width)!;
  const url = (path: string) => `/${relative(PUBLIC, join(REPO_ROOT, path)).split('\\').join('/')}`;
  return (
    [
      [of('avif', 1200), '1x', 'image/avif'],
      [of('avif', 2400), '2x', 'image/avif'],
      [of('webp', 1200), '1x', 'image/webp'],
      [of('webp', 2400), '2x', 'image/webp'],
      [of('copy'), '2x', 'image/jpeg'],
    ] as const
  ).map(([o, res, type]) => `url('${url(o.path)}') ${res} type('${type}')`);
}

/** The options of an image-set() value, whitespace collapsed. */
function options(value: string): string[] {
  const m = /^image-set\(([\s\S]*)\)$/u.exec(value.trim());
  if (!m) throw new Error(`not an image-set(): ${value}`);
  return m[1]!
    .split(',')
    .map((o) => normaliseQuotes(o.replace(/\s+/gu, ' ').trim()))
    .filter(Boolean);
}

/** Every declaration of every glass stylesheet, with its file and rule. */
function glassDeclarations(): { file: string; rule: Rule; decl: Declaration }[] {
  const out: { file: string; rule: Rule; decl: Declaration }[] = [];
  for (const { file, text } of glassSourceFiles()) {
    parse(text, file).walkDecls((decl) => {
      out.push({ file, rule: decl.parent as Rule, decl });
    });
  }
  return out;
}

/** Every file under a folder, relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

describe('the scene illustration on the web', () => {
  it('scene.css names exactly the committed web files: Day the light ones, Night the dark ones, AVIF, then WebP, then the JPEG', () => {
    const declared = glassDeclarations().filter(({ decl }) => decl.prop === '--lg-scene-photo');
    expect(declared.map(({ file }) => file)).toEqual(['scene.css', 'scene.css']);
    expect(declared.map(({ rule }) => normaliseQuotes(rule.selector))).toEqual([DAY, NIGHT]);
    const [day, night] = declared.map(({ decl }) => options(decl.value));
    expect(day).toEqual(imageSet('light'));
    expect(night).toEqual(imageSet('dark'));
    // Day never names the night file, and Night never the day file.
    expect(day!.join()).not.toContain('scene-dark');
    expect(night!.join()).not.toContain('scene-light');
    // Every web file is named once, and each is in public/liquid-glass.
    const named = [...day!, ...night!].map((o) => /url\('\/([^']+)'\)/u.exec(o)![1]!);
    expect([...named].sort()).toEqual(
      web.map((o) => relative(PUBLIC, join(REPO_ROOT, o.path)).split('\\').join('/')).sort(),
    );
  });

  it('only on the glass root, inside @layer lg and @media screen, and no other glass rule names a scene file', () => {
    const naming = glassDeclarations().filter(
      ({ decl }) => decl.prop === '--lg-scene-photo' || SCENE_FILE.test(decl.value),
    );
    expect(naming).toHaveLength(2);
    for (const { file, rule, decl } of naming) {
      expect(file).toBe('scene.css');
      expect(decl.prop).toBe('--lg-scene-photo');
      expect([DAY, NIGHT]).toContain(normaliseQuotes(rule.selector));
      expect(enclosing(rule)).toEqual(['@media screen', '@layer lg']);
      expect(inMedia(rule, 'screen')).toBe(true);
    }
  });

  it('only the glass material reads it: --lg-scene-img in the Day and Night glass blocks of tokens.generated.css', () => {
    const readers = glassDeclarations().filter(({ decl }) =>
      /var\(\s*--lg-scene-photo\b/u.test(decl.value),
    );
    expect(
      readers.map(({ file, rule, decl }) => [file, normaliseQuotes(rule.selector), decl.prop]),
    ).toEqual([
      ['tokens.generated.css', DAY, '--lg-scene-img'],
      ['tokens.generated.css', NIGHT, '--lg-scene-img'],
    ]);
    for (const { rule } of readers) expect(enclosing(rule)).toEqual(['@media screen', '@layer lg']);
  });

  it('nothing else names a scene file: no page, component, layout, head element, preload or build flag', () => {
    const SRC = join(WEB, 'src');
    const offenders = filesUnder(SRC)
      .filter((f) => /\.(tsx?|css|mjs|js)$/u.test(f) && !/\.test\.tsx?$/u.test(f))
      .filter((f) => f !== join('styles', 'liquid-glass', 'scene.css'))
      .filter((f) => SCENE_FILE.test(readFileSync(join(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
    const config = readFileSync(join(WEB, 'next.config.ts'), 'utf8');
    expect(config).not.toMatch(SCENE_FILE);
    expect(config).not.toMatch(/LIQUID_GLASS_SCENE|scene-photo/u);
    // The root layout's <head> holds the appearance script alone (layout.appearance.test.tsx).
    expect(readFileSync(join(SRC, 'app', 'layout.tsx'), 'utf8')).not.toMatch(/<style\b|<link\b/u);
  });

  it('public/liquid-glass holds the committed scene files and nothing else', () => {
    expect(filesUnder(join(PUBLIC, 'liquid-glass')).sort()).toEqual(
      web.map((o) => basename(o.path)).sort(),
    );
  });

  it('the committed web files are the ones the manifest pins: present, the originals byte for byte, each at its size, with no metadata, each decoding', async () => {
    expect(await checkScene({ app: 'web' })).toEqual([]);
  }, 60_000);
});
