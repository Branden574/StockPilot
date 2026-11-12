// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { enclosing, GLASS_DIR, normaliseQuotes, splitSelectors } from './glass-css';

/**
 * The stage 3 orders lane's glass CSS, held to what its review found
 * (stage3/orders-rows.md, fix round 1). Each case reads the rules a finding
 * named, so a later edit cannot quietly bring the finding back. What the
 * rules then draw (computed styles, the focus ring, the drawer's box) is the
 * lab's half: tests/e2e/appearance on the integrator's run.
 */

const WEB = join(GLASS_DIR, '..', '..', '..');
const read = (path: string) => readFileSync(join(WEB, path), 'utf8');

interface Found {
  selector: string;
  media: string[];
  decls: Record<string, string>;
}

/** Every selector of a glass file with its declarations and media (screen left out). */
function rules(file: string): Found[] {
  const out: Found[] = [];
  postcss.parse(readFileSync(join(GLASS_DIR, file), 'utf8')).walkRules((rule: Rule) => {
    const decls: Record<string, string> = {};
    for (const node of rule.nodes) if (node.type === 'decl') decls[node.prop] = node.value;
    const media = enclosing(rule)
      .filter((a) => a.startsWith('@media ') && a !== '@media screen')
      .map((a) => a.slice('@media '.length).replace(/\s+/g, ' ').trim());
    for (const selector of splitSelectors(normaliseQuotes(rule.selector.replace(/\s+/g, ' ')))) {
      out.push({ selector, media, decls });
    }
  });
  return out;
}

const LANE = ['pages/orders.css', 'pages/order-detail.css', 'pages/order-new.css'];
const ROOT = ":root[data-appearance='liquid-glass']";

describe('stage 3 orders lane: the review findings stay fixed', () => {
  it('draws the board’s outline ring on every focusable hook a rule gives a shadow (F4, F5)', () => {
    const all = ['primitives.css', ...LANE].flatMap(rules);
    const RING = 'var(--lg-focus-w) solid var(--lg-focus)';
    // A glass box-shadow on a control replaces the classic box-shadow ring
    // (layer lg), so each control so shadowed needs the glass ring.
    const RINGS: Array<[RegExp, string]> = [
      [/\[data-glass='button'\]/, `${ROOT} [data-glass='button']:focus-visible`],
      [
        /\[data-glass='orders-phone-card'\]/,
        `${ROOT} [data-glass-page='orders'] [data-glass='orders-phone-card']:focus-visible`,
      ],
      [/\[data-glass='seg'\] >/, `${ROOT} [data-glass='seg'] > :focus-visible`],
    ];
    for (const [hook, ring] of RINGS) {
      const shadowed = all.filter(
        (r) =>
          hook.test(r.selector) &&
          !r.selector.includes(':focus-visible') &&
          r.decls['box-shadow'] !== undefined &&
          r.decls['box-shadow'] !== 'none',
      );
      expect(shadowed.length, String(hook)).toBeGreaterThan(0);
      const drawn = all.find((r) => r.selector === ring && r.media.length === 0);
      expect(drawn?.decls.outline, ring).toBe(RING);
    }
    // The button and segment rings clear the classic box-shadow ring, so
    // a default (ink) button never draws two.
    for (const ring of [
      `${ROOT} [data-glass='button']:focus-visible`,
      `${ROOT} [data-glass='seg'] > :focus-visible`,
    ]) {
      expect(all.find((r) => r.selector === ring)?.decls).toMatchObject({
        '--tw-ring-shadow': '0 0 #0000',
        '--tw-ring-offset-shadow': '0 0 #0000',
      });
    }
  });

  it('sets titles in the glass display face, never the classic one captured on <html> (F8)', () => {
    for (const file of [...LANE, 'storefront.glass.css']) {
      expect(read(`src/styles/liquid-glass/${file}`), file).not.toMatch(/var\(--lg-font-/);
    }
  });

  it('turns a hovered Orders tab’s words ink, inner span included (F9)', () => {
    const hover = rules('pages/orders.css').find(
      (r) =>
        r.selector ===
        `${ROOT} [data-glass-page='orders'] [data-slot='stat-strip-link']:hover > span:first-child span`,
    );
    expect(hover?.decls.color).toBe('var(--lg-ink)');
  });

  it('draws no segment count Manage items does not have (F10)', () => {
    expect(read('src/styles/liquid-glass/pages/orders.css')).not.toMatch(/segmented-tab-count/);
    expect(read('src/styles/liquid-glass/stage3-orders-contrast.test.ts')).not.toMatch(
      /'segment count/,
    );
  });

  it('insets the Review selection drawer 10 px with every corner at 24, 420 px wide (F11)', () => {
    const drawer = rules('pages/orders.css').filter((r) =>
      r.selector.endsWith("[data-glass='sheet'][data-glass-role='order-items-review']"),
    );
    expect(drawer.find((r) => r.media.length === 0)?.decls).toMatchObject({
      top: '10px',
      right: '10px',
      bottom: '10px',
      height: 'auto',
      width: 'min(420px, calc(100vw - 20px))',
      'border-radius': '24px',
    });
    expect(read('src/components/orders/manage-items/manage-order-items.tsx')).toMatch(
      /<SheetContent[^>]*data-glass-role="order-items-review"/,
    );
  });

  it('gives Add items its foot through the add-items-body wrapper (F12)', () => {
    const foot = rules('pages/order-detail.css').filter((r) =>
      r.selector.endsWith("> [data-glass='dialog-footer']"),
    );
    expect(foot.length).toBeGreaterThan(0);
    for (const r of foot) {
      expect(r.selector).toContain("[data-glass='dialog'] > [data-glass='add-items-body']");
    }
  });

  it('writes dialog descriptions in ink 2 (F13a)', () => {
    for (const file of ['pages/order-detail.css', 'pages/orders.css']) {
      const words = rules(file).filter((r) =>
        r.selector.endsWith("> [data-glass='dialog-header'] > [class~='text-muted-foreground']"),
      );
      expect(
        words.map((r) => r.decls.color),
        file,
      ).toEqual(['var(--lg-ink-2)']);
    }
  });

  it('fills the scope chip with the selection fill (F13b)', () => {
    const chip = rules('pages/orders.css').find((r) =>
      r.selector.endsWith("[data-glass='orders-filter-note'] > span:first-child"),
    );
    expect(chip?.decls.background).toBe('var(--lg-sel-fill)');
  });

  it('keeps each table’s header band sticky and frosted, with no frost in the reduced materials (F13c)', () => {
    const bands = [
      ['pages/orders.css', "[data-glass-page='orders'] [data-glass='table'] thead"],
      [
        'pages/orders.css',
        "[data-glass-page='manage-items'] [data-glass='card'] [data-glass='table'] thead",
      ],
      [
        'pages/order-detail.css',
        "[data-glass-page='order-detail'] [data-glass-role='order-lines'] [data-glass='table'] thead",
      ],
    ] as const;
    for (const [file, tail] of bands) {
      const found = rules(file).filter((r) => r.selector.endsWith(tail));
      expect(
        found.find((r) => r.media.length === 0 && r.decls.position)?.decls,
        tail,
      ).toMatchObject({
        position: 'sticky',
        top: '0',
        'z-index': '3',
        '-webkit-backdrop-filter': 'blur(14px) saturate(140%)',
        'backdrop-filter': 'blur(14px) saturate(140%)',
      });
      const flat = found.filter((r) => r.decls['backdrop-filter'] === 'none');
      // The order page's phone line list (lane phone) lays the band out as a
      // plain row at 760 px and under: not sticky, so not frosted either.
      const phone = file === 'pages/order-detail.css' ? [['(max-width: 760px)', false]] : [];
      expect(
        flat.map((r) => [
          r.media.join(),
          r.selector.startsWith(`${ROOT}[data-lg-material='reduced']`),
        ]),
        tail,
      ).toEqual([
        ...phone,
        ['(prefers-reduced-transparency: reduce), (prefers-contrast: more)', false],
        ['', true],
      ]);
      if (phone.length > 0) {
        expect(
          found.find((r) => r.media.join() === '(max-width: 760px)')?.decls,
          tail,
        ).toMatchObject({ position: 'static' });
      }
    }
  });

  it('draws the Export menu’s icons in ink 3 (F13d)', () => {
    const icon = rules('pages/orders.css').find((r) =>
      r.selector.endsWith("[data-glass-role='orders-export-menu'] [data-glass='menu-item'] > svg"),
    );
    expect(icon?.decls.color).toBe('var(--lg-ink-3)');
  });

  it('draws a held step’s note as the warning alert, with its icon (F13f)', () => {
    const notice = rules('pages/order-detail.css').filter((r) =>
      r.selector.includes("[data-glass='order-notice']"),
    );
    expect(
      notice.find((r) => r.selector.endsWith("[data-glass='order-notice']"))?.decls,
    ).toMatchObject({
      border: 'var(--lg-b-w) solid var(--lg-warn-line)',
      'background-color': 'var(--lg-warn-wash)',
      color: 'var(--lg-ink)',
    });
    const icon = notice.find((r) => r.selector.endsWith("[data-glass='order-notice']::before"));
    expect(icon?.decls['background-color']).toBe('var(--lg-warn)');
    expect(icon?.decls.mask).toMatch(/^url\("data:image\/svg\+xml,/);
  });

  it('draws Select family’s Add as the accent button (F13g)', () => {
    const add = rules('pages/orders.css').filter((r) =>
      r.selector.includes("[data-glass-role='order-items-family-add']"),
    );
    expect(
      add.find((r) => r.selector.endsWith("[data-glass-role='order-items-family-add']"))?.decls,
    ).toEqual({
      'background-color': 'var(--lg-accent)',
      color: 'var(--lg-on-accent)',
    });
    expect(add.find((r) => r.selector.endsWith(':not(:disabled):hover'))?.decls).toEqual({
      'background-color': 'var(--lg-accent-hover)',
    });
    expect(read('src/components/orders/manage-items/manage-order-items.tsx')).toMatch(
      /data-glass-role="order-items-family-add"/,
    );
  });

  it('lays the order page out in one column at a 1100 px window and narrower, two above (F13i)', () => {
    const columns = rules('pages/order-detail.css').filter((r) =>
      r.selector.endsWith("[data-glass='order-detail-columns']"),
    );
    expect(columns.map((r) => [r.media.join(), r.decls['grid-template-columns']])).toEqual([
      ['', 'minmax(0, 1fr) minmax(300px, 360px)'],
      ['(max-width: 1100px)', 'minmax(0, 1fr)'],
    ]);
    expect(read('src/styles/liquid-glass/pages/order-detail.css')).not.toMatch(/@container/);
  });

  it('keeps Place an order’s cart beside the catalog down to 1101 px, 300 to 360 px wide (F7)', () => {
    const store = rules('storefront.glass.css');
    const shell = store.filter((r) => r.selector.endsWith('.sf-shell'));
    expect(shell.map((r) => [r.media.join(), r.decls['grid-template-columns']])).toEqual([
      ['', 'minmax(0, 1fr) minmax(300px, 360px)'],
      ['(max-width: 1100px)', 'minmax(0, 1fr)'],
    ]);
    const band = '(min-width: 1100.02px) and (max-width: 1280px)';
    expect(
      store.find((r) => r.media.join() === band && r.selector.endsWith(' .sf-rail'))?.decls
        .position,
    ).toBe('sticky');
    expect(
      store.find((r) => r.media.join() === band && r.selector.endsWith(' .sf-fab'))?.decls.display,
    ).toBe('none');
    expect(store.some((r) => r.media.join() === '(max-width: 1280px)')).toBe(false);
  });
});
