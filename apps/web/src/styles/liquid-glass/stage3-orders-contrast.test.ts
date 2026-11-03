// @vitest-environment node
import { readFileSync } from 'node:fs';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { OUTPUT_PATH } from '../../../scripts/liquid-glass/gen-tokens.mjs';

/**
 * AA CONTRAST OF THE STAGE 3 ORDERS PAIRS (plans/REVISION-DEFAULT.md R11):
 * the Orders list, Place an order, the order page and its dialogs, Manage
 * order items and the digital pick, computed from the generated tokens in
 * Day and Night, for the normal, reduced and contrast materials.
 *
 * What this can prove and what it cannot: a translucent fill is composited
 * over the opaque ground glass falls back to without the scene photo
 * (--lg-bg), layer by layer as the page stacks them (the pane, then the card
 * or the overlay glass, then the badge wash or the row tint). Over the photo
 * itself the result depends on the pixels behind the frost, which no token
 * fixes: that is left to the lab's screenshot contrast check (stage 5) and
 * recorded as unproven in stage3/orders-rows.md. The reduced and contrast
 * materials are opaque, so there the figures are exact.
 *
 * Words the classic semantic colours draw (text-muted-foreground and the
 * like, remapped for glass in stage 2) are that stage's pairs, not these.
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
    rule.walkDecls(/^--lg-/u, (d) => {
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

/** A token or a plain colour. */
const colour = (t: Tokens, name: string): Rgba =>
  parse(name.startsWith('--') ? (t[name] ?? `missing ${name}`) : name);

/** The ground (--lg-bg) with each layer composited on it, bottom first. */
const stack = (t: Tokens, layers: string[]) =>
  layers.reduce<Rgba>((acc, layer) => over(colour(t, layer), acc), colour(t, '--lg-bg'));

const CARD = ['--lg-pane', '--lg-card-fill'];
const OVERLAY = ['--lg-pane', '--lg-scrim', '--lg-glass-strong'];

/** [what, foreground, layers under it (bottom first), minimum]. */
const PAIRS: Array<[string, string, string[], number]> = [
  // The Orders list (Orders.dc.html)
  ['stage tab (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  ['current stage tab (ink) on the pane', '--lg-ink', ['--lg-pane'], 4.5],
  ['stage underline (accent) on the pane', '--lg-accent', ['--lg-pane'], 3],
  [
    'filter chip (accent text) on its wash',
    '--lg-accent-text',
    ['--lg-pane', '--lg-accent-wash'],
    4.5,
  ],
  ['table header (ink 3) on the header band', '--lg-ink-3', [...CARD, '--lg-card-fill-2'], 4.5],
  ['order number (accent text) on the card', '--lg-accent-text', CARD, 4.5],
  ['row text (ink) on the card', '--lg-ink', CARD, 4.5],
  ['row text (ink) on a hovered row', '--lg-ink', [...CARD, '--lg-card-hover'], 4.5],
  ['row detail (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  ['last update and pager (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['Approved (accent text) on its wash', '--lg-accent-text', [...CARD, '--lg-accent-wash'], 4.5],
  ['work stage (ink 2) on the neutral wash', '--lg-ink-2', [...CARD, '--lg-neutral-wash'], 4.5],
  ['waiting (warn) on its wash', '--lg-warn', [...CARD, '--lg-warn-wash'], 4.5],
  ['done (ok) on its wash', '--lg-ok', [...CARD, '--lg-ok-wash'], 4.5],
  ['denied (danger) on its wash', '--lg-danger', [...CARD, '--lg-danger-wash'], 4.5],
  ['outline badge (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  [
    'empty state tile icon (accent text) on its wash',
    '--lg-accent-text',
    [...CARD, '--lg-accent-wash'],
    3,
  ],
  [
    'Export menu row (ink) on the overlay glass',
    '--lg-ink',
    ['--lg-pane', '--lg-glass-strong'],
    4.5,
  ],
  [
    'Export sub-line (ink 3) on the overlay glass',
    '--lg-ink-3',
    ['--lg-pane', '--lg-glass-strong'],
    4.5,
  ],
  // Place an order (Order-New.dc.html)
  ['setup step (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  ['search words (ink) on the field frost', '--lg-ink', ['--lg-pane', '--lg-field-fill'], 4.5],
  ['product name (ink) on the product card', '--lg-ink', CARD, 4.5],
  ['product code (ink 3) on the product card', '--lg-ink-3', CARD, 4.5],
  ['tinted Add (accent text) on its wash', '--lg-accent-text', [...CARD, '--lg-accent-wash'], 4.5],
  ['in stock (ok) on its wash', '--lg-ok', [...CARD, '--lg-ok-wash'], 4.5],
  ['low stock (warn) on its wash', '--lg-warn', [...CARD, '--lg-warn-wash'], 4.5],
  ['stepper figure (ink) on surface 3', '--lg-ink', [...CARD, '--lg-surface-3'], 4.5],
  ['Review (on accent) on the accent', '--lg-on-accent', ['--lg-pane', '--lg-accent'], 4.5],
  ['cart line (ink 2) on the cart glass', '--lg-ink-2', CARD, 4.5],
  ['review sheet (ink) on the overlay glass', '--lg-ink', OVERLAY, 4.5],
  ['review note (ink 3) on the overlay glass', '--lg-ink-3', OVERLAY, 4.5],
  ['review line (ink) in the reading area', '--lg-ink', [...OVERLAY, '--lg-field-fill'], 4.5],
  // The order page (Order-Detail.dc.html)
  ['head subline (ink 2) on the pane', '--lg-ink-2', ['--lg-pane'], 4.5],
  ['fulfilment badge (ink 2) on the pane', '--lg-ink-2', ['--lg-pane'], 4.5],
  [
    'status on the pane (accent text on its wash)',
    '--lg-accent-text',
    ['--lg-pane', '--lg-accent-wash'],
    4.5,
  ],
  [
    'status on the pane (ink 2 on the neutral wash)',
    '--lg-ink-2',
    ['--lg-pane', '--lg-neutral-wash'],
    4.5,
  ],
  ['status on the pane (warn on its wash)', '--lg-warn', ['--lg-pane', '--lg-warn-wash'], 4.5],
  ['card title (ink) on the card', '--lg-ink', CARD, 4.5],
  ['card line (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['Total qty (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['date and detail label (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['date and detail value (ink) on the card', '--lg-ink', CARD, 4.5],
  ['requester note (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  ['held step note (warn) on its tile', '--lg-warn', [...CARD, '--lg-card-fill-2'], 4.5],
  ['Deny (danger) on the field frost', '--lg-danger', [...CARD, '--lg-field-fill'], 4.5],
  ['dialog title (ink) on the overlay glass', '--lg-ink', OVERLAY, 4.5],
  ['dialog words (ink 2) on the overlay glass', '--lg-ink-2', OVERLAY, 4.5],
  ['dialog field (ink) in the reading area', '--lg-ink', [...OVERLAY, '--lg-field-fill'], 4.5],
  ['Deny request (white) on the danger fill', '#FFFFFF', ['--lg-danger-fill'], 4.5],
  // Focus ring (R11)
  ['focus ring on the pane', '--lg-focus', ['--lg-pane'], 3],
  ['focus ring on a card', '--lg-focus', CARD, 3],
  ['focus ring on the overlay glass', '--lg-focus', OVERLAY, 3],
  ['focus ring in the reading area', '--lg-focus', [...OVERLAY, '--lg-field-fill'], 3],
];

const VARIANTS = variants();

describe('stage 3 Orders contrast, from the tokens (R11)', () => {
  it('computes WCAG ratios and composites translucent layers', () => {
    expect(contrast(parse('#777777'), parse('#FFFFFF'))).toBeCloseTo(4.48, 2);
    expect(contrast(parse('#000000'), parse('#FFFFFF'))).toBeCloseTo(21, 5);
    expect(over(parse('rgba(0,0,0,.5)'), parse('#FFFFFF'))).toEqual([127.5, 127.5, 127.5, 1]);
    expect(parse('transparent')[3]).toBe(0);
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
      for (const [what, fg, layers, min] of PAIRS) {
        const r = contrast(colour(tokens, fg), stack(tokens, layers));
        if (!(r >= min)) fails.push(`${what}: ${r.toFixed(2)} < ${min}`);
      }
      expect(fails).toEqual([]);
    });
  }
});
