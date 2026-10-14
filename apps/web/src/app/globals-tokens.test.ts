// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import postcss, { type AtRule, type ChildNode, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * Redesign P2.1: globals.css carries the redesign reference palette in both
 * themes (DESIGN-SPEC 2.2, PLAN P2.1), and every place the app puts text on
 * one of these colours still reads.
 *
 * Three defects the old values had, pinned here:
 * - text on the solid success fill (the success Badge) read 1.66:1 in dark,
 *   and would have read 1.71:1 in light on the new deep teal;
 * - text on the solid destructive fill (destructive Button and Badge, the
 *   notification bell's count) read 3.18:1 in dark, and 2.44:1 on the new,
 *   lighter dark fill;
 * - .dark never defined --ed-accent-wash, so dark fell back to the light wash.
 *
 * Values are read from the stylesheet (parsed with postcss) and resolved the
 * way the browser does it: .dark and :root both sit on <html>, so a token
 * .dark leaves out falls back to its :root value.
 */

const GLOBALS = join(__dirname, 'globals.css');
const SOURCE = readFileSync(GLOBALS, 'utf8');
const TREE = postcss.parse(SOURCE, { from: GLOBALS });

type Theme = 'light' | 'dark';
const THEMES: readonly Theme[] = ['light', 'dark'];

function rulesIn(tree: postcss.Root, selector: string): Rule[] {
  const found: Rule[] = [];
  tree.walkRules((rule) => {
    if (rule.selector === selector) found.push(rule);
  });
  return found;
}

function onlyRule(tree: postcss.Root, selector: string): Rule {
  const found = rulesIn(tree, selector);
  if (found.length !== 1) throw new Error(`expected one ${selector} rule, found ${found.length}`);
  return found[0]!;
}

function declarations(rule: Rule): Map<string, string> {
  const map = new Map<string, string>();
  rule.each((node) => {
    if (node.type === 'decl') map.set(node.prop, node.value);
  });
  return map;
}

/** The at-rules around a node, innermost first, as "@name params". */
function enclosingAtRules(node: ChildNode): string[] {
  const out: string[] = [];
  let parent = node.parent as ChildNode | postcss.Root | undefined;
  while (parent && parent.type !== 'root') {
    if (parent.type === 'atrule') {
      const at = parent as AtRule;
      out.push(`@${at.name} ${at.params}`);
    }
    parent = (parent as ChildNode).parent as ChildNode | postcss.Root | undefined;
  }
  return out;
}

const LIGHT = declarations(onlyRule(TREE, ':root'));
const DARK = declarations(onlyRule(TREE, '.dark'));

/** A token's value in one theme, with every var() substituted. */
function token(theme: Theme, name: string, seen: readonly string[] = []): string {
  if (seen.includes(name)) throw new Error(`var() cycle through ${name}`);
  const raw = (theme === 'dark' ? DARK.get(name) : undefined) ?? LIGHT.get(name);
  if (raw === undefined) throw new Error(`${name} is not defined for ${theme}`);
  return raw.replace(/var\((--[\w-]+)\)/g, (_match, ref: string) =>
    token(theme, ref, [...seen, name]),
  );
}

function hslToHex(triplet: string): string {
  const parts = triplet.replace(/%/g, '').trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`not an HSL triplet: "${triplet}"`);
  }
  const [h, s, l] = parts as [number, number, number];
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) =>
    Math.round(255 * (light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** A colour token as #rrggbb, whether it is stored as hex or as an HSL triplet. */
function colour(theme: Theme, name: string): string {
  const value = token(theme, name);
  return value.startsWith('#') ? value.toLowerCase() : hslToHex(value);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(theme: Theme, text: string, surface: string): number {
  const [hi, lo] = [luminance(colour(theme, text)), luminance(colour(theme, surface))].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** PLAN P2.1's token table: the exact triplet for each theme. */
const TRIPLETS: ReadonlyArray<readonly [name: string, light: string, dark: string]> = [
  ['--background', '60 23.1% 97.5%', '80 13% 4.5%'],
  ['--card', '0 0% 100%', '75 11% 7%'],
  ['--popover', '0 0% 100%', '75 11% 7%'],
  ['--foreground', '90 7.1% 5.5%', '52.5 21.1% 92.5%'],
  ['--card-foreground', '90 7.1% 5.5%', '52.5 21.1% 92.5%'],
  ['--popover-foreground', '90 7.1% 5.5%', '52.5 21.1% 92.5%'],
  ['--secondary-foreground', '90 7.1% 5.5%', '52.5 21.1% 92.5%'],
  ['--muted-foreground', '80 4% 35%', '66 4.8% 58.8%'],
  ['--border', '48 17.2% 88.6%', '72 8.5% 11.6%'],
  ['--input', '48 17.2% 88.6%', '72 8.5% 11.6%'],
  ['--muted', '51 23% 94%', '72 10.2% 9.6%'],
  ['--accent', '165 42% 32%', '165 45% 64%'],
  ['--success', '165 42% 32%', '165 45% 64%'],
  ['--accent-ink', '0 0% 100%', '158 44% 5%'],
  ['--success-wash', '165 35% 93%', '165 28% 13%'],
  ['--ed-accent-wash', '165 35% 93%', '165 28% 13%'],
  ['--warning', '34 80% 33%', '38 70% 62%'],
  ['--warning-wash', '38 70% 92%', '38 35% 12%'],
  ['--destructive', '12 68% 44%', '12 75% 64%'],
  ['--destructive-wash', '12 70% 95%', '12 35% 13%'],
  ['--primary', '90 7.1% 5.5%', '52.5 21.1% 92.5%'],
  ['--primary-foreground', '60 23.1% 97.5%', '80 13% 4.5%'],
  ['--chart-1', '165 42% 32%', '165 45% 64%'],
];

/** The reference hex each one must reproduce (DESIGN-SPEC 2.1, light / dark). */
const REFERENCE_HEX: ReadonlyArray<readonly [name: string, light: string, dark: string]> = [
  ['--background', '#fafaf7', '#0c0d0a'], // --bg
  ['--card', '#ffffff', '#131410'], // --elev
  ['--ed-bg-sunk', '#f4f3ee', '#08090a'], // --sunk
  ['--foreground', '#0e0f0d', '#f0efe8'], // --ink
  ['--ed-ink-2', '#2a2c28', '#d8d6cc'], // --ink2
  ['--muted-foreground', '#5a5d56', '#9a9b91'], // --ink3
  ['--border', '#e7e5dd', '#1f201b'], // --line
  ['--ed-line-strong', '#d4d2c8', '#2a2b25'], // --line2
  ['--muted', '#f3f2ec', '#1a1b16'], // --hover
  ['--accent', '#2f7463', '#7acdb8'], // --acc
  ['--accent-ink', '#ffffff', '#07120e'], // --accInk
  ['--success-wash', '#e7f3f0', '#182a26'], // --accWash
  ['--warning', '#975d11', '#e2b05a'], // --warn (light at 33%, DESIGN-SPEC 2.4)
  ['--warning-wash', '#f9eedc', '#292114'], // --warnWash
  ['--destructive', '#bc4224', '#e87a5e'], // --dan
  ['--destructive-wash', '#fbede9', '#2d1a16'], // --danWash
  ['--primary', '#0e0f0d', '#f0efe8'], // --btn
  ['--primary-foreground', '#fafaf7', '#0c0d0a'], // --btnInk
];

/** Text on a surface (DESIGN-SPEC 2.4 plus the app's own page-text uses). */
const TEXT_ON_SURFACE: ReadonlyArray<readonly [text: string, surface: string]> = [
  ['--foreground', '--background'],
  ['--foreground', '--card'],
  ['--foreground', '--muted'], // text on the hover and selected fill
  ['--ed-ink-2', '--card'],
  ['--muted-foreground', '--background'],
  ['--muted-foreground', '--card'],
  ['--muted-foreground', '--ed-bg-sunk'],
  ['--muted-foreground', '--muted'],
  ['--accent', '--background'],
  ['--accent', '--card'],
  ['--accent', '--success-wash'],
  ['--accent-foreground', '--background'], // accent page text: auth eyebrow, stat deltas
  ['--accent-foreground', '--card'],
  ['--warning', '--warning-wash'],
  ['--warning', '--card'],
  ['--warning', '--ed-bg-sunk'],
  ['--destructive', '--destructive-wash'],
  ['--destructive', '--card'],
];

/** Text on a solid fill. */
const TEXT_ON_FILL: ReadonlyArray<readonly [text: string, fill: string]> = [
  ['--primary-foreground', '--primary'], // ink buttons and the toast
  ['--accent-ink', '--accent'], // accent-filled buttons
  ['--success-foreground', '--success'], // the success Badge
  ['--destructive-foreground', '--destructive'], // destructive Button and Badge, bell count
  ['--secondary-foreground', '--secondary'],
];

/** The colours P2.1 adds for the redesign primitives. */
const NEW_COLOURS = [
  '--color-accent-ink',
  '--color-success-wash',
  '--color-warning-wash',
  '--color-destructive-wash',
  '--color-sunk',
];

describe('globals.css palette (redesign P2.1)', () => {
  it('sets the plan’s triplets in both themes', () => {
    const got = TRIPLETS.map(([name]) => [name, token('light', name), token('dark', name)]);
    expect(got).toEqual(TRIPLETS.map((row) => [...row]));
  });

  it('reproduces the reference hex values exactly', () => {
    const got = REFERENCE_HEX.map(([name]) => [name, colour('light', name), colour('dark', name)]);
    expect(got).toEqual(REFERENCE_HEX.map((row) => [...row]));
  });

  it('keeps what the plan keeps: accent-foreground, the ring and the focus-visible ring', () => {
    // accent-foreground is accent-coloured text on the page; turning it into
    // the on-fill ink would put white text on white (DESIGN-SPEC 2.3).
    expect(THEMES.map((t) => token(t, '--accent-foreground'))).toEqual([
      '165 22% 24%',
      '165 60% 92%',
    ]);
    expect(THEMES.map((t) => token(t, '--ring'))).toEqual(['80 7% 5%', '56 17% 92%']);
    const classes: string[] = [];
    onlyRule(TREE, ':focus-visible').walkAtRules('apply', (rule) => {
      classes.push(...rule.params.split(/\s+/));
    });
    expect(classes).toEqual(
      expect.arrayContaining(['ring-2', 'ring-ring', 'ring-offset-2', 'ring-offset-background']),
    );
  });

  it('defines the accent, wash and on-fill tokens in both themes', () => {
    const names = [
      '--ed-accent',
      '--ed-accent-wash',
      '--accent-ink',
      '--success-wash',
      '--warning-wash',
      '--destructive-wash',
    ];
    expect(names.filter((name) => !LIGHT.has(name))).toEqual([]);
    expect(names.filter((name) => !DARK.has(name))).toEqual([]);
  });

  it('meets 4.5:1 for text on every surface, light and dark', () => {
    const failing = THEMES.flatMap((theme) =>
      TEXT_ON_SURFACE.filter(([text, surface]) => contrast(theme, text, surface) < 4.5).map(
        ([text, surface]) =>
          `${theme}: ${text} on ${surface} = ${contrast(theme, text, surface).toFixed(2)}`,
      ),
    );
    expect(failing).toEqual([]);
  });

  it('meets 4.5:1 for text on every solid fill, light and dark', () => {
    const failing = THEMES.flatMap((theme) =>
      TEXT_ON_FILL.filter(([text, fill]) => contrast(theme, text, fill) < 4.5).map(
        ([text, fill]) =>
          `${theme}: ${text} on ${fill} = ${contrast(theme, text, fill).toFixed(2)}`,
      ),
    );
    expect(failing).toEqual([]);
  });

  it('maps every Tailwind colour to a token both themes define', () => {
    const themeBlocks: AtRule[] = [];
    TREE.walkAtRules('theme', (rule) => {
      themeBlocks.push(rule);
    });
    expect(themeBlocks).toHaveLength(1);
    const colours = new Map<string, string>();
    themeBlocks[0]!.walkDecls(/^--color-/, (decl) => {
      colours.set(decl.prop, decl.value);
    });
    const unresolved = [...colours].flatMap(([prop, value]) =>
      [...value.matchAll(/var\((--[\w-]+)\)/g)].flatMap(([, ref]) =>
        THEMES.flatMap((theme) => {
          try {
            colour(theme, ref!);
            return [];
          } catch {
            return [`${prop} -> ${ref} (${theme})`];
          }
        }),
      ),
    );
    expect(unresolved).toEqual([]);
    const added = Object.fromEntries([...colours].filter(([prop]) => NEW_COLOURS.includes(prop)));
    expect(added).toEqual({
      '--color-accent-ink': 'hsl(var(--accent-ink))',
      '--color-success-wash': 'hsl(var(--success-wash))',
      '--color-warning-wash': 'hsl(var(--warning-wash))',
      '--color-destructive-wash': 'hsl(var(--destructive-wash))',
      // The raw inset surface, never an alias of muted (the hover fill).
      '--color-sunk': 'var(--ed-bg-sunk)',
    });
  });

  it('pads table rows by density: 11px comfortable, 6px compact, phones stay comfortable', () => {
    // The default for anything outside a [data-density] wrapper.
    expect(LIGHT.get('--row-py')).toBe('11px');
    const rules: Record<string, string | undefined> = {};
    TREE.walkRules(/^\[data-density/, (rule) => {
      const media = enclosingAtRules(rule).filter((at) => at.startsWith('@media'));
      rules[`${rule.selector} ${media.join(' ') || '(all)'}`] = declarations(rule).get('--row-py');
    });
    expect(rules).toEqual({
      "[data-density='comfortable'] (all)": '11px',
      "[data-density='compact'] (all)": '6px',
      "[data-density='compact'] @media (width < 48rem)": '11px',
    });
  });

  it('sets the 13.5px dashboard type on .sp-shell only, on screen, in the base layer', () => {
    const shell = onlyRule(TREE, '.sp-shell');
    expect(enclosingAtRules(shell)).toEqual(['@media screen', '@layer base']);
    expect(Object.fromEntries(declarations(shell))).toEqual({
      'font-size': '13.5px',
      'line-height': '1.5',
      'letter-spacing': '-0.005em',
      // 'ss01' stays beside the reference's 'cv11' and 'tnum' (DESIGN-SPEC U4).
      'font-feature-settings': "'ss01', 'cv11', 'tnum'",
    });
    shell.walkDecls((decl) => {
      expect(decl.important, decl.prop).toBeFalsy();
    });
    // Pages outside the shell keep today's type.
    expect(declarations(onlyRule(TREE, 'body')).get('font-size')).toBe('14px');
    expect(declarations(onlyRule(TREE, 'html')).get('font-feature-settings')).toBe(
      "'ss01', 'cv11', 'tnum'",
    );
  });

  it('adds no print rules: printed pages keep their own styles', () => {
    const print: string[] = [];
    TREE.walkAtRules('media', (rule) => {
      if (/\bprint\b/.test(rule.params)) print.push(rule.params);
    });
    expect(print).toEqual([]);
  });

  it('builds the new utilities, and component utilities still beat the .sp-shell size', async () => {
    const input = SOURCE.replace(
      "@import 'tailwindcss';",
      "@import 'tailwindcss' source(none);",
    ).concat(
      '\n@source inline("bg-success-wash bg-warning-wash bg-destructive-wash bg-sunk text-accent-ink text-base");\n',
    );
    expect(input).toContain("@import 'tailwindcss' source(none);");
    const { css } = await postcss([tailwindcss({ optimize: false })]).process(input, {
      from: GLOBALS,
    });
    const built = postcss.parse(css);

    const utility = (selector: string) =>
      Object.fromEntries(declarations(onlyRule(built, selector)));
    expect(utility('.bg-success-wash')).toEqual({
      'background-color': 'var(--color-success-wash)',
    });
    expect(utility('.bg-warning-wash')).toEqual({
      'background-color': 'var(--color-warning-wash)',
    });
    expect(utility('.bg-destructive-wash')).toEqual({
      'background-color': 'var(--color-destructive-wash)',
    });
    expect(utility('.bg-sunk')).toEqual({ 'background-color': 'var(--color-sunk)' });
    expect(utility('.text-accent-ink')).toEqual({ color: 'var(--color-accent-ink)' });

    // Cascade layers decide it, not specificity: utilities come after base.
    const order: string[] = [];
    built.walkAtRules('layer', (rule) => {
      if (!rule.nodes) order.push(rule.params);
    });
    expect(order).toContain('theme, base, components, utilities');
    expect(enclosingAtRules(onlyRule(built, '.sp-shell'))).toEqual([
      '@media screen',
      '@layer base',
    ]);
    expect(enclosingAtRules(onlyRule(built, '.text-base'))).toEqual(['@layer utilities']);
  });
});
