import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: {
    create: <T>(s: T) => s,
    flatten: (s: unknown) =>
      Object.assign(
        {},
        ...(Array.isArray(s) ? s : [s]).flat(Infinity).filter((x) => x && typeof x === 'object'),
      ),
    hairlineWidth: 0.5,
  },
}));

const { themeValueFor } = await import('../../../../lib/appearance/theme-value');
const { AA_TEXT, contrast, hexOf } = await import('../../__fixtures__/contrast');
const { glassCardStyle } = await import('../primitive-styles');
const {
  GLASS_AVATAR_FILLS,
  GLASS_TILED_INSET,
  glassAvatarFill,
  glassSettingTone,
  glassStackRow,
  glassSyncCountTone,
  glassTileFill,
  inkAlpha,
} = await import('./admin-model');

type Look = Parameters<typeof glassCardStyle>[0];

/** Every Liquid Glass look a phone can draw: Day and Night, translucent and opaque. */
const LOOKS: [string, Look][] = (
  [
    ['Day glass', 'light', 'glass'],
    ['Night glass', 'dark', 'glass'],
    ['Day, opaque', 'light', 'opaque'],
    ['Night, opaque', 'dark', 'opaque'],
  ] as const
).map(([name, mode, material]) => [
  name,
  themeValueFor('liquid-glass', mode, material, material !== 'opaque') as Look,
]);

function rgbaOf(colour: string): [number, number, number, number] {
  const c = colour.trim();
  if (c.startsWith('#')) {
    const full = c.length === 4 ? `#${[...c.slice(1)].map((x) => x + x).join('')}` : c;
    const [r, g, b] = hexOf(full)
      .slice(1)
      .match(/../g)!
      .map((h) => parseInt(h, 16)) as [number, number, number];
    return [r, g, b, 1];
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(c);
  if (!m) throw new Error(`not a colour: ${colour}`);
  const [r, g, b, a = '1'] = m[1]!.split(',').map((x) => x.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}

/** `top` composited over the opaque `under`, as #rrggbb. */
function over(top: string, under: string): string {
  const [r, g, b, a] = rgbaOf(top);
  const [R, G, B] = rgbaOf(under);
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  return `#${[mix(r, R), mix(g, G), mix(b, B)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The grouped card as it is drawn: the card fill over the page (--bg, the scene's own fallback). */
function cardOn(lg: Look): string {
  const page = over(lg.g.bg, '#000000');
  return over(glassCardStyle(lg).backgroundColor as string, page);
}

describe('the team and users monograms (Routes-Gallery-2 team rows)', () => {
  it('every fill holds white 13pt initials at AA in every look (the fills do not change with it)', () => {
    for (const fill of GLASS_AVATAR_FILLS) {
      expect(contrast('#ffffff', fill), fill).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('a person keeps one fill, chosen from the set', () => {
    for (const name of ['Alex Example', 'sam@example.test', 'R', '']) {
      const fill = glassAvatarFill(name);
      expect(GLASS_AVATAR_FILLS).toContain(fill);
      expect(glassAvatarFill(name)).toBe(fill);
    }
    // Different people are spread over the set, not all one colour.
    const fills = new Set(
      ['Alex Example', 'Blair Example', 'Casey Example', 'Drew Example', 'Emery Example'].map(
        glassAvatarFill,
      ),
    );
    expect(fills.size).toBeGreaterThan(1);
  });
});

describe('the Settings rows’ tiles', () => {
  // Every row title Settings draws (settings.tsx), with the tone its tile takes.
  const ROWS: [string, ReturnType<typeof glassSettingTone>][] = [
    ['Workspaces', 'accent'],
    ['Profile', 'accent'],
    ['Email', 'accent'],
    ['Notifications', 'danger'],
    ['Send test push', 'danger'],
    ['Integrations', 'info'],
    ['Face ID unlock', 'blue'],
    ['Change password', 'blue'],
    ['Two-factor', 'blue'],
    ['Customize tab bar', 'purple'],
    ['Appearance', 'purple'],
    ['Theme', 'purple'],
    ['Sync', 'accent'],
    ['Unsent work', 'warn'],
    ['Offline cache', 'warn'],
    ['Delete my account', 'danger'],
    ['Help & contact', 'accent'],
    ['Privacy Policy', 'accent'],
    ['Terms of Service', 'accent'],
    ["What's new", 'purple'],
  ];

  it.each(ROWS)('%s takes the %s tile', (title, tone) => {
    expect(glassSettingTone(title)).toBe(tone);
  });

  it.each(LOOKS)('every tone is an opaque fill in %s (the white glyph is decoration)', (_n, lg) => {
    for (const tone of ['accent', 'info', 'ok', 'warn', 'danger', 'blue', 'purple'] as const) {
      expect(glassTileFill(lg, tone)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('the separator starts after the tile: 16 padding + 30 tile + 12 gap', () => {
    expect(GLASS_TILED_INSET).toBe(58);
  });
});

describe.each(LOOKS)('Unsent work, Notifications and the stacked rows in %s', (_name, lg) => {
  const card = cardOn(lg);

  it('a section count reads at AA on its tinted pill, or on the page when it is plain', () => {
    const page = over(lg.g.bg, '#000000');
    for (const tone of ['warn', 'danger', undefined] as const) {
      const { wash, ink } = glassSyncCountTone(lg, tone);
      const under = wash ? over(wash, page) : page;
      expect(contrast(over(ink, under), under), String(tone)).toBeGreaterThanOrEqual(AA_TEXT);
    }
    expect(glassSyncCountTone(lg, undefined).wash).toBeNull();
  });

  it('Discard reads at AA: the refusal red on the gray iOS button over the card', () => {
    const button = over(lg.ios.fill, card);
    expect(contrast(over(lg.c.critText, button), button)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('a record’s title, sub-line and message read at AA on the card', () => {
    for (const ink of [lg.c.ink, lg.c.ink2, lg.c.ink3]) {
      expect(contrast(over(ink, card), card), ink).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('an unread notification’s words read at AA on the selection fill', () => {
    const unread = over(lg.g.selFill, card);
    for (const ink of [lg.c.ink, lg.c.ink3]) {
      expect(contrast(over(ink, unread), unread), ink).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('a stacked row carries the group’s corners at its ends and the rule between rows', () => {
    const first = glassStackRow(lg, true, false);
    const middle = glassStackRow(lg, false, false);
    const last = glassStackRow(lg, false, true);
    expect(first.borderTopLeftRadius).toBe(24);
    expect(first.borderBottomLeftRadius).toBe(0);
    expect(middle.borderTopLeftRadius).toBe(0);
    expect(middle.borderTopWidth).toBe(0.5);
    expect(middle.borderTopColor).toBe(lg.g.line2);
    expect(last.borderBottomRightRadius).toBe(24);
    expect(glassStackRow(lg, true, true).borderTopColor).toBeUndefined();
  });
});

describe('inkAlpha', () => {
  it('writes #rrggbb at an alpha, and leaves any other colour as it is', () => {
    expect(inkAlpha('#101412', 0.08)).toBe('rgba(16,20,18,0.08)');
    expect(inkAlpha('rgba(1,2,3,.5)', 0.08)).toBe('rgba(1,2,3,.5)');
  });
});
