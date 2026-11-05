// @vitest-environment node
import { readFileSync } from 'node:fs';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { OUTPUT_PATH } from '../../../scripts/liquid-glass/gen-tokens.mjs';

/**
 * AA CONTRAST OF THE SITE LANE'S PAIRS (plans/REVISION-DEFAULT.md R11): the
 * marketing twins (pages/site.css, pages/landing.css) and the sign-in shell
 * (auth.glass.css), computed from the generated tokens in Day and Night for
 * the normal, reduced and contrast materials.
 *
 * What this proves and what it cannot: each translucent layer is composited
 * over the opaque ground glass shows without the scene photo (the twins'
 * paper, --lg-paper-1, under their veils; the sign-in shell's --lg-bg), bottom
 * first, as the page stacks them. Over the photo itself the figure depends on
 * the pixels behind the frost (the landing hero's words sit straight on the
 * veiled photo), which no token fixes: that is the lab's composed-pixel check
 * (stage 5, Chromium and WebKit), recorded as open in stage3/site-rows.md. The
 * reduced and contrast materials are opaque, so there the figures are exact.
 *
 * Thresholds: 4.5:1 for text, 3:1 for field edges, the focus ring and icons
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
    const selectors = rule.selector.split(',').map((s) => s.trim().replace(/'/gu, '"'));
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

function parseColour(value: string): Rgba {
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
const ratio = (a: Rgba, b: Rgba) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const colour = (t: Tokens, name: string): Rgba =>
  parseColour(name.startsWith('--') ? t[name]! : name);

/** The ground with each layer composited on it, bottom first. */
const stack = (t: Tokens, ground: string, layers: string[]) =>
  layers.reduce<Rgba>((acc, layer) => over(colour(t, layer), acc), colour(t, ground));

/** [what, foreground, ground, layers on the ground (bottom first), minimum]. */
type Pair = [string, string, string, string[], number];

const SITE = '--lg-paper-1';
const AUTH = '--lg-bg';

const PAIRS: Pair[] = [
  // SiteNav (floating glass) and its links.
  ['nav link', '--lg-ink-2', SITE, ['--lg-glass'], 4.5],
  ['nav current link', '--lg-ink', SITE, ['--lg-glass', '--lg-surface'], 4.5],
  ['wordmark', '--lg-ink', SITE, ['--lg-glass'], 4.5],
  // Buttons.
  ['primary button', '--lg-on-accent', SITE, ['--lg-accent'], 4.5],
  ['glass button', '--lg-ink', SITE, ['--lg-glass-strong'], 4.5],
  // Page text straight on the ground (headings, ledes, eyebrows, the footer).
  ['heading on the ground', '--lg-ink', SITE, [], 4.5],
  ['lede on the ground', '--lg-ink-2', SITE, [], 4.5],
  ['muted on the ground', '--lg-ink-3', SITE, [], 4.5],
  ['eyebrow (accent text) on the ground', '--lg-accent-text', SITE, [], 4.5],
  // Cards (content glass) and what sits on them.
  ['card title', '--lg-ink', SITE, ['--lg-card-fill'], 4.5],
  ['card body', '--lg-ink-2', SITE, ['--lg-card-fill'], 4.5],
  ['card muted', '--lg-ink-3', SITE, ['--lg-card-fill'], 4.5],
  ['link in a card', '--lg-accent-text', SITE, ['--lg-card-fill'], 4.5],
  ['accent badge', '--lg-accent-text', SITE, ['--lg-card-fill', '--lg-accent-wash'], 4.5],
  ['support tile icon', '--lg-danger', SITE, ['--lg-card-fill', '--lg-danger-wash'], 3],
  ['privacy tile icon', '--lg-info', SITE, ['--lg-card-fill', '--lg-info-wash'], 3],
  ['focus ring on the nav', '--lg-focus', SITE, ['--lg-glass'], 3],
  ['focus ring on a card', '--lg-focus', SITE, ['--lg-card-fill'], 3],
  // The sign-in shell: the ring, the card, its footer band, fields and links.
  ['auth card title', '--lg-ink', AUTH, ['--lg-glass', '--lg-card-fill'], 4.5],
  ['auth card text and labels', '--lg-ink-2', AUTH, ['--lg-glass', '--lg-card-fill'], 4.5],
  [
    'auth card footer band',
    '--lg-ink-2',
    AUTH,
    ['--lg-glass', '--lg-card-fill', '--lg-card-fill-2'],
    4.5,
  ],
  ['Forgot password link', '--lg-accent-text', AUTH, ['--lg-glass', '--lg-card-fill'], 4.5],
  [
    'typed text in a field',
    '--lg-ink',
    AUTH,
    ['--lg-glass', '--lg-card-fill', '--lg-field-fill'],
    4.5,
  ],
  ['field edge', '--lg-input-line', AUTH, ['--lg-glass', '--lg-card-fill', '--lg-field-fill'], 3],
  [
    'focused field edge',
    '--lg-accent',
    AUTH,
    ['--lg-glass', '--lg-card-fill', '--lg-field-fill'],
    3,
  ],
  ['focus ring in the card', '--lg-focus', AUTH, ['--lg-glass', '--lg-card-fill'], 3],
  ['help links pill', '--lg-ink-2', AUTH, ['--lg-glass'], 4.5],
  ['invite-only line on the ground', '--lg-ink-2', AUTH, [], 4.5],
  ['Contact the team pill', '--lg-ink', AUTH, ['--lg-glass-strong'], 4.5],
  ['sign-in button', '--lg-on-accent', AUTH, ['--lg-accent'], 4.5],
];

const VARIANTS = variants();

describe('site lane AA contrast from the generated tokens (R11)', () => {
  it('the arithmetic: #777 on white is just under 4.5:1, black on white 21:1', () => {
    expect(ratio(parseColour('#777777'), parseColour('#FFFFFF'))).toBeLessThan(4.5);
    expect(ratio(parseColour('#000000'), parseColour('#FFFFFF'))).toBeCloseTo(21, 5);
  });

  it('reads all six materials', () => {
    for (const [name, tokens] of Object.entries(VARIANTS)) {
      expect(tokens['--lg-ink'], name).toBeTruthy();
      expect(tokens['--lg-paper-1'], name).toBeTruthy();
    }
  });

  for (const [variant, tokens] of Object.entries(VARIANTS)) {
    for (const [what, fg, ground, layers, min] of PAIRS) {
      it(`${variant}: ${what} at least ${min}:1`, () => {
        const back = stack(tokens, ground, layers);
        const front = over(colour(tokens, fg), back);
        expect(ratio(front, back)).toBeGreaterThanOrEqual(min);
      });
    }
  }
});
