// @vitest-environment node
import { readFileSync } from 'node:fs';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { OUTPUT_PATH } from '../../../scripts/liquid-glass/gen-tokens.mjs';

/**
 * AA CONTRAST OF THE STAGE 4 INSIGHTS PAIRS (plans/REVISION-DEFAULT.md R11):
 * the colours pages/insights.css, pages/reports.css, pages/links.css and
 * states.css give the reports hub, the reports and Book Order Totals, the
 * Briefing, AI, Help, Support, What's New, Zendesk, Notifications, Team and
 * the audit log, the pages people open from a link, the states a route
 * shows instead of its page, and the overlays those open, computed from the
 * generated tokens in Day and Night, for the normal, reduced and contrast
 * materials.
 *
 * What this can prove and what it cannot: a translucent fill is composited
 * over the opaque ground glass falls back to without the scene photo
 * (--lg-bg), layer by layer as the page stacks them (the pane, then the card
 * or the overlay glass, then the wash or the row tint). The pages people
 * open from a link and the 404 and root error cards float on the scene
 * itself, with no pane. Over the photo the result depends on the pixels
 * behind the frost, which no token fixes: that is left to the lab's
 * screenshot contrast check (stage 5) and recorded as unproven in
 * stage4/insights-rows.md. The reduced and contrast materials are opaque,
 * so there the figures are exact.
 *
 * Words the classic semantic colours draw (text-muted-foreground and the
 * like, remapped for glass in stage 2) are that stage's pairs, not these.
 * Not measured, as decorative: the hub tiles' chevron in ink 4 (the whole
 * tile is the link and its name says where it goes) and the calendar's
 * today ring in line 3 (today is also announced by aria-current and is not
 * a state the picker needs).
 *
 * Thresholds: 4.5:1 for text, 3:1 for the focus ring and for meaningful
 * non-text marks (WCAG 1.4.3, 1.4.11).
 */

const ROOT = ':root[data-appearance="liquid-glass"]';

type Tokens = Record<string, string>;

function variants(): Record<string, Tokens> {
  const out: Record<string, Tokens> = {
    day: {},
    night: {},
    dayReduced: {},
    nightReduced: {},
    dayContrast: {},
    nightContrast: {},
  };
  postcss.parse(readFileSync(OUTPUT_PATH, 'utf8')).walkRules((rule) => {
    const media: string[] = [];
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule') {
        const at = p as postcss.AtRule;
        if (at.name === 'supports') media.push('supports');
        else if (at.name === 'media' && at.params !== 'screen') media.push(at.params);
      }
    }
    const selectors = rule.selector.split(',').map((s) => s.trim());
    const decls: Tokens = {};
    // The --lg- tokens, and the one classic semantic token this lane stacks
    // text on (the history's unread wash, bg-success-wash/60).
    rule.walkDecls(/^--(lg-|success-wash$)/u, (d) => {
      decls[d.prop] = d.value;
    });
    const put = (day: string, night: string) => {
      if (selectors.includes(ROOT)) Object.assign(out[day]!, decls);
      if (selectors.includes(`${ROOT}.dark`)) Object.assign(out[night]!, decls);
    };
    if (media.length === 0) put('day', 'night');
    else if (media.length === 1 && media[0] === '(prefers-reduced-transparency: reduce)') {
      put('dayReduced', 'nightReduced');
    } else if (media.length === 1 && media[0] === '(prefers-contrast: more)') {
      put('dayContrast', 'nightContrast');
    }
  });
  for (const k of ['dayReduced', 'dayContrast']) out[k] = { ...out.day, ...out[k] };
  for (const k of ['nightReduced', 'nightContrast']) out[k] = { ...out.night, ...out[k] };
  return out;
}

type Rgba = [number, number, number, number];

function parse(value: string): Rgba {
  const c = value.trim();
  if (c === 'transparent') return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{6})$/iu.exec(c);
  if (m) {
    const h = m[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  m = /^#([0-9a-f]{3})$/iu.exec(c);
  if (m) return [...m[1]!].map((h) => parseInt(h + h, 16)).concat(1) as Rgba;
  m = /^rgba?\(([^)]*)\)$/iu.exec(c);
  if (m) {
    const p = m[1]!.split(',').map((x) => Number(x.trim()));
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  throw new Error(`not a plain colour: ${value}`);
}

const over = (fg: Rgba, bg: Rgba): Rgba => {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
};
const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgba) =>
  0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const contrast = (a: Rgba, b: Rgba) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The selected segment's lift (primitives.css: white at 90% by day, 16% by
 *  night), the one plain colour these pages stack. */
const SEG_ON = { day: 'rgba(255, 255, 255, 0.9)', night: 'rgba(255, 255, 255, 0.16)' };

/** A token, the selected segment's lift ('seg-on'), the accent at 12%
 *  ('accent-12': the menus' and the Status rows' hover, a color-mix with
 *  transparent) or a plain colour. */
const colour = (t: Tokens, name: string, night = false): Rgba => {
  if (name === 'success-wash-60') {
    // An HSL triplet ("141.2 43.6% 92.4%"), drawn at 60% (bg-success-wash/60).
    const [hue, sat, light] = (t['--success-wash'] ?? 'missing --success-wash')
      .split(/\s+/u)
      .map((x) => Number.parseFloat(x));
    const sN = sat! / 100;
    const lN = light! / 100;
    const k = (n: number) => (n + hue! / 30) % 12;
    const a = sN * Math.min(lN, 1 - lN);
    const f = (n: number) =>
      255 * (lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
    return [f(0), f(8), f(4), 0.6];
  }
  if (name === 'accent-12') {
    const a = parse(t['--lg-accent'] ?? 'missing --lg-accent');
    return [a[0], a[1], a[2], a[3] * 0.12];
  }
  return parse(
    name === 'seg-on'
      ? SEG_ON[night ? 'night' : 'day']
      : name.startsWith('--')
        ? (t[name] ?? `missing ${name}`)
        : name,
  );
};

/** The ground (--lg-bg) with each layer composited on it, bottom first. */
const stack = (t: Tokens, layers: string[], night = false) =>
  layers.reduce<Rgba>(
    (acc, layer) => over(colour(t, layer, night), acc),
    colour(t, '--lg-bg', night),
  );

const CARD = ['--lg-pane', '--lg-card-fill'];
const BAND = [...CARD, '--lg-card-fill-2'];
const OVERLAY = ['--lg-pane', '--lg-scrim', '--lg-glass-strong'];
const READING = [...OVERLAY, '--lg-field-fill'];
/** A menu or popover: the strong glass over the page, no scrim. */
const MENU = ['--lg-pane', '--lg-glass-strong'];
const SEG = ['--lg-pane', '--lg-surface-3'];
/** A card on the scene itself (the link pages, the 404 and root error). */
const SCENE_CARD = ['--lg-card-fill'];

/** [what, foreground, layers under it (bottom first), minimum]. */
const PAIRS: Array<[string, string, string[], number]> = [
  // The frame every insights page shares (pages/insights.css)
  ['page title (ink) on the pane', '--lg-ink', ['--lg-pane'], 4.5],
  ['head subline (ink 2) on the pane', '--lg-ink-2', ['--lg-pane'], 4.5],
  ['back link (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  ['segment (ink 2) on the track', '--lg-ink-2', SEG, 4.5],
  ['selected segment (ink) on its lift', '--lg-ink', [...SEG, 'seg-on'], 4.5],
  ['figure label (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['figure (ink) on the card', '--lg-ink', CARD, 4.5],
  ['card title (ink) on the card', '--lg-ink', CARD, 4.5],
  ['table header (ink 3) on the band', '--lg-ink-3', BAND, 4.5],
  ['row text (ink) on the card', '--lg-ink', CARD, 4.5],
  ['row detail (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  ['row meta and pager (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['hovered row (ink) on the card hover', '--lg-ink', [...CARD, '--lg-card-hover'], 4.5],
  ['pager (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  ['outline badge (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  ['neutral badge (ink 2) on its wash', '--lg-ink-2', [...CARD, '--lg-neutral-wash'], 4.5],
  [
    'accent badge (accent text) on its wash',
    '--lg-accent-text',
    [...CARD, '--lg-accent-wash'],
    4.5,
  ],
  ['info badge on its wash', '--lg-info', [...CARD, '--lg-info-wash'], 4.5],
  ['warn badge on its wash', '--lg-warn', [...CARD, '--lg-warn-wash'], 4.5],
  ['ok badge on its wash', '--lg-ok', [...CARD, '--lg-ok-wash'], 4.5],
  ['danger badge on its wash', '--lg-danger', [...CARD, '--lg-danger-wash'], 4.5],
  ['empty tile icon (ink 3) on surface 3', '--lg-ink-3', [...CARD, '--lg-surface-3'], 3],
  ['failed tile icon (danger) on its wash', '--lg-danger', [...CARD, '--lg-danger-wash'], 3],
  ['label in a list (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['dialog title (ink) on the overlay glass', '--lg-ink', OVERLAY, 4.5],
  ['dialog words (ink 2) on the overlay glass', '--lg-ink-2', OVERLAY, 4.5],
  // Notifications, Team, the audit log (the board panels)
  ['alert eyebrow (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  ['alert title (ink) on the list card', '--lg-ink', CARD, 4.5],
  ['alert line (ink 3) on the list card', '--lg-ink-3', CARD, 4.5],
  ['alert tone dot (info) on its wash', '--lg-info', [...CARD, '--lg-info-wash'], 3],
  ['alert tone dot (warn) on its wash', '--lg-warn', [...CARD, '--lg-warn-wash'], 3],
  ['alert tone dot (danger) on its wash', '--lg-danger', [...CARD, '--lg-danger-wash'], 3],
  ['alert tone dot (ok) on its wash', '--lg-ok', [...CARD, '--lg-ok-wash'], 3],
  ['member initials (white) on the slate disc', '#FFFFFF', [...CARD, '#4E6A8C'], 4.5],
  ['member initials (white) on hue c1', '#FFFFFF', [...CARD, '#2F7A68'], 4.5],
  ['member initials (white) on hue c2', '#FFFFFF', [...CARD, '#6A4FA0'], 4.5],
  ['member initials (white) on hue c3', '#FFFFFF', [...CARD, '#A0543A'], 4.5],
  ['member initials (white) on hue c4', '#FFFFFF', [...CARD, '#3D63A8'], 4.5],
  ['member initials (white) on hue c5', '#FFFFFF', [...CARD, '#7A6A2E'], 4.5],
  ['member initials (white) on hue c6', '#FFFFFF', [...CARD, '#8C3F6B'], 4.5],
  ['history eyebrow (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  ['history title (ink) on the pane', '--lg-ink', ['--lg-pane'], 4.5],
  ['history line (ink 2) on the pane', '--lg-ink-2', ['--lg-pane'], 4.5],
  ['history time (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  ['unread title (ink) on the unread wash', '--lg-ink', ['--lg-pane', 'success-wash-60'], 4.5],
  ['unread line (ink 2) on the unread wash', '--lg-ink-2', ['--lg-pane', 'success-wash-60'], 4.5],
  ['unread time (ink 3) on the unread wash', '--lg-ink-3', ['--lg-pane', 'success-wash-60'], 4.5],
  // The reports hub (pages/reports.css, Reports.dc.html)
  ['feature eyebrow (accent text) on the card', '--lg-accent-text', CARD, 4.5],
  ['feature title (ink) on the card', '--lg-ink', CARD, 4.5],
  ['feature line (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  ['group eyebrow (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  ['report name (ink) on the tile', '--lg-ink', CARD, 4.5],
  ['report line (ink 3) on the tile', '--lg-ink-3', CARD, 4.5],
  ['report icon (ink 2) on surface 3', '--lg-ink-2', [...CARD, '--lg-surface-3'], 3],
  // Book Order Totals (Book-Order-Totals.dc.html)
  ['filter label (ink 2) on the filter card', '--lg-ink-2', CARD, 4.5],
  ['filter value (ink) on the field frost', '--lg-ink', [...CARD, '--lg-field-fill'], 4.5],
  ['filter hint (ink 3) on the filter card', '--lg-ink-3', CARD, 4.5],
  ['field line (input line) on the card', '--lg-input-line', [...CARD, '--lg-field-fill'], 3],
  [
    'scope chip (accent text) on the selection fill',
    '--lg-accent-text',
    ['--lg-pane', '--lg-sel-fill'],
    4.5,
  ],
  [
    'scope chip hovered remove (accent text) on wash 2',
    '--lg-accent-text',
    ['--lg-pane', '--lg-sel-fill', '--lg-accent-wash-2'],
    4.5,
  ],
  ['charter row (ink) hovered on surface 2', '--lg-ink', [...CARD, '--lg-surface-2'], 4.5],
  ['charter count (ink 3) hovered on surface 2', '--lg-ink-3', [...CARD, '--lg-surface-2'], 4.5],
  ['missing cover (ink 3) on surface 3', '--lg-ink-3', [...CARD, '--lg-surface-3'], 4.5],
  ['scope lines (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  // The report menus (pages/insights.css)
  ['menu row (ink) on the menu glass', '--lg-ink', MENU, 4.5],
  ['menu row hovered (ink) on the accent 12%', '--lg-ink', [...MENU, 'accent-12'], 4.5],
  ['menu second line and note (ink 3) on the menu glass', '--lg-ink-3', MENU, 4.5],
  ['menu icon (ink 3) on the menu glass', '--lg-ink-3', MENU, 3],
  ['charter field (ink) on the field frost', '--lg-ink', ['--lg-pane', '--lg-field-fill'], 4.5],
  // The Orders placed range (pages/reports.css, .dr-pop)
  ['range field label (ink 2) on the popover', '--lg-ink-2', MENU, 4.5],
  ['range field (ink) on the field frost', '--lg-ink', [...MENU, '--lg-field-fill'], 4.5],
  ['month title (ink) on the popover', '--lg-ink', MENU, 4.5],
  ['weekday (ink 3) on the popover', '--lg-ink-3', MENU, 4.5],
  ['day (ink) on the popover', '--lg-ink', MENU, 4.5],
  ['hovered day (ink) on surface 3', '--lg-ink', [...MENU, '--lg-surface-3'], 4.5],
  [
    'day in the range (accent text) on the band',
    '--lg-accent-text',
    [...MENU, '--lg-accent-wash'],
    4.5,
  ],
  ['range end (on accent) on the accent', '--lg-on-accent', [...MENU, '--lg-accent'], 4.5],
  ['range end fill (accent) against the band', '--lg-accent', [...MENU, '--lg-accent-wash'], 3],
  ['range hint and zone (ink 3) on the popover', '--lg-ink-3', MENU, 4.5],
  ['range error (danger) on the popover', '--lg-danger', MENU, 4.5],
  ['month arrows (ink 2) on the popover', '--lg-ink-2', MENU, 3],
  // The Status choice
  ['status legend (ink 3) on the popover', '--lg-ink-3', MENU, 4.5],
  ['status row (ink) on the popover', '--lg-ink', MENU, 4.5],
  ['status row hovered (ink) on the accent 12%', '--lg-ink', [...MENU, 'accent-12'], 4.5],
  ['status detail (ink 3) on the accent 12%', '--lg-ink-3', [...MENU, 'accent-12'], 4.5],
  ['status checkbox (accent) on the popover', '--lg-accent', MENU, 3],
  // The orders behind a total (the drawer)
  ['drawer title (ink) on the overlay glass', '--lg-ink', OVERLAY, 4.5],
  ['drawer description (ink 2) on the overlay glass', '--lg-ink-2', OVERLAY, 4.5],
  ['drawer close (ink 2) on the overlay glass', '--lg-ink-2', OVERLAY, 3],
  ['drawer close hovered (ink) on surface 3', '--lg-ink', [...OVERLAY, '--lg-surface-3'], 3],
  ['drawer terms (ink 3) in the reading well', '--lg-ink-3', READING, 4.5],
  ['drawer values (ink) in the reading well', '--lg-ink', READING, 4.5],
  ['drawer table band (ink 3) on card fill 2', '--lg-ink-3', [...READING, '--lg-card-fill-2'], 4.5],
  ['drawer order number (accent text) in the well', '--lg-accent-text', READING, 4.5],
  [
    'drawer order number (accent text) on a hovered row',
    '--lg-accent-text',
    [...READING, '--lg-card-hover'],
    4.5,
  ],
  ['drawer row (ink) on a hovered row', '--lg-ink', [...READING, '--lg-card-hover'], 4.5],
  ['range day focus ring on the popover', '--lg-focus', MENU, 3],
  // The pages people open from a link (pages/links.css): cards on the scene
  ['link card title (ink) on the card', '--lg-ink', SCENE_CARD, 4.5],
  ['link card words (ink 2) on the card', '--lg-ink-2', SCENE_CARD, 4.5],
  ['link eyebrow and meta (ink 3) on the card', '--lg-ink-3', SCENE_CARD, 4.5],
  ['request ID (ink) on the inner card', '--lg-ink', [...SCENE_CARD, '--lg-card-fill-2'], 4.5],
  ['link field (ink) on the field frost', '--lg-ink', [...SCENE_CARD, '--lg-field-fill'], 4.5],
  ['portal cart bar (ink) on the glass', '--lg-ink', ['--lg-glass'], 4.5],
  ['in-cart card edge (accent) on the card', '--lg-accent', SCENE_CARD, 3],
  // The states (states.css)
  ['status card title (ink) on the scene card', '--lg-ink', SCENE_CARD, 4.5],
  ['status card words (ink 2) on the scene card', '--lg-ink-2', SCENE_CARD, 4.5],
  ['404 eyebrow (ink 3) on the scene card', '--lg-ink-3', SCENE_CARD, 4.5],
  ['error card title (ink) on the card', '--lg-ink', CARD, 4.5],
  ['error card words (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  ['error digest (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['error message (ink 2) on the inner well', '--lg-ink-2', BAND, 4.5],
  ['error tile icon (danger) on its wash', '--lg-danger', [...CARD, '--lg-danger-wash'], 3],
  // Focus ring (R11)
  ['focus ring on the pane', '--lg-focus', ['--lg-pane'], 3],
  ['focus ring on a card', '--lg-focus', CARD, 3],
  ['focus ring on a scene card', '--lg-focus', SCENE_CARD, 3],
  ['focus ring on the overlay glass', '--lg-focus', OVERLAY, 3],
  ['focus ring on the menu glass', '--lg-focus', MENU, 3],
  ['focus ring in the reading well', '--lg-focus', READING, 3],
];

const VARIANTS = variants();

describe('stage 4 insights contrast, from the tokens (R11)', () => {
  it('computes WCAG ratios and composites translucent layers', () => {
    expect(contrast(parse('#777777'), parse('#FFFFFF'))).toBeCloseTo(4.48, 2);
    expect(contrast(parse('#000000'), parse('#FFFFFF'))).toBeCloseTo(21, 5);
    expect(over(parse('rgba(0,0,0,.5)'), parse('#FFFFFF'))).toEqual([127.5, 127.5, 127.5, 1]);
    expect(parse('transparent')[3]).toBe(0);
    expect(colour({ '--lg-accent': '#0B7A5C' }, 'accent-12')[3]).toBeCloseTo(0.12, 5);
    expect(colour({ '--success-wash': '0 0% 100%' }, 'success-wash-60')).toEqual([
      255, 255, 255, 0.6,
    ]);
    const green = colour({ '--success-wash': '120 100% 25%' }, 'success-wash-60');
    expect(green.map((c) => Math.round(c * 10) / 10)).toEqual([0, 127.5, 0, 0.6]);
  });

  it('reads all six token sets', () => {
    for (const [name, t] of Object.entries(VARIANTS)) {
      expect(Object.keys(t).length, name).toBeGreaterThan(50);
      expect(t['--lg-bg'], name).toBeTruthy();
    }
  });

  for (const [name, tokens] of Object.entries(VARIANTS)) {
    it(`${name}: every pair meets its threshold`, () => {
      const fails: string[] = [];
      const night = name.startsWith('night');
      for (const [what, fg, layers, min] of PAIRS) {
        const r = contrast(colour(tokens, fg, night), stack(tokens, layers, night));
        if (!(r >= min)) fails.push(`${what}: ${r.toFixed(2)} < ${min}`);
      }
      expect(fails).toEqual([]);
    });
  }
});
