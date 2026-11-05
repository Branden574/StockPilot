// @vitest-environment node
import { readFileSync } from 'node:fs';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { OUTPUT_PATH } from '../../../scripts/liquid-glass/gen-tokens.mjs';

/**
 * AA CONTRAST OF THE STAGE 4 OPERATIONS PAIRS (plans/REVISION-DEFAULT.md R11):
 * the colours pages/ops.css, pages/counts.css, pages/po.css and
 * pages/returns.css give the cycle counts, purchasing, returns and the other
 * operations pages and their dialogs, computed from the generated tokens in
 * Day and Night, for the normal, reduced and contrast materials.
 *
 * What this can prove and what it cannot: a translucent fill is composited
 * over the opaque ground glass falls back to without the scene photo
 * (--lg-bg), layer by layer as the page stacks them (the pane, then the card
 * or the overlay glass, then the badge wash or the row tint). Over the photo
 * itself the result depends on the pixels behind the frost, which no token
 * fixes: that is left to the lab's screenshot contrast check (stage 5) and
 * recorded as unproven in stage4/ops-rows.md. The reduced and contrast
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

/** The selected segment's lift (primitives.css: white at 90% by day, 16% by
 *  night), the one plain colour these pages stack. */
const SEG_ON = { day: 'rgba(255, 255, 255, 0.9)', night: 'rgba(255, 255, 255, 0.16)' };

/** A token, the selected segment's lift ('seg-on') or a plain colour. */
const colour = (t: Tokens, name: string, night = false): Rgba =>
  parse(
    name === 'seg-on'
      ? SEG_ON[night ? 'night' : 'day']
      : name.startsWith('--')
        ? (t[name] ?? `missing ${name}`)
        : name,
  );

/** The ground (--lg-bg) with each layer composited on it, bottom first. */
const stack = (t: Tokens, layers: string[], night = false) =>
  layers.reduce<Rgba>(
    (acc, layer) => over(colour(t, layer, night), acc),
    colour(t, '--lg-bg', night),
  );

const CARD = ['--lg-pane', '--lg-card-fill'];
const OVERLAY = ['--lg-pane', '--lg-scrim', '--lg-glass-strong'];
const READING = [...OVERLAY, '--lg-field-fill'];
const SEG = ['--lg-pane', '--lg-surface-3'];
const CARD_SEG = [...CARD, '--lg-surface-3'];

/** [what, foreground, layers under it (bottom first), minimum]. */
const PAIRS: Array<[string, string, string[], number]> = [
  // The frame every operations page shares (pages/ops.css)
  ['page title (ink) on the pane', '--lg-ink', ['--lg-pane'], 4.5],
  ['head subline (ink 2) on the pane', '--lg-ink-2', ['--lg-pane'], 4.5],
  ['segment (ink 2) on the track', '--lg-ink-2', SEG, 4.5],
  ['segment count (ink 3) on the track', '--lg-ink-3', SEG, 4.5],
  ['selected segment (ink) on its lift', '--lg-ink', [...SEG, 'seg-on'], 4.5],
  ['selected count (accent text) on its lift', '--lg-accent-text', [...SEG, 'seg-on'], 4.5],
  ['segment in a card (ink 2) on the track', '--lg-ink-2', CARD_SEG, 4.5],
  ['segment count in a card (ink 3) on the track', '--lg-ink-3', CARD_SEG, 4.5],
  ['selected segment in a card (ink) on its lift', '--lg-ink', [...CARD_SEG, 'seg-on'], 4.5],
  [
    'selected count in a card (accent text) on its lift',
    '--lg-accent-text',
    [...CARD_SEG, 'seg-on'],
    4.5,
  ],
  ['table header (ink 3) on the header band', '--lg-ink-3', [...CARD, '--lg-card-fill-2'], 4.5],
  ['row text (ink) on the card', '--lg-ink', CARD, 4.5],
  ['row detail (ink 2) on the card', '--lg-ink-2', CARD, 4.5],
  ['row time, SKU and pager (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['card title (ink) on the card', '--lg-ink', CARD, 4.5],
  ['label (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['value (ink) on the card', '--lg-ink', CARD, 4.5],
  ['figure label (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['outline badge (ink 2) inside its hairline', '--lg-ink-2', CARD, 4.5],
  ['neutral badge (ink 2) on its wash', '--lg-ink-2', [...CARD, '--lg-neutral-wash'], 4.5],
  ['in progress, received (info) on its wash', '--lg-info', [...CARD, '--lg-info-wash'], 4.5],
  ['approved (accent text) on its wash', '--lg-accent-text', [...CARD, '--lg-accent-wash'], 4.5],
  ['requested, partial (warn) on its wash', '--lg-warn', [...CARD, '--lg-warn-wash'], 4.5],
  ['received, closed (ok) on its wash', '--lg-ok', [...CARD, '--lg-ok-wash'], 4.5],
  ['denied, failed (danger) on its wash', '--lg-danger', [...CARD, '--lg-danger-wash'], 4.5],
  ['status dot (info) on its wash', '--lg-info', [...CARD, '--lg-info-wash'], 3],
  ['status dot (warn) on its wash', '--lg-warn', [...CARD, '--lg-warn-wash'], 3],
  [
    'status on the pane (accent text on its wash)',
    '--lg-accent-text',
    ['--lg-pane', '--lg-accent-wash'],
    4.5,
  ],
  ['status on the pane (warn on its wash)', '--lg-warn', ['--lg-pane', '--lg-warn-wash'], 4.5],
  [
    'status on the pane (ink 2 on the neutral wash)',
    '--lg-ink-2',
    ['--lg-pane', '--lg-neutral-wash'],
    4.5,
  ],
  ['status on the pane (info on its wash)', '--lg-info', ['--lg-pane', '--lg-info-wash'], 4.5],
  [
    'empty tile icon (accent text) on its wash',
    '--lg-accent-text',
    [...CARD, '--lg-accent-wash'],
    3,
  ],
  ['failed tile icon (danger) on its wash', '--lg-danger', [...CARD, '--lg-danger-wash'], 3],
  ['no-match tile icon (ink 3) on surface 3', '--lg-ink-3', [...CARD, '--lg-surface-3'], 3],
  ['state title (ink) on the card', '--lg-ink', CARD, 4.5],
  ['state words (ink 3) on the card', '--lg-ink-3', CARD, 4.5],
  ['dialog title (ink) on the overlay glass', '--lg-ink', OVERLAY, 4.5],
  ['dialog words (ink 2) on the overlay glass', '--lg-ink-2', OVERLAY, 4.5],
  // Cycle counts (pages/counts.css)
  ['count number (accent text) on the card', '--lg-accent-text', CARD, 4.5],
  ['counted figure (ink) in its field', '--lg-ink', [...CARD, '--lg-field-fill'], 4.5],
  ['Cancel count (danger) on the button frost', '--lg-danger', [...CARD, '--lg-field-fill'], 4.5],
  ['Review & post (on accent) on the accent', '--lg-on-accent', [...CARD, '--lg-accent'], 4.5],
  ['Review & post hovered (on accent)', '--lg-on-accent', [...CARD, '--lg-accent-hover'], 4.5],
  ['drift alert (ink) on the warning wash', '--lg-ink', [...CARD, '--lg-warn-wash'], 4.5],
  ['drift alert icon (warn) on the warning wash', '--lg-warn', [...CARD, '--lg-warn-wash'], 3],
  [
    'drift alert on the pane (ink) on the warning wash',
    '--lg-ink',
    ['--lg-pane', '--lg-warn-wash'],
    4.5,
  ],
  ['count summary bar fill (ok) on its track', '--lg-ok-fill', [...CARD, '--lg-surface-4'], 3],
  ['Lines that differ figure (ink) on the card', '--lg-ink', CARD, 4.5],
  // Purchasing (pages/po.css)
  ['PO number (accent text) on the card', '--lg-accent-text', CARD, 4.5],
  ['received figure (ink) on the card', '--lg-ink', CARD, 4.5],
  ['receive line (ink) in the reading area', '--lg-ink', READING, 4.5],
  ['receive label (ink 2) in the reading area', '--lg-ink-2', READING, 4.5],
  ['receive field (ink) on the field frost', '--lg-ink', [...READING, '--lg-field-fill'], 4.5],
  ['Post receipt (on accent) on the accent', '--lg-on-accent', [...OVERLAY, '--lg-accent'], 4.5],
  // Returns (pages/returns.css)
  ['RMA number (accent text) on the card', '--lg-accent-text', CARD, 4.5],
  ['RETURNING eyebrow (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  ['primary action (on accent) on the accent', '--lg-on-accent', [...CARD, '--lg-accent'], 4.5],
  ['secondary action (ink) on the button frost', '--lg-ink', [...CARD, '--lg-field-fill'], 4.5],
  // Focus ring (R11)
  ['focus ring on the pane', '--lg-focus', ['--lg-pane'], 3],
  ['focus ring on a card', '--lg-focus', CARD, 3],
  ['focus ring on the overlay glass', '--lg-focus', OVERLAY, 3],
  ['focus ring in the reading area', '--lg-focus', READING, 3],
];

const VARIANTS = variants();

describe('stage 4 operations contrast, from the tokens (R11)', () => {
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
      const night = name.startsWith('night');
      for (const [what, fg, layers, min] of PAIRS) {
        const r = contrast(colour(tokens, fg, night), stack(tokens, layers, night));
        if (!(r >= min)) fails.push(`${what}: ${r.toFixed(2)} < ${min}`);
      }
      expect(fails).toEqual([]);
    });
  }
});
