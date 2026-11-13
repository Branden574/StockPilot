// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { AtRule, Declaration, Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { MARKETING_PATHS } from '@/components/theme/appearance-flag';

import {
  enclosing,
  GLASS_DIR,
  inKeyframes,
  normaliseQuotes,
  parse,
  splitSelectors,
} from './glass-css';

/**
 * The site lane's Liquid Glass stylesheets (stage 3: the marketing twins, the
 * sign-in shell, the invite and onboarding card). The shared scope and
 * compiled-CSS guards cover every glass file; this one pins what is particular
 * to these:
 *
 *  1. Route-level only (plan 4.1): pages/site.css is imported by the 7 twin
 *     pages and nothing else, pages/landing.css by the landing twin only,
 *     pages/access.css by the invite and onboarding pages only; no layout,
 *     component or global file imports them. auth.glass.css belongs to the
 *     sign-in layout (auth-css.guard.test.ts pins its place after auth.css).
 *  2. Each page composition opens with the layer order and scopes every
 *     selector to the page root its route draws ([data-glass-page=...]), so it
 *     cannot match another page while it stays loaded after a navigation.
 *  3. The low-power material (plans/REVISION-DEFAULT.md R7): every Reduce
 *     Transparency rule has an attribute twin under
 *     [data-lg-material='reduced'] with the same declarations, so a weak
 *     Chromium browser gets the opaque, unblurred set on these pages too.
 *  4. Every blur in these files is switched off by that reduced set (a blur
 *     the reduced rules do not reach would keep a weak machine blurring).
 *  5. The twins: each of the 7 marketing paths has its twin page, and the
 *     twin layout imports no stylesheet.
 */

const ROOT = ":root[data-appearance='liquid-glass']";
const REDUCED_ROOT = `${ROOT}[data-lg-material='reduced']`;
const SHARED_MEDIA = '(prefers-reduced-transparency: reduce), (prefers-contrast: more)';

const SRC = join(GLASS_DIR, '..', '..');
const APP = join(SRC, 'app');
const TWINS = join(APP, '(site-glass)', 'glass-site');

const SITE_FILES = ['pages/site.css', 'pages/landing.css', 'pages/access.css'] as const;
const ALL_FILES = [...SITE_FILES, 'auth.glass.css'] as const;

const read = (file: string) => readFileSync(join(GLASS_DIR, file), 'utf8');
const media = (rule: Rule) =>
  enclosing(rule)
    .filter((a) => a.startsWith('@media ') && a !== '@media screen')
    .map((a) => a.slice('@media '.length).replace(/\s+/g, ' ').trim());
const decls = (rule: Rule) =>
  rule.nodes.filter((n): n is Declaration => n.type === 'decl').map((d) => `${d.prop}: ${d.value}`);
const selectorsOf = (rule: Rule) =>
  splitSelectors(normaliseQuotes(rule.selector.replace(/\s+/g, ' ')));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Who imports each glass file, as paths under src/. */
function importers(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /(?:import\s+|@import\s+)['"]@\/styles\/liquid-glass\/([\w./-]+\.css)['"]/g,
    )) {
      out.set(m[1]!, [...(out.get(m[1]!) ?? []), relative(SRC, file)].sort());
    }
  }
  return out;
}

describe('site lane glass stylesheets: imported by their own routes only', () => {
  const by = importers();
  const twinPages = MARKETING_PATHS.map((path) =>
    join('app', '(site-glass)', 'glass-site', path === '/' ? '' : path.slice(1), 'page.tsx'),
  ).sort();

  it('pages/site.css: exactly the 7 twin pages', () => {
    expect(by.get('pages/site.css')).toEqual(twinPages);
  });

  it('pages/landing.css: exactly the landing twin', () => {
    expect(by.get('pages/landing.css')).toEqual([
      join('app', '(site-glass)', 'glass-site', 'page.tsx'),
    ]);
  });

  it('pages/access.css: exactly the invite and onboarding pages', () => {
    expect(by.get('pages/access.css')).toEqual([
      join('app', 'invite', '[token]', 'page.tsx'),
      join('app', 'onboarding', 'page.tsx'),
    ]);
  });

  it('auth.glass.css: the sign-in layout only', () => {
    expect(by.get('auth.glass.css')).toEqual([join('app', '(auth)', 'layout.tsx')]);
  });

  it('no layout imports a page composition, and the twin layout imports no stylesheet', () => {
    for (const file of SITE_FILES) {
      for (const importer of by.get(file) ?? []) expect(importer).toMatch(/(^|\/)page\.tsx$/);
    }
    expect(readFileSync(join(TWINS, 'layout.tsx'), 'utf8')).not.toMatch(/\.css['"]/);
  });
});

/**
 * The page roots each composition may select: the twin layout's
 * [data-glass-page='site'] (every twin), the landing twin's own main
 * [data-glass-page='landing'], and the external frame of the invite and
 * onboarding pages (ExternalShell glassPage="access").
 */
const ROOTS: Record<(typeof SITE_FILES)[number], readonly string[]> = {
  'pages/site.css': ['site'],
  'pages/landing.css': ['landing', 'site'],
  'pages/access.css': ['access'],
};

describe('site lane page compositions: layer order and page roots', () => {
  for (const file of SITE_FILES) {
    it(`${file}: opens with the layer order, so lg stays after Tailwind's layers`, () => {
      const first = parse(read(file), file).nodes.find((n) => n.type === 'atrule') as
        AtRule | undefined;
      expect(first?.name).toBe('layer');
      expect(first?.params.replace(/\s+/g, ' ')).toBe('theme, base, components, utilities, lg');
      expect(first?.nodes).toBeUndefined();
    });

    it(`${file}: every selector is scoped to a page root its route draws`, () => {
      const roots = ROOTS[file];
      const loose: string[] = [];
      parse(read(file), file).walkRules((rule: Rule) => {
        if (inKeyframes(rule)) return;
        for (const selector of selectorsOf(rule)) {
          if (!roots.some((root) => selector.includes(`[data-glass-page='${root}']`))) {
            loose.push(selector);
          }
        }
      });
      expect(loose).toEqual([]);
    });
  }
});

describe('the low-power material on the site lane pages (R7)', () => {
  for (const file of ALL_FILES) {
    it(`${file}: every Reduce Transparency rule has an attribute twin with the same declarations`, () => {
      const root = parse(read(file), file);
      const inMedia: { selectors: string[]; decls: string[] }[] = [];
      const twins: { selectors: string[]; decls: string[] }[] = [];
      root.walkRules((rule) => {
        const where = media(rule);
        if (where.length === 1 && where[0] === SHARED_MEDIA) {
          inMedia.push({ selectors: selectorsOf(rule), decls: decls(rule) });
        } else if (
          where.length === 0 &&
          selectorsOf(rule).every((s) => s.startsWith(REDUCED_ROOT))
        ) {
          twins.push({ selectors: selectorsOf(rule), decls: decls(rule) });
        }
      });
      expect(inMedia.length).toBeGreaterThan(0);
      expect(twins).toEqual(
        inMedia.map(({ selectors, decls: d }) => ({
          selectors: selectors.map((s) => s.replace(ROOT, REDUCED_ROOT)),
          decls: d,
        })),
      );
    });

    it(`${file}: every blurred element is unblurred by the reduced set`, () => {
      const root = parse(read(file), file);
      const unblurred = new Set<string>();
      const blurred: string[] = [];
      root.walkRules((rule) => {
        const where = media(rule);
        const filters = rule.nodes.filter(
          (n): n is Declaration => n.type === 'decl' && n.prop === 'backdrop-filter',
        );
        if (filters.length === 0) return;
        if (where.length === 1 && where[0] === SHARED_MEDIA) {
          if (filters.every((d) => d.value === 'none')) {
            for (const s of selectorsOf(rule)) unblurred.add(s);
          }
          return;
        }
        if (where.some((w) => w.includes('forced-colors'))) return;
        if (selectorsOf(rule).some((s) => s.startsWith(REDUCED_ROOT))) return;
        if (filters.every((d) => d.value === 'none')) return;
        blurred.push(...selectorsOf(rule));
      });
      // A blurred selector is covered when a reduced rule names its element:
      // the same selector, or an :is() list on the same root that holds its
      // last compound (with the one before it when the last is a bare
      // element, as in ".auth-panel-foot nav").
      const reducedText = [...unblurred].join('\n');
      const uncovered = blurred.filter((selector) => {
        if (unblurred.has(selector)) return false;
        const compounds = selector
          .replace(/:(hover|focus-visible|focus|active|focus-within)\b/g, '')
          .trim()
          .split(/\s+/);
        const last = compounds[compounds.length - 1]!;
        const named = last.match(/\.[\w-]+|\[[^\]]+\]/g) ?? [];
        if (named.length === 0) return !reducedText.includes(compounds.slice(-2).join(' '));
        return !named.some((c) => reducedText.includes(c));
      });
      expect(uncovered).toEqual([]);
    });
  }
});

describe('the twins (plan 4.6 M3)', () => {
  it('each of the 7 marketing paths has its twin page under app/(site-glass)/glass-site', () => {
    for (const path of MARKETING_PATHS) {
      const page = join(TWINS, path === '/' ? '' : path.slice(1), 'page.tsx');
      expect(existsSync(page), page).toBe(true);
    }
  });

  it('the twin layout carries the variant guard marker and the site page root', () => {
    const layout = readFileSync(join(TWINS, 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/data-lg-twin=""/);
    expect(layout).toMatch(/data-glass-page="site"/);
  });
});
