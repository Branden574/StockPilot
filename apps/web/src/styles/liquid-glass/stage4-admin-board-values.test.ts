// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { type CssRule, cssRules, normaliseQuotes } from './glass-css';

/**
 * THE BOARD VALUES OF THE STAGE 4 ADMIN LANE, read from pages/admin.css and
 * pages/platform.css. Each entry names the board rule it follows
 * (Platform-Console.dc.html and the artifact's sp.css: .plat-bar,
 * .plat-chip, .plat-nav, .plat-root, .btn-danger-soft, .dialog, .page;
 * Routes-Gallery-2.dc.html: the settings rail .mi, the list rows). The
 * geometry is measured on the lab (stage 5); this keeps the values from
 * drifting in CI, where no browser runs.
 */

const ADMIN = cssRules('pages/admin.css');
const PLATFORM = cssRules('pages/platform.css');
const flat = (s: string) => normaliseQuotes(s.replace(/\s+/g, ' ').trim());

/**
 * The declarations every rule gives a selector that ends with `tail` (spaces
 * and quotes normalised), under exactly `media` ([] for the default look),
 * later rules winning; the low-power attribute twins left out.
 */
function at(rules: CssRule[], tail: string, media: string[] = []): Record<string, string> {
  const want = flat(tail);
  const out: Record<string, string> = {};
  let hit = false;
  for (const rule of rules) {
    if (rule.media.join(' / ') !== media.join(' / ')) continue;
    // The low-power twins (data-lg-material="reduced") are read on their own.
    const own = rule.selectors.filter((s) => !flat(s).includes('[data-lg-material='));
    if (!own.some((s) => flat(s).endsWith(want))) continue;
    hit = true;
    Object.assign(out, rule.decls);
  }
  if (!hit) throw new Error(`no rule ends with ${want} under [${media.join(' / ')}]`);
  return out;
}

const REDUCED = ['(prefers-reduced-transparency: reduce), (prefers-contrast: more)'];

describe('the platform console (Platform-Console.dc.html, exact)', () => {
  it('.plat-bar: the dark glass, its blur and its shadow; the row edge to edge at 0 20 px, 20 between', () => {
    const bar = at(PLATFORM, "[data-glass-page='platform'] > [data-slot='platform-topbar']");
    expect(bar.background).toBe('rgba(16, 19, 26, 0.82)');
    expect(bar.color).toBe('#f3f5f8');
    expect(bar['backdrop-filter']).toBe('blur(24px) saturate(160%)');
    expect(bar['-webkit-backdrop-filter']).toBe('blur(24px) saturate(160%)');
    expect(bar['box-shadow']?.replace(/\s+/g, ' ')).toBe(
      'inset 0 -1px 0 rgba(255, 255, 255, 0.08), 0 10px 30px -18px rgba(0, 0, 0, 0.5)',
    );
    const row = at(PLATFORM, "[data-slot='platform-topbar-row']");
    expect(row['max-width']).toBe('none');
    expect(row['column-gap']).toBe('20px');
    expect(row['padding-left']).toBe('20px');
    expect(row['padding-right']).toBe('20px');
  });

  it('.plat-bar reduced and contrast: the solid #14171F, no blur; the attribute twin the same', () => {
    const bar = at(
      PLATFORM,
      "[data-glass-page='platform'] > [data-slot='platform-topbar']",
      REDUCED,
    );
    expect(bar.background).toBe('#14171f');
    expect(bar['backdrop-filter']).toBe('none');
    const twin = PLATFORM.find(
      (r) =>
        r.media.length === 0 &&
        r.selectors.some((s) => flat(s).includes("[data-lg-material='reduced']")) &&
        r.selectors.some((s) => flat(s).endsWith("> [data-slot='platform-topbar']")),
    );
    expect(twin?.decls).toEqual(bar);
  });

  it('.plat-nav a: 34 px from 640 px, 0 12 px, radius 9, 13.5 px at 500 in 72% white; .on white at 600 on 12%', () => {
    const link = at(PLATFORM, "[data-slot='platform-nav'] > a");
    expect(link.padding).toBe('0 12px');
    expect(link['border-radius']).toBe('9px');
    expect(link['font-size']).toBe('13.5px');
    expect(link['font-weight']).toBe('500');
    expect(link.color).toBe('rgba(243, 245, 248, 0.72)');
    expect(at(PLATFORM, "[data-slot='platform-nav'] > a", ['(min-width: 640px)']).height).toBe(
      '34px',
    );
    const on = at(PLATFORM, "[data-slot='platform-nav'] > a[aria-current='page']");
    expect(on['background-color']).toBe('rgba(255, 255, 255, 0.12)');
    expect(on.color).toBe('#ffffff');
    expect(on['font-weight']).toBe('600');
    const hover = at(PLATFORM, "[data-slot='platform-nav'] > a:hover");
    expect(hover['background-color']).toBe('rgba(255, 255, 255, 0.06)');
  });

  it('.plat-chip: 22 px, 0 8 px, radius 6, the amber wash, 11.5 px at 650, .02em, ahead of the sections', () => {
    const chip = at(PLATFORM, "[data-slot='platform-admin-marker']");
    expect(chip.height).toBe('22px');
    expect(chip.padding).toBe('0 8px');
    expect(chip['border-radius']).toBe('6px');
    expect(chip['background-color']).toBe('rgba(255, 184, 77, 0.16)');
    expect(chip.color).toBe('#ffc977');
    expect(chip['font-size']).toBe('11.5px');
    expect(chip['font-weight']).toBe('650');
    expect(chip['letter-spacing']).toBe('0.02em');
    expect(chip.order).toBe('-1');
  });

  it('.plat-root: the 50% paper veil in Day, ink in Night, the ground itself reduced', () => {
    const veil = (tail: string) =>
      PLATFORM.find((r) => r.media.length === 0 && r.selectors.some((s) => flat(s) === flat(tail)))
        ?.decls.background;
    expect(veil(":root[data-appearance='liquid-glass'] [data-glass-page='platform']")).toBe(
      'linear-gradient(rgba(248, 244, 238, 0.5), rgba(248, 244, 238, 0.5))',
    );
    expect(veil(":root[data-appearance='liquid-glass'].dark [data-glass-page='platform']")).toBe(
      'linear-gradient(rgba(8, 11, 10, 0.5), rgba(8, 11, 10, 0.5))',
    );
    expect(
      PLATFORM.find(
        (r) =>
          r.media.join() === REDUCED.join() &&
          r.selectors.some((s) => flat(s).endsWith("[data-glass-page='platform']")),
      )?.decls.background,
    ).toBe('var(--lg-bg)');
  });

  it('.plat-main over .page: 26 / 28 / 48, 20 between; a phone 20 / 16 / 96, 16 between', () => {
    const page = at(PLATFORM, "[data-slot='platform-page']");
    expect(page.padding).toBe('26px 28px 48px');
    expect(page.gap).toBe('20px');
    const phone = at(PLATFORM, "[data-slot='platform-page']", ['(max-width: 760px)']);
    expect(phone.padding).toBe('20px 16px 96px');
    expect(phone.gap).toBe('16px');
  });

  it('.plat-root .card: blur 22, saturation 160%', () => {
    const card = PLATFORM.find(
      (r) =>
        r.media.length === 0 &&
        r.selectors.some(
          (s) => flat(s).includes("[data-glass='card']") && flat(s).includes('.bg-card.rounded-lg'),
        ),
    );
    expect(card?.decls['backdrop-filter']).toBe('blur(22px) saturate(160%)');
    expect(card?.decls['-webkit-backdrop-filter']).toBe('blur(22px) saturate(160%)');
  });

  it('.danger-zone and .btn-danger-soft: the danger line; the 36 px danger wash button in the danger ink', () => {
    expect(at(PLATFORM, "[data-glass-role='danger-zone']")['border-color']).toBe(
      'var(--lg-danger-line)',
    );
    const remove = at(
      PLATFORM,
      "[data-glass-role='danger-zone'] [data-glass='button'][data-glass-variant='destructive']",
    );
    expect(remove.height).toBe('36px');
    expect(remove['background-color']).toBe('var(--lg-danger-wash)');
    expect(remove.color).toBe('var(--lg-danger)');
    expect(remove['font-weight']).toBe('600');
  });

  it('the bar draws its focus inside each link in the Night focus colour', () => {
    const focus = at(
      PLATFORM,
      "[data-glass-page='platform'] > [data-slot='platform-topbar'] :is(a, button):focus-visible",
    );
    expect(focus.outline).toBe('2px solid #56d6a9');
    expect(focus['outline-offset']).toBe('-2px');
  });
});

describe('dialogs (sp.css .dialog; Platform-Console step-up and Order items access, exact)', () => {
  it('.dialog: the 20 / 48 / 14 / 24 head, the 8 px inset reading area at radius 16 and 18 px in, the 14 / 16 / 16 / 24 foot', () => {
    const head = at(
      ADMIN,
      ":is([data-glass='dialog'], [data-glass='dialog'] > [data-glass='dialog-form']) > [data-glass='dialog-header']",
    );
    expect(head.padding).toBe('20px 48px 14px 24px');
    const body = at(
      ADMIN,
      ":is([data-glass='dialog'], [data-glass='dialog'] > [data-glass='dialog-form']) > [data-glass='dialog-body']",
    );
    expect(body.margin).toBe('0 8px');
    expect(body.padding).toBe('18px');
    expect(body['border-radius']).toBe('16px');
    expect(body['background-color']).toBe('var(--lg-field-fill)');
    const foot = at(
      ADMIN,
      ":is([data-glass='dialog'], [data-glass='dialog'] > [data-glass='dialog-form']) > [data-glass='dialog-footer']",
    );
    expect(foot.padding).toBe('14px 16px 16px 24px');
    expect(foot.gap).toBe('10px');
  });

  it('the title 20/26 at 650 reaches only this lane’s dialogs (never the command palette)', () => {
    const rule = ADMIN.find((r) =>
      r.selectors.some(
        (s) => flat(s).endsWith('h2[id]') && flat(s).includes("[data-glass='dialog']"),
      ),
    );
    expect(rule?.decls['font-size']).toBe('20px');
    expect(rule?.decls['line-height']).toBe('26px');
    expect(rule?.decls['font-weight']).toBe('650');
    for (const s of rule!.selectors) {
      expect(flat(s)).toContain("[data-glass-variant='confirm']");
      expect(flat(s)).toContain("[data-glass-role='step-up']");
    }
  });

  it('the step-up: 420 px; the code 48 px tall, its digits 20 px spaced .3em', () => {
    expect(at(ADMIN, "[data-glass='dialog'][data-glass-role='step-up']")['max-width']).toBe(
      '420px',
    );
    const code = at(
      ADMIN,
      "[data-glass='step-up-field'] [data-glass='input'][inputmode='numeric']",
    );
    expect(code.height).toBe('48px');
    expect(code['font-size']).toBe('20px');
    expect(code['letter-spacing']).toBe('0.3em');
  });

  it('Order items access: 560 px; the after-saving note 10 x 12 at radius 12 on surface 2; the chosen card on the selection tint', () => {
    expect(
      at(ADMIN, "[data-glass='dialog'][data-glass-role='order-items-access']")['max-width'],
    ).toBe('560px');
    const note = at(ADMIN, "[data-glass-role='order-items-access-after']");
    expect(note.padding).toBe('10px 12px');
    expect(note['border-radius']).toBe('12px');
    expect(note['background-color']).toBe('var(--lg-surface-2)');
    const chosen = at(
      ADMIN,
      "[data-glass='dialog'] [data-glass='radio-group'][data-glass-variant='card'] > label:has(> [data-glass='radio']:checked)",
    );
    expect(chosen['background-color']).toBe('var(--lg-sel-fill)');
    expect(chosen['border-color']).toBe('var(--lg-accent)');
  });
});

describe('settings and admin pages', () => {
  it('the page head: the 26/32 title, 24/30 on a phone', () => {
    const h1 = at(ADMIN, "[data-glass='page-header'] h1");
    expect(h1['font-size']).toBe('26px');
    expect(h1['line-height']).toBe('32px');
    const phone = at(ADMIN, "[data-glass='page-header'] h1", ['(max-width: 760px)']);
    expect(phone['font-size']).toBe('24px');
    expect(phone['line-height']).toBe('30px');
  });

  it('a page drawn outside the frame (the hub’s error and loading) sits in the page box, ahead of the frame’s rule', () => {
    const own = ADMIN.findIndex(
      (r) =>
        r.selectors.some((s) =>
          flat(s).endsWith(
            "[data-glass-page='settings']:is([data-slot='settings-page'], [data-glass-view='loading'])",
          ),
        ) && r.media.length === 0,
    );
    const framed = ADMIN.findIndex(
      (r) =>
        r.selectors.some((s) =>
          flat(s).endsWith(
            "[data-glass-page='settings'] :is([data-slot='settings-page'], [data-glass-view='loading'])",
          ),
        ) && r.media.length === 0,
    );
    expect(own).toBeGreaterThan(-1);
    expect(framed).toBeGreaterThan(own);
    expect(ADMIN[own]!.decls.padding).toBe('6px 28px 48px');
  });

  it('the admin hub rows take only the hub’s list card, never the platform block', () => {
    const rows = ADMIN.filter((r) =>
      r.selectors.some((s) => flat(s).includes("[data-glass-page='admin'][data-glass-view='hub']")),
    );
    const listRows = rows.filter((r) => r.selectors.some((s) => flat(s).includes('> ul > li > a')));
    expect(listRows.length).toBeGreaterThan(0);
    for (const r of listRows) {
      for (const s of r.selectors)
        expect(flat(s)).toContain('> div:not([data-slot]) > ul > li > a');
    }
    const row = at(ADMIN, '> div:not([data-slot]) > ul > li > a');
    expect(row['min-height']).toBe('56px');
    expect(row.padding).toBe('12px 16px');
  });
});
