// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import nextConfig from '../../../next.config';
import {
  REPO_ROOT,
  SCENE_OUTPUTS,
  checkScene,
  readManifest,
} from '../../../../../scripts/liquid-glass/install-scene.mjs';

import { enclosing, glassSourceFiles, inMedia, normaliseQuotes, parse } from './glass-css';

/**
 * The scene illustration on the web. The illustrations were made for
 * StockPilot by Claude Design during the Liquid Glass design work (confirmed
 * 2026-11-05) and are committed in apps/web/public/liquid-glass. scene.css
 * names them in one rule: --lg-scene-photo-day (the light files) and
 * --lg-scene-photo-night (the dark files), each address carrying its file's
 * version, inside an @supports test that only an engine reading type() in
 * image-set() passes, and only once next-themes has put .light or .dark on
 * <html>. The glass material's --lg-scene-img draws the scheme's picture and
 * --lg-scene-img-night the night one, which reaches Day only in the landing's
 * Cycle counts band (the board draws it in the Night theme), so Classic and
 * the reduced, contrast, forced-colours and low-power materials never request
 * one. Nothing else names a scene file: no element, no head style, no preload,
 * no build flag. A missing or altered committed file fails here instead of
 * turning the scene off.
 */

const WEB = join(__dirname, '..', '..', '..');
const PUBLIC = join(WEB, 'public');
const ROOT = ":root[data-appearance='liquid-glass']";
/** The Day and Night glass token blocks (tokens.generated.css). */
const DAY = ROOT;
const NIGHT = `${ROOT}.dark`;
/** Where scene.css names the pictures: the glass root once next-themes has set a scheme. */
const SCHEMED = `${ROOT}:is(.light, .dark)`;
/** The test an engine that cannot parse type() inside image-set() fails. */
const TYPE_SUPPORT = "@supports (background-image: image-set(url('data:,') 1x type('image/png')))";
/** The landing's Cycle counts band in Day: the Night theme on every page (Landing.dc.html:202). */
const BAND_DAY = `${ROOT}:not(.dark) [data-glass-page='landing'] .lgl-band`;
const SCENE_FILE = /liquid-glass\/scene-|scene-(light|dark)[-.]/u;
/** How many hex digits of a file's SHA-256 its address carries. */
const VERSION_DIGITS = 12;

const web = SCENE_OUTPUTS.filter((o) => o.app === 'web');
const manifest = readManifest();

/** A web file's address as scene.css names it: its public path, then ?v= and the start of its pinned SHA-256. */
function address(path: string): string {
  const posix = path.split('\\').join('/');
  const pinned = manifest.get(posix);
  if (!pinned) throw new Error(`${posix} is not in the scene manifest`);
  return `/${relative(PUBLIC, join(REPO_ROOT, path)).split('\\').join('/')}?v=${pinned.slice(0, VERSION_DIGITS)}`;
}

/** The image-set() a picture must have, one option per entry: AVIF 1x and 2x, WebP 1x and 2x, then the original JPEG. */
function imageSet(scheme: 'light' | 'dark'): string[] {
  const of = (kind: string, width?: number) =>
    web.find((o) => o.scheme === scheme && o.kind === kind && o.width === width)!;
  return (
    [
      [of('avif', 1200), '1x', 'image/avif'],
      [of('avif', 2400), '2x', 'image/avif'],
      [of('webp', 1200), '1x', 'image/webp'],
      [of('webp', 2400), '2x', 'image/webp'],
      [of('copy'), '2x', 'image/jpeg'],
    ] as const
  ).map(([o, res, type]) => `url('${address(o.path)}') ${res} type('${type}')`);
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

/** The at-rules around a rule, quotes and whitespace runs made uniform. */
const around = (rule: Rule) =>
  enclosing(rule).map((a) => normaliseQuotes(a.replace(/\s+/gu, ' ').trim()));

/** Every file under a folder, relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

/** A next.config `source` as a regular expression (the two forms this config uses). */
const sourcePattern = (source: string) =>
  new RegExp(`^${source.replace(/\/:path\+$/u, '/.+').replace(/\/:path\*$/u, '/.*')}$`, 'u');

describe('the scene illustration on the web', () => {
  it('scene.css names exactly the committed web files, each at its pinned version: the day picture the light ones, the night picture the dark ones, AVIF, then WebP, then the JPEG', () => {
    const declared = glassDeclarations().filter(({ decl }) =>
      decl.prop.startsWith('--lg-scene-photo'),
    );
    expect(declared.map(({ file, decl }) => [file, decl.prop])).toEqual([
      ['scene.css', '--lg-scene-photo-day'],
      ['scene.css', '--lg-scene-photo-night'],
    ]);
    const [day, night] = declared.map(({ decl }) => options(decl.value));
    expect(day).toEqual(imageSet('light'));
    expect(night).toEqual(imageSet('dark'));
    // The day picture never names a dark file, and the night picture never a light one.
    expect(day!.join()).not.toContain('scene-dark');
    expect(night!.join()).not.toContain('scene-light');
    // Every web file is named once, and each is in public/liquid-glass.
    const named = [...day!, ...night!].map((o) => /url\('\/([^'?]+)\?v=[0-9a-f]+'\)/u.exec(o)![1]!);
    expect([...named].sort()).toEqual(
      web.map((o) => relative(PUBLIC, join(REPO_ROOT, o.path)).split('\\').join('/')).sort(),
    );
  });

  it('each address carries the start of its file’s pinned SHA-256, so a changed file is a new address', () => {
    const urls = glassDeclarations()
      .filter(({ decl }) => decl.prop.startsWith('--lg-scene-photo'))
      .flatMap(({ decl }) =>
        [...decl.value.matchAll(/url\(\s*'([^']+)'\s*\)/gu)].map((m) => m[1]!),
      );
    expect(urls).toHaveLength(web.length);
    expect([...urls].sort()).toEqual(web.map((o) => address(o.path)).sort());
    // The version is what the manifest pins, which checkScene ties to the bytes.
    for (const url of urls) expect(url).toMatch(/\?v=[0-9a-f]{12}$/u);
  });

  it('one rule names them: on the glass root once .light or .dark is set, inside the type() test, @media screen and @layer lg; no other glass rule names a scene file', () => {
    const naming = glassDeclarations().filter(
      ({ decl }) => decl.prop.startsWith('--lg-scene-photo') || SCENE_FILE.test(decl.value),
    );
    expect(naming).toHaveLength(2);
    expect(new Set(naming.map(({ rule }) => rule)).size).toBe(1);
    for (const { file, rule } of naming) {
      expect(file).toBe('scene.css');
      expect(normaliseQuotes(rule.selector)).toBe(SCHEMED);
      expect(around(rule)).toEqual([TYPE_SUPPORT, '@media screen', '@layer lg']);
      expect(inMedia(rule, 'screen')).toBe(true);
    }
  });

  it('the glass material reads them: Day glass draws the day picture, Night glass the night one, and both name the night picture for the band; no other rule reads a picture', () => {
    const readers = glassDeclarations().filter(({ decl }) =>
      /var\(\s*--lg-scene-photo-/u.test(decl.value),
    );
    expect(
      readers.map(({ file, rule, decl }) => [
        file,
        normaliseQuotes(rule.selector),
        decl.prop,
        decl.value,
      ]),
    ).toEqual([
      ['tokens.generated.css', DAY, '--lg-scene-img', 'var(--lg-scene-photo-day, none)'],
      ['tokens.generated.css', DAY, '--lg-scene-img-night', 'var(--lg-scene-photo-night, none)'],
      ['tokens.generated.css', NIGHT, '--lg-scene-img', 'var(--lg-scene-photo-night, none)'],
      ['tokens.generated.css', NIGHT, '--lg-scene-img-night', 'var(--lg-scene-photo-night, none)'],
    ]);
    for (const { rule } of readers) expect(around(rule)).toEqual(['@media screen', '@layer lg']);
  });

  it('Day draws the night picture only in the landing’s Cycle counts band, the board’s Night island (Landing.dc.html:202, sp.css:924, 1032)', () => {
    const night = glassDeclarations().filter(({ decl }) =>
      /var\(\s*--lg-scene-img-night\b/u.test(decl.value),
    );
    expect(
      night.map(({ file, rule, decl }) => [
        file,
        normaliseQuotes(rule.selector.replace(/\s+/gu, ' ')),
        decl.prop,
        decl.value,
      ]),
    ).toEqual([['pages/landing.css', BAND_DAY, '--lg-scene-img', 'var(--lg-scene-img-night)']]);
    expect(around(night[0]!.rule)).toEqual(['@media screen', '@layer lg']);
    // The same block gives the band the Night veil, so Day draws it as Night does.
    const veil = night[0]!.rule.nodes.find(
      (n): n is Declaration => n.type === 'decl' && n.prop === '--lg-scene-veil',
    );
    expect(veil?.value.replace(/\s+/gu, '')).toBe(
      'linear-gradient(180deg,rgba(6,10,9,0.18),rgba(6,10,9,0.3))',
    );
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

  it('next.config keeps the scene files a year as immutable (their addresses are versioned) and caches nothing else that way', async () => {
    const rules = (await nextConfig.headers!()) as HeaderRule[];
    const cacheRules = rules.filter((r) =>
      r.headers.some((h) => h.key.toLowerCase() === 'cache-control'),
    );
    const cacheFor = (path: string) =>
      cacheRules
        .filter((r) => sourcePattern(r.source).test(path))
        .flatMap((r) => r.headers.filter((h) => h.key.toLowerCase() === 'cache-control'))
        .map((h) => h.value);
    for (const o of web) {
      const path = address(o.path).split('?')[0]!;
      expect(cacheFor(path), path).toEqual(['public, max-age=31536000, immutable']);
    }
    for (const path of ['/', '/pricing', '/signin', '/dashboard/inventory', '/email/lock@2x.gif']) {
      expect(cacheFor(path), path).toEqual([]);
    }
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
