// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import postcss from 'postcss';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { cssRules, GLASS_DIR, normaliseQuotes, type CssRule } from './glass-css';

/**
 * NO WORDS ON THE BARE PICTURE, ON THE PAGES PEOPLE OPEN FROM A LINK (R11).
 *
 * Those pages have no workspace pane: Liquid Glass takes their classic ground
 * away and the scene picture shows (pages/links.css). The token contrast
 * tests composite fills over the opaque ground only and say so
 * (stage4-insights-contrast.test.ts: "over the photo the result depends on
 * the pixels behind the frost, which no token fixes"). The lab then measured
 * the public order page (/r/<token>) in Day glass at 1440 px: "Powered by
 * StockPilot" 1.31:1 and the intro line 4.06:1, both ink 3 straight on the
 * picture, because that page was never given a surface.
 *
 * This test measures against the PICTURE FILES (public/liquid-glass), cropped
 * as `center / cover` crops them for a desktop and a phone window, under the
 * scene's veil, with the generated Day and Night tokens. No blur is modelled:
 * a blur only averages neighbouring pixels, so the lowest figure here is the
 * floor of what a browser draws. It pins:
 *  - the defect: on the bare picture ink 3 falls under 4.5:1 in Day (so a
 *    rule that puts words there is wrong, whatever the tokens say);
 *  - the public order page's sheet (storefront.glass.css): the overlay fill,
 *    under which ink, ink 2 and ink 3 hold 4.5:1 over every part of both
 *    pictures;
 *  - the "Powered by StockPilot" pill (pages/links.css): ink 2 on the
 *    floating glass holds 4.5:1 everywhere; ink 3 would not, which is why
 *    the pill is ink 2;
 *  - that those two rules use exactly those fills and inks, and that the
 *    page's own quiet words are ink 3 (the classic --ed-ink-3 the storefront
 *    reads is the glass ink 3).
 */

const ROOT = ":root[data-appearance='liquid-glass']";
const PUBLIC = join(__dirname, '..', '..', '..', 'public', 'liquid-glass');
/** One sample per 4 CSS px. */
const STEP = 4;
const WINDOWS = [
  { name: '1440 x 900', w: 1440, h: 900 },
  { name: '390 x 844', w: 390, h: 844 },
] as const;

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

function colour(value: string): Rgba {
  const c = value.trim();
  let m = /^#([0-9a-f]{6})$/iu.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  m = /^rgba?\(([^)]*)\)$/iu.exec(c);
  if (m) {
    const p = m[1]!.split(',').map((x) => Number(x.trim()));
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  throw new Error(`not a plain colour: ${value}`);
}
const over = (top: Rgba, under: Rgb): Rgb => [
  top[0] * top[3] + under[0] * (1 - top[3]),
  top[1] * top[3] + under[1] * (1 - top[3]),
  top[2] * top[3] + under[2] * (1 - top[3]),
];
const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgb | Rgba) =>
  0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The normal (no media query) Day and Night token sets. */
function tokens(): Record<'day' | 'night', Record<string, string>> {
  const out = { day: {} as Record<string, string>, night: {} as Record<string, string> };
  const root = ROOT.replace(/'/g, '"');
  postcss.parse(readFileSync(join(GLASS_DIR, 'tokens.generated.css'), 'utf8')).walkRules((rule) => {
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type !== 'atrule') continue;
      const at = p as postcss.AtRule;
      if (at.name === 'supports' || (at.name === 'media' && at.params !== 'screen')) return;
    }
    const target =
      rule.selector === root ? out.day : rule.selector === `${root}.dark` ? out.night : null;
    if (!target) return;
    rule.walkDecls(/^--(lg-|ed-ink-3$)/u, (d) => {
      target[d.prop] = d.value;
    });
  });
  return out;
}

/** The scene as a window of that size shows it: `center / cover`, under the veil (top to bottom). */
async function scene(file: string, veil: string, w: number, h: number): Promise<Rgb[]> {
  const stops = [...veil.matchAll(/rgba?\([^)]*\)/gu)].map((m) => colour(m[0]));
  expect(stops.length, `two veil stops in ${veil}`).toBe(2);
  const cols = Math.round(w / STEP);
  const rows = Math.round(h / STEP);
  const { data, info } = await sharp(join(PUBLIC, file))
    .resize(cols, rows, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(3);
  const out: Rgb[] = [];
  for (let y = 0; y < rows; y += 1) {
    const f = rows === 1 ? 0 : y / (rows - 1);
    const [a, b] = stops as [Rgba, Rgba];
    const tint: Rgba = [
      a[0] * (1 - f) + b[0] * f,
      a[1] * (1 - f) + b[1] * f,
      a[2] * (1 - f) + b[2] * f,
      a[3] * (1 - f) + b[3] * f,
    ];
    for (let x = 0; x < cols; x += 1) {
      const i = (y * cols + x) * 3;
      out.push(over(tint, [data[i]!, data[i + 1]!, data[i + 2]!]));
    }
  }
  return out;
}

/** The lowest contrast of `ink` over the scene, bare or under `fill`. */
function lowest(pixels: Rgb[], ink: string, fill: string | null): number {
  const inkL = luminance(colour(ink));
  const f = fill ? colour(fill) : null;
  let min = Infinity;
  for (const px of pixels) min = Math.min(min, contrast(inkL, luminance(f ? over(f, px) : px)));
  return min;
}

const T = tokens();
const FILES = { day: 'scene-light.jpg', night: 'scene-dark.jpg' } as const;
const SCENES = new Map<string, Rgb[]>();

beforeAll(async () => {
  for (const scheme of ['day', 'night'] as const) {
    for (const win of WINDOWS) {
      SCENES.set(
        `${scheme} ${win.name}`,
        await scene(FILES[scheme], T[scheme]['--lg-scene-veil']!, win.w, win.h),
      );
    }
  }
});

describe('the link pages: contrast over the scene picture itself', () => {
  it('reads the tokens and the two pictures', () => {
    for (const scheme of ['day', 'night'] as const) {
      for (const name of [
        '--lg-ink',
        '--lg-ink-2',
        '--lg-ink-3',
        '--lg-glass',
        '--lg-glass-strong',
        '--lg-scene-veil',
      ]) {
        expect(T[scheme][name], `${scheme} ${name}`).toBeTruthy();
      }
      // The storefront's classic words read --ed-ink-3: in glass that is ink 3.
      expect(T[scheme]['--ed-ink-3']).toBe(T[scheme]['--lg-ink-3']);
    }
    for (const win of WINDOWS) {
      expect(SCENES.get(`day ${win.name}`)!.length).toBe(
        Math.round(win.w / STEP) * Math.round(win.h / STEP),
      );
    }
  });

  it('the defect: on the bare Day picture ink 3 is under 4.5:1 (and under 3:1) somewhere at both widths', () => {
    for (const win of WINDOWS) {
      const low = lowest(SCENES.get(`day ${win.name}`)!, T.day['--lg-ink-3']!, null);
      expect(low, win.name).toBeLessThan(3);
    }
    // The lab's own figure for the top right corner at 1440 px was 1.31:1.
    expect(lowest(SCENES.get('day 1440 x 900')!, T.day['--lg-ink-3']!, null)).toBeLessThan(1.5);
  });

  for (const scheme of ['day', 'night'] as const) {
    for (const win of WINDOWS) {
      const where = `${scheme} ${win.name}`;
      it(`${where}: on the public order page's sheet ink, ink 2 and ink 3 hold 4.5:1 over every part of the picture`, () => {
        const px = SCENES.get(where)!;
        for (const ink of ['--lg-ink', '--lg-ink-2', '--lg-ink-3']) {
          expect(
            lowest(px, T[scheme][ink]!, T[scheme]['--lg-glass-strong']!),
            ink,
          ).toBeGreaterThanOrEqual(4.5);
        }
      });
      it(`${where}: on the "Powered by StockPilot" pill ink 2 holds 4.5:1 over every part of the picture`, () => {
        expect(
          lowest(SCENES.get(where)!, T[scheme]['--lg-ink-2']!, T[scheme]['--lg-glass']!),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('why the pill is ink 2: ink 3 on the floating glass falls under 4.5:1 over the darkest part of the Day picture', () => {
    expect(
      lowest(SCENES.get('day 1440 x 900')!, T.day['--lg-ink-3']!, T.day['--lg-glass']!),
    ).toBeLessThan(4.5);
  });
});

describe('the rules that put those surfaces under the words', () => {
  const flat = (rule: CssRule) => normaliseQuotes(rule.selectors.join(', ').replace(/\s+/g, ' '));
  const one = (file: string, selector: string): CssRule => {
    const hits = cssRules(file).filter((r) => r.media.length === 0 && flat(r) === selector);
    expect(hits.length, `${file}: ${selector}`).toBe(1);
    return hits[0]!;
  };

  it('the public order page is a sheet of the overlay fill, and nothing on it moves', () => {
    const sheet = one('storefront.glass.css', `${ROOT} .sp-storefront.sf-public`);
    expect(sheet.decls['background-color']).toBe('var(--lg-glass-strong)');
    // The margin and the padding cancel: the words stay where Classic puts them.
    expect(sheet.decls.margin).toBe('-12px');
    expect(sheet.decls.padding).toBe('12px');
    // No stacking context and no containing block for the page's fixed overlays.
    for (const prop of [
      'backdrop-filter',
      '-webkit-backdrop-filter',
      'position',
      'isolation',
      'transform',
      'filter',
      'opacity',
      'z-index',
      'overflow',
    ]) {
      expect(sheet.decls[prop], prop).toBeUndefined();
    }
  });

  it('the sheet is the only rule of storefront.glass.css that reaches the public page', () => {
    const reaching = cssRules('storefront.glass.css').filter((r) =>
      r.selectors.some((s) => /\.sf-public/u.test(s) && !/:not\(\.sf-public\)/u.test(s)),
    );
    expect(reaching.map(flat)).toEqual([`${ROOT} .sp-storefront.sf-public`]);
  });

  it('the page that draws .sf-public loads the sheet, and only that page', () => {
    const page = readFileSync(
      join(__dirname, '..', '..', 'app', 'r', '[token]', 'page.tsx'),
      'utf8',
    );
    expect(page).toContain("import '@/styles/liquid-glass/storefront.glass.css';");
    expect(page.match(/className="sp-storefront sf-public"/gu)?.length).toBe(2);
  });

  it('"Powered by StockPilot" is an ink 2 pill of the floating glass, with its blur dropped where the cards drop theirs', () => {
    const footer = `${ROOT} [data-glass-page='links'] [data-slot='external-footer']`;
    const pill = one('pages/links.css', footer);
    expect(pill.decls).toMatchObject({
      'background-color': 'var(--lg-glass)',
      color: 'var(--lg-ink-2)',
      'backdrop-filter': 'blur(var(--lg-glass-blur)) saturate(var(--lg-glass-sat))',
      width: 'fit-content',
    });
    const noBlur = cssRules('pages/links.css').filter(
      (r) =>
        r.decls['backdrop-filter'] === 'none' && flat(r).includes("[data-slot='external-footer']"),
    );
    expect(noBlur.map((r) => r.media.join(' | ') || 'low-power twin').sort()).toEqual([
      '(forced-colors: active)',
      '(prefers-reduced-transparency: reduce), (prefers-contrast: more)',
      'low-power twin',
    ]);
  });
});
