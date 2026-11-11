// @vitest-environment node
import { readFileSync } from 'node:fs';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { OUTPUT_PATH } from '../../../scripts/liquid-glass/gen-tokens.mjs';

/**
 * AA CONTRAST OF THE STAGE 4 ADMIN LANE (settings, the admin pages, the
 * platform console and the dialogs they open; plans/REVISION-DEFAULT.md R11),
 * computed from the generated tokens in Day and Night, for the normal,
 * reduced and contrast materials, the way stage3-contrast.test.ts does it: a
 * translucent layer is composited over the opaque ground (--lg-bg) layer by
 * layer as the page stacks them, and a translucent foreground over what it
 * sits on. Over the scene photo the figures depend on its pixels: left to the
 * lab's screenshot check (stage 5) and recorded in stage4/admin-rows.md.
 *
 * The console's staff bar is drawn in fixed colours (Platform-Console.dc.html
 * .plat-bar: the same dark glass in Day and Night), so its pairs are checked
 * over the three grounds that bound what can sit under its 82% fill: white
 * (the brightest photo), black and the glass ground; the reduced and
 * contrast bar is the opaque #14171F.
 *
 * Thresholds: 4.5:1 for text, 3:1 for the focus ring, icons and marks
 * (WCAG 1.4.3, 1.4.11).
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

/** A token, a plain colour, or either at an alpha ("--lg-accent@0.12"). */
const colour = (t: Tokens, name: string): Rgba => {
  const [base, alpha] = name.split('@');
  const c = parse(base!.startsWith('--') ? t[base!]! : base!);
  return alpha === undefined ? c : [c[0], c[1], c[2], c[3] * Number(alpha)];
};

/** `ground` with each layer composited on it, bottom first. */
const stack = (t: Tokens, layers: string[], ground: Rgba = colour(t, '--lg-bg')) =>
  layers.reduce<Rgba>((acc, layer) => over(colour(t, layer), acc), ground);

/** The ratio of a (possibly translucent) foreground over the stacked layers. */
const ratio = (t: Tokens, fg: string, layers: string[], ground?: Rgba) => {
  const bg = stack(t, layers, ground);
  return contrast(over(colour(t, fg), bg), bg);
};

const VARIANTS = variants();
const opaque = (name: string) => /Reduced|Contrast/u.test(name);

/**
 * The console's ground (platform.css .plat-root): the scene under a 50%
 * paper veil in Day, ink in Night; the reduced and contrast ground is
 * --lg-bg itself.
 */
const VEIL = (name: string) =>
  opaque(name) ? [] : [name.startsWith('night') ? 'rgba(8,11,10,0.5)' : 'rgba(248,244,238,0.5)'];

/** [what, foreground, layers under it (bottom first), minimum]: settings and admin, on the pane. */
const PANE_PAIRS: Array<[string, string, string[], number]> = [
  // The settings sub-nav (the rail on the pane; the phone menu on the field frost)
  ['sub-nav row (ink) on the pane', '--lg-ink', ['--lg-pane'], 4.5],
  ['sub-nav group label (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  [
    'hovered sub-nav row (ink) on the accent tint',
    '--lg-ink',
    ['--lg-pane', '--lg-accent@0.12'],
    4.5,
  ],
  ['current page check (accent text) on the pane', '--lg-accent-text', ['--lg-pane'], 3],
  ['phone menu value (ink) on the field frost', '--lg-ink', ['--lg-pane', '--lg-field-fill'], 4.5],
  [
    'phone menu label (ink 3) on the field frost',
    '--lg-ink-3',
    ['--lg-pane', '--lg-field-fill'],
    4.5,
  ],
  // Page head
  ['page title (ink) on the pane', '--lg-ink', ['--lg-pane'], 4.5],
  ['page subline (ink 2) on the pane', '--lg-ink-2', ['--lg-pane'], 4.5],
  ['eyebrow (ink 3) on the pane', '--lg-ink-3', ['--lg-pane'], 4.5],
  // Panels, hub cards and rows
  ['panel title (ink) on the card', '--lg-ink', ['--lg-pane', '--lg-card-fill'], 4.5],
  ['panel description (ink 2) on the card', '--lg-ink-2', ['--lg-pane', '--lg-card-fill'], 4.5],
  ['danger panel title (danger) on the card', '--lg-danger', ['--lg-pane', '--lg-card-fill'], 4.5],
  ['hub row line (ink 3) on the card', '--lg-ink-3', ['--lg-pane', '--lg-card-fill'], 4.5],
  [
    'hovered hub row title (ink) on the card hover',
    '--lg-ink',
    ['--lg-pane', '--lg-card-fill', '--lg-card-hover'],
    4.5,
  ],
  [
    'admin row tile icon (ink 2) on surface 3',
    '--lg-ink-2',
    ['--lg-pane', '--lg-card-fill', '--lg-surface-3'],
    3,
  ],
  ['outline badge (ink 2) on the card', '--lg-ink-2', ['--lg-pane', '--lg-card-fill'], 4.5],
  ['empty-state icon (accent text) on its wash', '--lg-accent-text', ['--lg-accent-wash'], 3],
  ['failed-state icon (danger) on its wash', '--lg-danger', ['--lg-danger-wash'], 3],
  [
    'chosen radio card (ink) on the selection tint',
    '--lg-ink',
    ['--lg-pane', '--lg-card-fill', '--lg-field-fill', '--lg-sel-fill'],
    4.5,
  ],
  [
    'chosen radio card edge (accent) on the card',
    '--lg-accent',
    ['--lg-pane', '--lg-card-fill', '--lg-field-fill'],
    3,
  ],
  ['focus ring on the card', '--lg-focus', ['--lg-pane', '--lg-card-fill'], 3],
  // Dialogs (the overlay glass over the pane)
  ['dialog title (ink) on the overlay glass', '--lg-ink', ['--lg-pane', '--lg-glass-strong'], 4.5],
  [
    'dialog description (ink 2) on the overlay glass',
    '--lg-ink-2',
    ['--lg-pane', '--lg-glass-strong'],
    4.5,
  ],
  [
    'reading area text (ink) on its frost',
    '--lg-ink',
    ['--lg-pane', '--lg-glass-strong', '--lg-field-fill'],
    4.5,
  ],
  [
    'after-saving note (ink 2) on surface 2',
    '--lg-ink-2',
    ['--lg-pane', '--lg-glass-strong', '--lg-field-fill', '--lg-surface-2'],
    4.5,
  ],
  [
    'step-up Cancel (ink 2, the ghost) on the overlay glass',
    '--lg-ink-2',
    ['--lg-pane', '--lg-glass-strong'],
    4.5,
  ],
  ['primary action (on accent) on the accent', '--lg-on-accent', ['--lg-accent'], 4.5],
];

/** The console's content pairs, on its veiled ground (prefixed per variant). */
const CONSOLE_PAIRS: Array<[string, string, string[], number]> = [
  ['console page title (ink) on the ground', '--lg-ink', [], 4.5],
  ['back link (ink 3) on the ground', '--lg-ink-3', [], 4.5],
  [
    'table header (ink 3) on the header band',
    '--lg-ink-3',
    ['--lg-card-fill', '--lg-card-fill-2'],
    4.5,
  ],
  ['row text (ink) on the table card', '--lg-ink', ['--lg-card-fill'], 4.5],
  ['row source line (ink 3) on the table card', '--lg-ink-3', ['--lg-card-fill'], 4.5],
  ['Allowed (ok) on its wash', '--lg-ok', ['--lg-card-fill', '--lg-ok-wash'], 4.5],
  ['Not allowed (ink 2, outline) on the card', '--lg-ink-2', ['--lg-card-fill'], 4.5],
  [
    'Actions cell on a phone (ink) on its chrome',
    '--lg-ink',
    ['--lg-card-fill', '--lg-chrome'],
    4.5,
  ],
  ['danger zone title (danger) on the card', '--lg-danger', ['--lg-card-fill'], 4.5],
  ['danger zone words (ink 2) on the card', '--lg-ink-2', ['--lg-card-fill'], 4.5],
  [
    'Remove organization (danger) on the danger wash',
    '--lg-danger',
    ['--lg-card-fill', '--lg-danger-wash'],
    4.5,
  ],
];

/** The staff bar's pairs: [what, foreground, layers on the bar, minimum]. */
const BAR_PAIRS: Array<[string, string, string[], number]> = [
  ['section link (72% white)', 'rgba(243,245,248,0.72)', [], 4.5],
  ['current section (white) on 12% white', '#FFFFFF', ['rgba(255,255,255,0.12)'], 4.5],
  ['hovered section (white) on 6% white', '#FFFFFF', ['rgba(255,255,255,0.06)'], 4.5],
  ['"/ Platform" (70% white)', 'rgba(243,245,248,0.7)', [], 4.5],
  ['Staff chip (amber) on its wash', '#FFC977', ['rgba(255,184,77,0.16)'], 4.5],
  ['operator address (75% white)', 'rgba(243,245,248,0.75)', [], 4.5],
  ['My workspace on its 8% white', '#F3F5F8', ['rgba(255,255,255,0.08)'], 4.5],
  ['hovered My workspace on 14% white', '#FFFFFF', ['rgba(255,255,255,0.14)'], 4.5],
  ['focus ring (#56D6A9)', '#56D6A9', [], 3],
];

describe('stage 4 admin lane contrast, from the tokens (R11)', () => {
  it('reads all six token sets', () => {
    for (const [name, t] of Object.entries(VARIANTS)) {
      expect(Object.keys(t).length, name).toBeGreaterThan(50);
      expect(t['--lg-bg'], name).toBeTruthy();
    }
  });

  it('composites a translucent foreground before it compares', () => {
    const white = parse('#FFFFFF');
    expect(ratio({}, 'rgba(0,0,0,0.5)', [], white)).toBeCloseTo(
      contrast(parse('#808080'), white),
      1,
    );
  });

  for (const [name, t] of Object.entries(VARIANTS)) {
    it(`${name}: settings, admin and their dialogs meet every minimum`, () => {
      const short = PANE_PAIRS.flatMap(([what, fg, layers, min]) => {
        const r = ratio(t, fg, layers);
        return r < min ? [`${what}: ${r.toFixed(2)} < ${min}`] : [];
      });
      expect(short).toEqual([]);
    });

    it(`${name}: the platform console's content meets every minimum on its ground`, () => {
      const short = CONSOLE_PAIRS.flatMap(([what, fg, layers, min]) => {
        const r = ratio(t, fg, [...VEIL(name), ...layers]);
        return r < min ? [`${what}: ${r.toFixed(2)} < ${min}`] : [];
      });
      expect(short).toEqual([]);
    });

    it(`${name}: the staff bar meets every minimum whatever is under it`, () => {
      const grounds: Array<[string, Rgba]> = opaque(name)
        ? [['the opaque bar', parse('#14171F')]]
        : (['#FFFFFF', '#000000', t['--lg-bg']!] as const).map((g) => [
            `the 82% bar over ${g}`,
            over(parse('rgba(16,19,26,0.82)'), parse(g)),
          ]);
      const short = grounds.flatMap(([where, bar]) =>
        BAR_PAIRS.flatMap(([what, fg, layers, min]) => {
          const r = ratio(t, fg, layers, bar);
          return r < min ? [`${what} on ${where}: ${r.toFixed(2)} < ${min}`] : [];
        }),
      );
      expect(short).toEqual([]);
    });
  }
});
