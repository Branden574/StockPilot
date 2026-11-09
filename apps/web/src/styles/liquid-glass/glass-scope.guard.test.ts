// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtRule, Rule } from 'postcss';

import {
  CLASSIC_HIDE_RULE,
  GLASS_ROOT,
  normaliseQuotes,
  UNSCOPED_ALLOWED,
  enclosing,
  glassSourceFiles,
  inKeyframes,
  inMedia,
  isUnlayeredCompanion,
  parse,
  splitSelectors,
} from './glass-css';

/**
 * THE CSS SCOPE GUARD (Liquid Glass plan 4.7 item 1). Classic Dark and Light
 * must never match a glass rule, and printing must never get glass. Every
 * source file under styles/liquid-glass/ (layered and unlayered companions) is
 * parsed, and the guard fails on:
 *   - a rule outside @media screen (print.css: @media print only; the one
 *     classic hide rule of visibility.css, allowed by exact text);
 *   - a selector that does not start with :root[data-appearance="liquid-glass"]
 *     (the two visibility rules and the print rule are allowed by text);
 *   - any @import of a non-glass file;
 *   - any @custom-variant, @utility, @apply, @tailwind or @theme (no glass
 *     Tailwind utilities: they would land outside these files and outside
 *     @media screen);
 *   - a layered file with a rule outside @layer lg, or an unlayered companion
 *     (*.glass.css) with any @layer;
 *   - @keyframes not named lg-*.
 */

const FILES = glassSourceFiles();

describe('styles/liquid-glass scope guard', () => {
  it('reads the glass files', () => {
    expect(FILES.map((f) => f.file)).toEqual(
      expect.arrayContaining([
        'index.css',
        'tokens.generated.css',
        'scene.css',
        'materials.css',
        'primitives.css',
        'shell.css',
        'visibility.css',
        'print.css',
        'globals.glass.css',
      ]),
    );
  });

  it('index.css imports only glass files in this folder, and nothing else', () => {
    const index = parse(FILES.find((f) => f.file === 'index.css')!.text);
    const imports: string[] = [];
    index.walkAtRules('import', (at) => {
      imports.push(at.params.replace(/['"]/g, ''));
    });
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^\.\/[\w.-]+\.css$/);
    const names = new Set(FILES.map((f) => `./${f.file}`));
    for (const spec of imports) expect(names.has(spec), spec).toBe(true);
    let other = 0;
    index.walk((node) => {
      if (node.type === 'rule' || (node.type === 'atrule' && node.name !== 'import')) other += 1;
    });
    expect(other).toBe(0);
  });

  for (const { file, text } of FILES) {
    if (file === 'index.css') continue;
    describe(file, () => {
      const root = parse(text, file);

      it('has no Tailwind utility, variant or theme at-rule and imports nothing', () => {
        const banned: string[] = [];
        root.walkAtRules((at: AtRule) => {
          if (
            /^(custom-variant|utility|apply|tailwind|theme|plugin|import|source)$/.test(at.name)
          ) {
            banned.push(`@${at.name} ${at.params}`);
          }
        });
        expect(banned).toEqual([]);
      });

      it(isUnlayeredCompanion(file) ? 'stays unlayered' : 'puts every rule in @layer lg', () => {
        if (isUnlayeredCompanion(file)) {
          const layers: string[] = [];
          root.walkAtRules('layer', (at) => {
            layers.push(at.params);
          });
          expect(layers).toEqual([]);
        } else {
          const outside: string[] = [];
          root.walkRules((rule: Rule) => {
            if (!enclosing(rule).includes('@layer lg')) outside.push(rule.selector);
          });
          expect(outside).toEqual([]);
        }
      });

      it('keeps every rule on screen (print.css: print only)', () => {
        const wrong: string[] = [];
        root.walkRules((rule: Rule) => {
          if (inKeyframes(rule)) return;
          if (file === 'print.css') {
            if (!inMedia(rule, 'print') || inMedia(rule, 'screen')) wrong.push(rule.selector);
            return;
          }
          if (file === 'visibility.css' && normaliseQuotes(rule.selector) === CLASSIC_HIDE_RULE) {
            return;
          }
          if (!inMedia(rule, 'screen')) wrong.push(rule.selector);
        });
        expect(wrong).toEqual([]);
      });

      it('scopes every selector to :root[data-appearance="liquid-glass"]', () => {
        const unscoped: string[] = [];
        root.walkRules((rule: Rule) => {
          if (inKeyframes(rule)) return;
          for (const selector of splitSelectors(rule.selector)) {
            if (GLASS_ROOT.test(selector)) continue;
            if (
              (file === 'visibility.css' || file === 'print.css') &&
              UNSCOPED_ALLOWED.has(normaliseQuotes(selector))
            ) {
              continue;
            }
            unscoped.push(selector);
          }
        });
        expect(unscoped).toEqual([]);
      });

      it('names its keyframes lg-*', () => {
        const names: string[] = [];
        root.walkAtRules(/keyframes$/, (at) => {
          names.push(at.params);
        });
        for (const name of names) expect(name).toMatch(/^lg-[\w-]+$/);
      });
    });
  }

  it('allows exactly the two visibility rules and the print rule by text', () => {
    const visibility = parse(FILES.find((f) => f.file === 'visibility.css')!.text);
    const selectors: string[] = [];
    visibility.walkRules((r) => {
      selectors.push(normaliseQuotes(r.selector));
    });
    expect(selectors).toEqual([
      CLASSIC_HIDE_RULE,
      ":root[data-appearance='liquid-glass'] [data-classic-only]",
    ]);
    const print = parse(FILES.find((f) => f.file === 'print.css')!.text);
    const printSelectors: string[] = [];
    print.walkRules((r) => {
      printSelectors.push(r.selector);
    });
    expect(printSelectors).toEqual(['[data-glass-only]']);
  });

  // Page compositions (plan 4.1, 4.6): imported by their own route, never
  // globally, and every selector scoped to a page root the route draws, so a
  // page's rules can never match another page that a client navigation shows
  // while the stylesheet is still loaded.
  describe('page compositions (pages/*.css)', () => {
    const PAGES = FILES.filter((f) => f.file.startsWith('pages/'));
    const APP = join(__dirname, '..', '..', 'app');
    const routeFiles = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) routeFiles(p, out);
        else if (/\.(tsx|ts)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const importers = new Map<string, string[]>();
    const nonRouteImporters: string[] = [];
    const SRC = join(__dirname, '..', '..');
    for (const file of routeFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(
        /import\s+'@\/styles\/liquid-glass\/(pages\/[\w.-]+\.css)';/g,
      )) {
        const rel = relative(APP, file);
        if (rel.startsWith('..') || !/(^|\/)page\.tsx$/.test(rel)) nonRouteImporters.push(rel);
        importers.set(m[1]!, [...(importers.get(m[1]!) ?? []), rel]);
      }
    }

    it('there are page compositions, and each is imported by at least one route page', () => {
      expect(PAGES.map((p) => p.file)).toEqual(
        expect.arrayContaining(['pages/items.css', 'pages/item-detail.css']),
      );
      for (const { file } of PAGES) expect(importers.get(file), file).toBeTruthy();
    });

    it('only route pages import them (never a layout, a component or app/globals.css)', () => {
      expect(nonRouteImporters).toEqual([]);
      const globals = readFileSync(join(APP, 'globals.css'), 'utf8');
      expect(globals).not.toMatch(/liquid-glass\/pages\//);
    });

    it('the Items and item pages import exactly their own compositions', () => {
      // The rental items list and a rental item draw the same InventoryTable
      // and ItemDetail, so they take the same compositions (stage 4).
      expect(importers.get('pages/items.css')?.sort()).toEqual([
        '(dashboard)/dashboard/books/page.tsx',
        '(dashboard)/dashboard/inventory/page.tsx',
        '(dashboard)/dashboard/rentals/items/page.tsx',
      ]);
      expect(importers.get('pages/item-detail.css')?.sort()).toEqual([
        '(dashboard)/dashboard/books/[id]/page.tsx',
        '(dashboard)/dashboard/inventory/[id]/page.tsx',
        '(dashboard)/dashboard/rentals/items/[id]/page.tsx',
      ]);
    });

    it('the operations pages import the shared frame, and each board file only its own pages', () => {
      const OPS = join(APP, '(dashboard)', 'dashboard');
      const lane = [
        'bundles',
        'categories',
        'customers',
        'cycle-counts',
        'exceptions',
        'locations',
        'maintenance',
        'movements',
        'planning',
        'procedures',
        'purchase-orders',
        'rentals',
        'returns',
        'schedule',
        'suppliers',
        'tags',
        'warehouses',
      ];
      const pages = lane
        .flatMap((d) => routeFiles(join(OPS, d)))
        .map((f) => relative(APP, f))
        .filter((f) => /(^|\/)page\.tsx$/.test(f))
        .filter((f) => !f.includes('/rentals/items/') || f.endsWith('/rentals/items/new/page.tsx'))
        .sort();
      expect(importers.get('pages/ops.css')?.sort()).toEqual(pages);
      // Each of them draws the root the shared frame is scoped to.
      for (const page of pages) {
        expect(readFileSync(join(APP, page), 'utf8'), page).toMatch(/data-glass-page="ops"/u);
      }
      const within = (file: string, dirs: string[]) =>
        (importers.get(file) ?? []).every((f) =>
          dirs.some((d) => f.startsWith(`(dashboard)/dashboard/${d}/`)),
        );
      expect(within('pages/counts.css', ['cycle-counts'])).toBe(true);
      expect(within('pages/po.css', ['purchase-orders', 'planning', 'suppliers'])).toBe(true);
      expect(within('pages/returns.css', ['returns'])).toBe(true);
    });

    it('the insights pages import the shared frame, and the report boards only their own pages', () => {
      const DASH = join(APP, '(dashboard)', 'dashboard');
      const lane = [
        'ai',
        'audit',
        'help',
        'insights',
        'notifications',
        'reports',
        'support',
        'team',
        'whats-new',
        'zendesk',
      ];
      const pages = lane
        .flatMap((d) => routeFiles(join(DASH, d)))
        .map((f) => relative(APP, f))
        .filter((f) => /(^|\/)page\.tsx$/.test(f))
        .sort();
      expect(importers.get('pages/insights.css')?.sort()).toEqual(pages);
      // Each of them draws the root the shared frame is scoped to.
      for (const page of pages) {
        expect(readFileSync(join(APP, page), 'utf8'), page).toMatch(/data-glass-page="insights"/u);
      }
      expect(importers.get('pages/reports.css')?.sort()).toEqual([
        '(dashboard)/dashboard/reports/book-order-totals/page.tsx',
        '(dashboard)/dashboard/reports/page.tsx',
      ]);
    });

    it('the pages people open from a link import pages/links.css, and each draws its root', () => {
      // Stage 4, insights lane: the token pages and the portal. A page that
      // draws the whole external frame names the root on it
      // (ExternalShell glassPage="links"); the signature page's layout
      // draws its frame, and the /r layout draws the root its pages'
      // columns sit in.
      const links = [
        'm/[token]/page.tsx',
        'orders/sign/[token]/page.tsx',
        'p/items/[id]/page.tsx',
        'portal/page.tsx',
        'r/[token]/page.tsx',
        'r/confirm/page.tsx',
        'r/track/page.tsx',
        'returns/request/[token]/page.tsx',
      ];
      expect(importers.get('pages/links.css')?.sort()).toEqual(links);
      const rootOf: Record<string, string> = {
        'orders/sign/[token]/page.tsx': 'orders/sign/[token]/layout.tsx',
        'r/[token]/page.tsx': 'r/layout.tsx',
        'r/confirm/page.tsx': 'r/layout.tsx',
        'r/track/page.tsx': 'r/layout.tsx',
      };
      for (const page of links) {
        const source = readFileSync(join(APP, rootOf[page] ?? page), 'utf8');
        expect(source, page).toMatch(/glassPage="links"|data-glass-page="links"/u);
        // Every external frame the page itself draws names the root.
        if (!rootOf[page]) {
          const frames = source.match(/<ExternalShell\b[^>]*>/gu) ?? [];
          expect(frames.length, page).toBeGreaterThan(0);
          for (const frame of frames) expect(frame, page).toContain('glassPage="links"');
        }
      }
    });

    it('the settings, admin and platform console pages import their compositions, the console after admin.css', () => {
      const lane = (importers.get('pages/admin.css') ?? []).sort();
      expect(lane.length).toBeGreaterThan(30);
      for (const rel of lane) {
        expect(rel, rel).toMatch(
          /^\(dashboard\)\/dashboard\/(settings|admin)\/|^\(platform\)\/platform\//,
        );
      }
      const consolePages = (importers.get('pages/platform.css') ?? []).sort();
      expect(consolePages).toEqual([
        '(platform)/platform/audit/page.tsx',
        '(platform)/platform/orgs/[id]/page.tsx',
        '(platform)/platform/page.tsx',
        '(platform)/platform/provision/page.tsx',
        '(platform)/platform/support/page.tsx',
      ]);
      for (const rel of consolePages) {
        expect(lane, rel).toContain(rel);
        // The import statements themselves (a comment naming the files in
        // the right order must not satisfy this).
        const text = readFileSync(join(APP, rel), 'utf8');
        const order = [
          ...text.matchAll(/import\s+'@\/styles\/liquid-glass\/(pages\/[\w.-]+\.css)';/g),
        ].map((m) => m[1]);
        expect(order, rel).toEqual(['pages/admin.css', 'pages/platform.css']);
      }
    });

    for (const { file, text } of PAGES) {
      it(`${file}: every selector is scoped to a [data-glass-page] root`, () => {
        const root = parse(text, file);
        const loose: string[] = [];
        root.walkRules((rule: Rule) => {
          if (inKeyframes(rule)) return;
          for (const selector of splitSelectors(rule.selector)) {
            if (!/\[data-glass-page=/.test(selector)) loose.push(selector);
          }
        });
        expect(loose).toEqual([]);
      });

      it(`${file}: opens with the layer order, so lg stays after Tailwind's layers`, () => {
        const first = parse(text, file).nodes.find((n) => n.type === 'atrule') as
          AtRule | undefined;
        expect(first?.name).toBe('layer');
        expect(first?.params.replace(/\s+/g, ' ')).toBe('theme, base, components, utilities, lg');
        expect(first?.nodes).toBeUndefined();
      });
    }
  });

  it('a planted leak fails it: an unscoped rule and a rule off screen', () => {
    const planted = parse(
      '@layer lg { .card { color: red } @media screen { .dark .card { color: red } } }',
    );
    const offenders: string[] = [];
    planted.walkRules((rule) => {
      if (!inMedia(rule, 'screen') || !GLASS_ROOT.test(rule.selector))
        offenders.push(rule.selector);
    });
    expect(offenders).toEqual(['.card', '.dark .card']);
  });
});
