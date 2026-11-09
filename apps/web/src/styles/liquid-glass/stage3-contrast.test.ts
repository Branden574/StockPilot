// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { OUTPUT_PATH } from '../../../scripts/liquid-glass/gen-tokens.mjs';

import { enclosing, normaliseQuotes } from './glass-css';

/**
 * AA CONTRAST OF THE STAGE 3 SHELL AND ITEMS PAIRS (plans/REVISION-DEFAULT.md
 * R11), computed from the generated tokens, in Day and Night, for the normal,
 * reduced and contrast materials.
 *
 * What this can prove and what it cannot: a translucent fill is composited
 * over the opaque ground glass falls back to without the scene photo
 * (--lg-bg), layer by layer as the page stacks them (the pane, then the card
 * or the floating glass, then the row tint). Over the photo itself the result
 * depends on the pixels behind the frost, which no token fixes: that is left
 * to the lab's screenshot contrast check (stage 5) and recorded as unproven in
 * stage3/items-rows.md. The reduced and contrast materials are opaque, so
 * there the figures are exact.
 *
 * Thresholds: 4.5:1 for text, 3:1 for the focus ring, icons and the section
 * chevron (WCAG 1.4.3, 1.4.11).
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

/** A token, a plain colour, or a token at an alpha ("--lg-accent@0.12", a color-mix with transparent). */
const colour = (t: Tokens, name: string): Rgba => {
  const [base, alpha] = name.split('@');
  const c = parse(base!.startsWith('--') ? t[base!]! : base!);
  return alpha === undefined ? c : [c[0], c[1], c[2], c[3] * Number(alpha)];
};

/** The ground (--lg-bg) with each layer composited on it, bottom first. */
const stack = (t: Tokens, layers: string[]) =>
  layers.reduce<Rgba>((acc, layer) => over(colour(t, layer), acc), colour(t, '--lg-bg'));

/** [what, foreground, layers under it (bottom first), minimum]. */
const PAIRS: Array<[string, string, string[], number]> = [
  // Sidebar (floating glass straight on the scene)
  ['nav label (ink 2) on the sidebar', '--lg-ink-2', ['--lg-glass'], 4.5],
  ['section heading (ink 3) on the sidebar', '--lg-ink-3', ['--lg-glass'], 4.5],
  ['current row (ink) on its surface', '--lg-ink', ['--lg-glass', '--lg-surface'], 4.5],
  [
    'current row icon (accent text) on its surface',
    '--lg-accent-text',
    ['--lg-glass', '--lg-surface'],
    3,
  ],
  ['nav count (ink 3) on the sidebar', '--lg-ink-3', ['--lg-glass'], 4.5],
  ['Beta / New pill (info) on its wash', '--lg-info', ['--lg-glass', '--lg-info-wash'], 4.5],
  ['identity initials (white) on the avatar colour', '#FFFFFF', ['#4E6A8C'], 4.5],
  ['alert count (danger) on its wash', '--lg-danger', ['--lg-danger-wash'], 4.5],
  ['section chevron (ink 4) on the sidebar', '--lg-ink-4', ['--lg-glass'], 3],
  // Top bar (on the pane's frost)
  ['crumbs (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  ['search words (ink 3) on the search pill', '--lg-ink-3', ['--lg-pane', '--lg-glass'], 4.5],
  ['key (ink 3) on its surface', '--lg-ink-3', ['--lg-pane', '--lg-glass', '--lg-surface'], 4.5],
  ['capsule icon (ink 2) on the capsule', '--lg-ink-2', ['--lg-pane', '--lg-glass'], 3],
  ['unread count (white) on the danger fill', '#FFFFFF', ['--lg-danger-fill'], 4.5],
  [
    'Place an order (accent text) on its wash',
    '--lg-accent-text',
    ['--lg-glass', '--lg-accent-wash'],
    4.5,
  ],
  // Menus and the command palette (overlay glass over the pane)
  ['menu row (ink) on the overlay glass', '--lg-ink', ['--lg-pane', '--lg-glass-strong'], 4.5],
  [
    'menu label (ink 3) on the overlay glass',
    '--lg-ink-3',
    ['--lg-pane', '--lg-glass-strong'],
    4.5,
  ],
  [
    'highlighted row (ink) on the accent tint',
    '--lg-ink',
    ['--lg-pane', '--lg-glass-strong', '--lg-accent@0.12'],
    4.5,
  ],
  // Items (cards on the pane)
  [
    'table header (ink 3) on the header band',
    '--lg-ink-3',
    ['--lg-pane', '--lg-card-fill', '--lg-card-fill-2'],
    4.5,
  ],
  ['row text (ink) on the card', '--lg-ink', ['--lg-pane', '--lg-card-fill'], 4.5],
  [
    'row text (ink) on a hovered row',
    '--lg-ink',
    ['--lg-pane', '--lg-card-fill', '--lg-card-hover'],
    4.5,
  ],
  [
    'row text (ink) on a ticked row',
    '--lg-ink',
    ['--lg-pane', '--lg-card-fill', '--lg-sel-fill'],
    4.5,
  ],
  ['pager and count (ink 3) on the card', '--lg-ink-3', ['--lg-pane', '--lg-card-fill'], 4.5],
  [
    'rack chip (ink 2) on surface 3',
    '--lg-ink-2',
    ['--lg-pane', '--lg-card-fill', '--lg-surface-3'],
    4.5,
  ],
  [
    'Staging rack chip (warn) on its wash',
    '--lg-warn',
    ['--lg-pane', '--lg-card-fill', '--lg-warn-wash'],
    4.5,
  ],
  [
    'Unplaced rack chip (info) on its wash',
    '--lg-info',
    ['--lg-pane', '--lg-card-fill', '--lg-info-wash'],
    4.5,
  ],
  ['selection bar (ink) on its glass', '--lg-ink', ['--lg-pane', '--lg-glass'], 4.5],
  ['filter chip (ink 2) on the field frost', '--lg-ink-2', ['--lg-pane', '--lg-field-fill'], 4.5],
  ['item header (ink) on the overlay glass', '--lg-ink', ['--lg-pane', '--lg-glass-strong'], 4.5],
  ['tab (ink 3) on the item header', '--lg-ink-3', ['--lg-pane', '--lg-glass-strong'], 4.5],
  [
    'tab underline (accent) on the item header',
    '--lg-accent',
    ['--lg-pane', '--lg-glass-strong'],
    3,
  ],
  ['SKU chip (ink 2) on the item header', '--lg-ink-2', ['--lg-pane', '--lg-glass-strong'], 4.5],
  ['figure (ink) in its well', '--lg-ink', ['--lg-pane', '--lg-card-fill-2'], 4.5],
  ['figure label (ink 3) in its well', '--lg-ink-3', ['--lg-pane', '--lg-card-fill-2'], 4.5],
  ['card title (ink) on the card', '--lg-ink', ['--lg-pane', '--lg-card-fill'], 4.5],
  // Fidelity lane detail: the item page's summary card and side column
  // (pages/item-detail.css), each layer as the page stacks it.
  [
    'summary figure (ink) in its well on the card',
    '--lg-ink',
    ['--lg-pane', '--lg-card-fill', '--lg-card-fill-2'],
    4.5,
  ],
  [
    'summary label (ink 3) in its well on the card',
    '--lg-ink-3',
    ['--lg-pane', '--lg-card-fill', '--lg-card-fill-2'],
    4.5,
  ],
  [
    'low-stock figure (warn) in its well on the card',
    '--lg-warn',
    ['--lg-pane', '--lg-card-fill', '--lg-card-fill-2'],
    4.5,
  ],
  [
    'out-of-stock figure (danger) in its well on the card',
    '--lg-danger',
    ['--lg-pane', '--lg-card-fill', '--lg-card-fill-2'],
    4.5,
  ],
  [
    'reorder alert words (ink) on the alert',
    '--lg-ink',
    ['--lg-pane', '--lg-card-fill', '--lg-card-fill-2'],
    4.5,
  ],
  [
    'reorder alert icon (warn) on the alert',
    '--lg-warn',
    ['--lg-pane', '--lg-card-fill', '--lg-card-fill-2'],
    3,
  ],
  [
    'book facts label (ink 3) on the summary card',
    '--lg-ink-3',
    ['--lg-pane', '--lg-card-fill'],
    4.5,
  ],
  ['side card words (ink 2) on the card', '--lg-ink-2', ['--lg-pane', '--lg-card-fill'], 4.5],
  ['side card note (ink 3) on the card', '--lg-ink-3', ['--lg-pane', '--lg-card-fill'], 4.5],
  [
    'Shown in Orders (accent text) on its wash',
    '--lg-accent-text',
    ['--lg-pane', '--lg-card-fill', '--lg-accent-wash'],
    4.5,
  ],
  [
    'Hidden from Orders and Expected (ink 2) on the neutral wash',
    '--lg-ink-2',
    ['--lg-pane', '--lg-card-fill', '--lg-neutral-wash'],
    4.5,
  ],
  [
    'Open the report (ink) on the field frost',
    '--lg-ink',
    ['--lg-pane', '--lg-card-fill', '--lg-field-fill'],
    4.5,
  ],
  [
    'head action (ink) on the field frost over the header',
    '--lg-ink',
    ['--lg-pane', '--lg-glass-strong', '--lg-field-fill'],
    4.5,
  ],
  [
    'More actions icon (ink 2) on the item header',
    '--lg-ink-2',
    ['--lg-pane', '--lg-glass-strong'],
    3,
  ],
  // Focus ring (R11)
  ['focus ring on the pane', '--lg-focus', ['--lg-pane'], 3],
  ['focus ring on the sidebar', '--lg-focus', ['--lg-glass'], 3],
  ['focus ring on a card', '--lg-focus', ['--lg-pane', '--lg-card-fill'], 3],
  // Stage 3 fidelity, small lane: the phone bar's title, the Books cover card
  // and Settings > Appearance (a settings card on the pane).
  ['phone bar title (ink) on the pane', '--lg-ink', ['--lg-pane'], 4.5],
  ['cover card grade (ink 3) on the card', '--lg-ink-3', ['--lg-pane', '--lg-card-fill'], 4.5],
  ['cover card figure (ink) on the card', '--lg-ink', ['--lg-pane', '--lg-card-fill'], 4.5],
  [
    'Appearance option words (ink) on the field frost',
    '--lg-ink',
    ['--lg-pane', '--lg-card-fill', '--lg-field-fill'],
    4.5,
  ],
  [
    'Appearance chosen option words (ink) on the selection wash',
    '--lg-ink',
    ['--lg-pane', '--lg-card-fill', '--lg-sel-fill'],
    4.5,
  ],
  [
    'Appearance chosen option description (ink 3) on the selection wash',
    '--lg-ink-3',
    ['--lg-pane', '--lg-card-fill', '--lg-sel-fill'],
    4.5,
  ],
  [
    'Appearance chosen edge and radio (accent) on the selection wash',
    '--lg-accent',
    ['--lg-pane', '--lg-card-fill', '--lg-sel-fill'],
    3,
  ],
  [
    'Appearance chosen edge (accent) against the card',
    '--lg-accent',
    ['--lg-pane', '--lg-card-fill'],
    3,
  ],
  ['Appearance chosen radio dot (on-accent) on the accent', '--lg-on-accent', ['--lg-accent'], 3],
  [
    'Appearance empty radio edge (ink 4) on the option',
    '--lg-ink-4',
    ['--lg-pane', '--lg-card-fill', '--lg-field-fill'],
    3,
  ],
  [
    'Appearance Theme segment (ink 2) on the track',
    '--lg-ink-2',
    ['--lg-pane', '--lg-card-fill', '--lg-surface-3'],
    4.5,
  ],
];

const VARIANTS = variants();

/**
 * The empty glass checkbox, as primitives.css draws it (the checkbox-glyph
 * rule): its edge is the only thing that shows the box is there, so the edge
 * needs 3:1 against the box's own fill and against every surface a box sits
 * on (WCAG 1.4.11). The edge and fill tokens are read from the rule itself,
 * so the pair follows the CSS. The edge is painted over the box's fill (the
 * default border-box background), which is painted over the surface.
 */
const GLYPH = ":root[data-appearance='liquid-glass'] [data-glass='checkbox-glyph']";

interface GlyphRule {
  media: string[];
  decls: Record<string, string>;
}

function glyphRules(): GlyphRule[] {
  const out: GlyphRule[] = [];
  const css = readFileSync(join(__dirname, 'primitives.css'), 'utf8');
  postcss.parse(css).walkRules((rule) => {
    if (normaliseQuotes(rule.selector.replace(/\s+/g, ' ').trim()) !== GLYPH) return;
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value;
    });
    const media = enclosing(rule)
      .filter((a) => a.startsWith('@media ') && a !== '@media screen')
      .map((a) => a.slice('@media '.length));
    out.push({ media, decls });
  });
  return out;
}

const tokenOf = (value: string | undefined) => /^var\((--lg-[\w-]+)\)$/u.exec(value ?? '')?.[1];

const GLYPH_SURFACES: Array<[string, string[]]> = [
  ['a row on the card', ['--lg-pane', '--lg-card-fill']],
  ['a hovered row', ['--lg-pane', '--lg-card-fill', '--lg-card-hover']],
  ['the table header band', ['--lg-pane', '--lg-card-fill', '--lg-card-fill-2']],
  ['the selection bar', ['--lg-pane', '--lg-glass']],
  ['a menu, popover or dialog', ['--lg-pane', '--lg-glass-strong']],
];

describe('the empty glass checkbox (primitives.css checkbox-glyph, sp.css .cb)', () => {
  const base = glyphRules().find((r) => r.media.length === 0);

  it('is the board’s box: 18 px, 24 px where a finger is the pointer, a 1.5 px edge', () => {
    expect(base?.decls.width).toBe('18px');
    expect(base?.decls.height).toBe('18px');
    expect(base?.decls['border-width']).toBe('1.5px');
    const coarse = glyphRules().find((r) => r.media.join() === '(pointer: coarse)');
    expect(coarse?.decls.width).toBe('24px');
    expect(coarse?.decls.height).toBe('24px');
  });

  for (const [name, t] of Object.entries(VARIANTS)) {
    it(`${name}: the empty box's edge reads 3:1 against its fill and every surface it sits on`, () => {
      const edgeToken = tokenOf(base?.decls['border-color']);
      const fillToken = tokenOf(base?.decls['background-color']);
      expect(edgeToken, 'the edge is a glass token').toBeTruthy();
      expect(fillToken, 'the fill is a glass token').toBeTruthy();
      const short = GLYPH_SURFACES.flatMap(([where, layers]) => {
        const surface = stack(t, layers);
        const fill = over(colour(t, fillToken!), surface);
        const edge = over(colour(t, edgeToken!), fill);
        const inside = contrast(edge, fill);
        const outside = contrast(edge, surface);
        return [
          ...(inside < 3 ? [`edge against the box on ${where}: ${inside.toFixed(2)} < 3`] : []),
          ...(outside < 3 ? [`edge against ${where}: ${outside.toFixed(2)} < 3`] : []),
        ];
      });
      expect(short).toEqual([]);
    });
  }
});

describe('stage 3 shell and Items contrast, from the tokens (R11)', () => {
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

  for (const [name, t] of Object.entries(VARIANTS)) {
    it(`${name}: every pair meets its minimum`, () => {
      const short = PAIRS.flatMap(([what, fg, layers, min]) => {
        const ratio = contrast(colour(t, fg), stack(t, layers));
        return ratio < min ? [`${what}: ${ratio.toFixed(2)} < ${min}`] : [];
      });
      expect(short).toEqual([]);
    });
  }
});
