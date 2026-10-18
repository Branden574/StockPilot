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
 * P2.1c adds a fourth: .font-display was a plain class in an @layer utilities
 * block that Tailwind emits after its generated utilities, so its -0.022em
 * silently beat tracking-[-0.025em] and every other tracking utility on the
 * same element. It also adds the ink-2, line-strong and ink-4 colours.
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

/**
 * Text on a solid fill.
 *
 * The solid warning fill is the one fill left out, on purpose. Its only text
 * use is the warning Badge (`bg-warning text-warning-foreground`, "Low stock"),
 * and ink on the new light fill reads 3.58:1 (9.76:1 in dark). No token value
 * can fix that pair: --warning-foreground is also the text colour on light
 * warning tints (dashboard widgets, the public item page), where white would
 * not read. P2.2 moves the Badge to the warn-on-wash recipe (--warning on
 * --warning-wash, 4.70:1, checked in TEXT_ON_SURFACE above).
 *
 * Those tints only read in light. In dark, ink on a dark warning tint reads
 * 1.48:1 (warning/0.18 on the card) and 1.06-1.13:1 (warning/0.05), and it
 * failed the same way before P2.1. Light text there would drop the dark
 * Badge from 9.76:1 to about 1.7:1, so the owning packages move these uses
 * to `bg-warning-wash text-warning` (4.70:1 light, 8.01:1 dark) instead:
 * - P3.1: components/dashboard/widgets/recent-activity.tsx:140, the Low pill,
 *   and widgets/shared.tsx:88, the warn icon;
 * - P5.1: app/p/items/[id]/page.tsx:123, the on-hand panel at quantity 1.
 *
 * Text on the accent fill is --accent-ink only. --accent-foreground is page
 * text, so the hovers that still pair it (or ink) with bg-accent read 1.71:1
 * (3.48:1 for ink) in light on the deep teal, where the old mint gave 4.07:1
 * (8.31:1); in dark they read 1.51-1.66:1 and already failed before P2.1.
 * Each moves to the neutral hover, `hover:bg-muted hover:text-foreground`
 * (DESIGN-SPEC 2.3 item 1; ink and muted-foreground on --muted are checked in
 * TEXT_ON_SURFACE above), in the package that owns the file:
 * - P2.2: Button outline and ghost, menu, select and calendar items;
 * - P4.A2: components/inventory/staging-table.tsx:379, the type filter
 *   (accent-foreground on accent, 1.71:1);
 * - P4.F2: components/customers/customers-panel.tsx:707, the item match row
 *   (ink 3.48:1; its SKU in muted-foreground 1.21:1);
 * - P4.E2: components/reports/book-order-totals/by-charter.tsx:71, the
 *   charter row (ink 3.48:1), and showing-chips.tsx:68, the chip's remove
 *   icon (3.48:1, above the 3:1 an icon needs; it moves for the look).
 * The one other accent hover outside components/ui,
 * components/dashboard/get-started-checklist.tsx:162 (P3.1,
 * `hover:bg-accent/40`), still reads (10.69:1 light, 6.24:1 dark) and moves
 * for the look only.
 */
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

/** globals.css through Tailwind (as Next builds it), with only these classes as sources. */
async function build(classes: readonly string[]): Promise<postcss.Root> {
  const input = SOURCE.replace(
    "@import 'tailwindcss';",
    "@import 'tailwindcss' source(none);",
  ).concat(`\n@source inline("${classes.join(' ')}");\n`);
  expect(input).toContain("@import 'tailwindcss' source(none);");
  const { css } = await postcss([tailwindcss({ optimize: false })]).process(input, {
    from: GLOBALS,
  });
  return postcss.parse(css);
}

/** A class name as Tailwind writes it in a selector: `.tracking-\[-0\.025em\]`. */
function classSelector(name: string): string {
  return `.${name.replace(/[^\w-]/g, (ch) => `\\${ch}`)}`;
}

/**
 * The letter-spacing an element with these classes gets at a viewport width,
 * by the cascade: every rule here is one class in @layer utilities, so the
 * last matching declaration in the built CSS wins.
 */
function letterSpacing(
  built: postcss.Root,
  classes: readonly string[],
  widthPx: number,
): string | undefined {
  const selectors = new Set(classes.map(classSelector));
  let value: string | undefined;
  built.walkRules((rule) => {
    if (!selectors.has(rule.selector)) return;
    const media = enclosingAtRules(rule).filter((at) => at.startsWith('@media'));
    const applies = media.every((at) => {
      const min = /^@media \(width >= ([\d.]+)rem\)$/.exec(at);
      if (!min) throw new Error(`unexpected media query ${at}`);
      return widthPx >= Number(min[1]) * 16;
    });
    if (!applies) return;
    expect(enclosingAtRules(rule).at(-1), rule.selector).toBe('@layer utilities');
    rule.walkDecls('letter-spacing', (decl) => {
      value = decl.value;
    });
  });
  return value;
}

/**
 * Every tracking utility the app writes beside font-display (AST scan of
 * apps/web/src at 78c52d145: 68 class lists, plus the release drawer's
 * font-display on SheetTitle, whose own classes carry tracking-tight).
 */
const TRACKING_WITH_FONT_DISPLAY: ReadonlyArray<readonly [utility: string, letterSpacing: string]> =
  [
    ['tracking-[-0.025em]', '-0.025em'],
    ['tracking-[-0.03em]', '-0.03em'],
    ['tracking-[-0.01em]', '-0.01em'],
    ['tracking-[-0.02em]', '-0.02em'],
    ['tracking-[-0.015em]', '-0.015em'],
    ['tracking-tight', 'var(--tracking-tight)'],
    ['tracking-[-0.04em]', '-0.04em'],
    ['tracking-[-0.005em]', '-0.005em'],
  ];

/**
 * Tailwind reads this file for class names like any other source, so a class
 * the app does not use yet is joined at run time: written out whole, every
 * build would emit it (and any colour variable it needs) before a page uses it.
 */
const SM_TRACKING = ['sm', 'tracking-[-0.03em]'].join(':');

/**
 * P2.1c: the editorial colours packages asked for, light / dark. Their class
 * names are joined at run time too (prefix + name), as no page uses one yet.
 */
const EDITORIAL_COLOURS: ReadonlyArray<
  readonly [name: string, token: string, light: string, dark: string]
> = [
  ['ink-2', '--ed-ink-2', '#2a2c28', '#d8d6cc'],
  ['line-strong', '--ed-line-strong', '#d4d2c8', '#2a2b25'],
  ['ink-4', '--ed-ink-4', '#8b8e85', '#6a6b62'],
];

/** The colour utilities a package may write with these names, and what each one sets. */
const COLOUR_UTILITIES: ReadonlyArray<readonly [prefix: string, property: string]> = [
  ['text', 'color'],
  ['bg', 'background-color'],
  ['border', 'border-color'],
  ['outline', 'outline-color'],
  ['decoration', 'text-decoration-color'],
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['caret', 'caret-color'],
  ['accent', 'accent-color'],
];
const colourVar = (name: string) => `--color-${name}`;
const colourUtility = (prefix: string, name: string) => [prefix, name].join('-');

describe('globals.css follow-ups (redesign P2.1c)', () => {
  it('lets a tracking utility on the same element beat font-display, at phone and desktop widths', async () => {
    const tracking = TRACKING_WITH_FONT_DISPLAY.map(([utility]) => utility);
    const built = await build(['font-display', ...tracking, SM_TRACKING]);

    // The winning declaration for each class list the app writes. Before
    // P2.1c every one of these read -0.022em.
    for (const width of [390, 1280]) {
      expect(letterSpacing(built, ['font-display'], width)).toBe('-0.022em');
      for (const [utility, value] of TRACKING_WITH_FONT_DISPLAY) {
        expect(letterSpacing(built, ['font-display', utility], width), utility).toBe(value);
      }
      expect(letterSpacing(built, ['font-display', SM_TRACKING], width)).toBe(
        width >= 640 ? '-0.03em' : '-0.022em',
      );
    }

    // Why: every tracking rule is emitted after font-display in the same layer.
    const order: string[] = [];
    built.walkRules((rule) => {
      order.push(rule.selector);
    });
    const at = (cls: string) => order.indexOf(classSelector(cls));
    expect(tracking.filter((cls) => !(at(cls) > at('font-display')))).toEqual([]);
  });

  it('declares font-display once, as an @utility, with the same family and -0.022em', async () => {
    // Not a plain class in an @layer block any more: one top-level @utility.
    expect(rulesIn(TREE, '.font-display')).toEqual([]);
    const declared: AtRule[] = [];
    TREE.walkAtRules('utility', (rule) => {
      if (rule.params === 'font-display') declared.push(rule);
    });
    expect(declared).toHaveLength(1);
    expect(declared[0]!.parent?.type).toBe('root');

    // It merges with the family utility --font-display creates: one rule in
    // the built CSS, in the utilities layer.
    const built = await build(['font-display']);
    const own: Rule[] = [];
    built.walkRules((rule) => {
      if (rule.selector.split(',').some((s) => s.trim().startsWith('.font-display'))) {
        own.push(rule);
      }
    });
    expect(own).toHaveLength(1);
    expect(enclosingAtRules(own[0]!)).toEqual(['@layer utilities']);
    expect(Object.fromEntries(declarations(own[0]!))).toEqual({
      'font-family': 'var(--font-display)',
      'letter-spacing': '-0.022em',
    });
  });

  it('names ink-2, line-strong and ink-4 as Tailwind colours that resolve in both themes', () => {
    const themeBlocks: AtRule[] = [];
    TREE.walkAtRules('theme', (rule) => {
      themeBlocks.push(rule);
    });
    const theme = new Map<string, string>();
    themeBlocks[0]!.walkDecls((decl) => {
      theme.set(decl.prop, decl.value);
    });
    for (const [name, tokenName, light, dark] of EDITORIAL_COLOURS) {
      expect(theme.get(colourVar(name)), name).toBe(`var(${tokenName})`);
      expect([colour('light', tokenName), colour('dark', tokenName)], name).toEqual([light, dark]);
      // The plain variable of the same name stays as it was.
      expect(theme.get(`--${name}`), name).toBe(`var(${tokenName})`);
    }
    // Each colour is defined once in globals.css, and nowhere outside @theme.
    for (const [name] of EDITORIAL_COLOURS) {
      const defs: string[] = [];
      TREE.walkDecls(colourVar(name), (decl) => {
        defs.push(enclosingAtRules(decl).join(' '));
      });
      expect(defs, name).toEqual(['@theme ']);
    }
  });

  it('keeps ink-2 at text contrast and ink-4 at 3:1 on the page and on cards (glyphs and dividers only)', () => {
    const failing = THEMES.flatMap((theme) =>
      (['--background', '--card'] as const).flatMap((surface) => {
        const out: string[] = [];
        const ink2 = contrast(theme, '--ed-ink-2', surface);
        const ink4 = contrast(theme, '--ed-ink-4', surface);
        if (ink2 < 4.5) out.push(`${theme}: ink-2 on ${surface} = ${ink2.toFixed(2)}`);
        if (ink4 < 3) out.push(`${theme}: ink-4 on ${surface} = ${ink4.toFixed(2)}`);
        return out;
      }),
    );
    expect(failing).toEqual([]);
    // What the comment beside the ink-4 colour in globals.css says, so the two
    // stay in step.
    const ink4 = (theme: Theme, surface: string) => contrast(theme, '--ed-ink-4', surface);
    expect(
      [ink4('light', '--background'), ink4('dark', '--background')].map((v) => v.toFixed(2)),
    ).toEqual(['3.18', '3.61']);
    expect([ink4('light', '--card'), ink4('dark', '--card')].map((v) => v.toFixed(2))).toEqual([
      '3.33',
      '3.43',
    ]);
    // Just under 3:1 on the light hover fill and the light inset fill.
    expect(ink4('light', '--muted').toFixed(2)).toBe('2.97');
    expect(ink4('light', '--ed-bg-sunk').toFixed(3)).toBe('2.998');
    expect(Math.max(ink4('light', '--muted'), ink4('light', '--ed-bg-sunk'))).toBeLessThan(3);
  });

  it('builds each colour utility as one rule that only sets its colour, and the colours on :root', async () => {
    const built = await build(
      EDITORIAL_COLOURS.flatMap(([name]) =>
        COLOUR_UTILITIES.map(([prefix]) => colourUtility(prefix, name)),
      ),
    );
    for (const [name] of EDITORIAL_COLOURS) {
      for (const [prefix, property] of COLOUR_UTILITIES) {
        const utility = colourUtility(prefix, name);
        // One rule with one declaration: no other utility, plugin class or
        // theme key answers to the same name.
        expect(rulesIn(built, classSelector(utility)), utility).toHaveLength(1);
        const rule = onlyRule(built, classSelector(utility));
        expect(enclosingAtRules(rule), utility).toEqual(['@layer utilities']);
        expect(Object.fromEntries(declarations(rule)), utility).toEqual({
          [property]: `var(${colourVar(name)})`,
        });
      }
    }
    // The colours are emitted once, on :root in the theme layer, so .dark's
    // --ed-* values on <html> reach them; nothing else sets them.
    const emitted = new Map<string, string[]>();
    built.walkDecls(/^--color-/, (decl) => {
      const where = `${(decl.parent as Rule).selector} ${enclosingAtRules(decl).join(' ')}`;
      emitted.set(decl.prop, [...(emitted.get(decl.prop) ?? []), `${where} = ${decl.value}`]);
    });
    for (const [name, tokenName] of EDITORIAL_COLOURS) {
      expect(emitted.get(colourVar(name)), name).toEqual([
        `:root, :host @layer theme = var(${tokenName})`,
      ]);
    }
  });
});
