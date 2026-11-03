#!/usr/bin/env node
/**
 * Generates apps/web/src/styles/liquid-glass/tokens.generated.css from
 * apps/web/src/styles/liquid-glass/tokens.source.json (the pruned design-system
 * extraction, stockpilot-work/liquid-glass/spec/tokens.json), so no glass value
 * is ever retyped by hand (Liquid Glass plan 4.2).
 *
 *   node apps/web/scripts/liquid-glass/gen-tokens.mjs          write the file
 *   node apps/web/scripts/liquid-glass/gen-tokens.mjs --check  exit 1 when it is stale
 *
 * What it emits, all inside `@layer lg { @media screen { ... } }` and scoped to
 * :root[data-appearance="liquid-glass"] (Day glass) and the same with `.dark`
 * (Night glass), so classic Dark and Light never match a rule:
 *   1. Every artifact token as `--lg-<name>` (full colour values, gradients,
 *      shadows, sizes), read by the glass materials and primitives.
 *   2. The app's semantic HSL triplets (--background, --card, --accent, ...),
 *      ALWAYS OPAQUE. Eighteen classic sites add their own alpha as
 *      `hsl(var(--x) / a)`; an alpha inside a triplet would make those
 *      declarations invalid. A translucent artifact value is flattened over the
 *      variant's opaque --bg first. The translucency is carried by (3).
 *   3. Translucent fills as full colour values on the Tailwind colour
 *      properties themselves (--color-card, --color-popover, ...), on :root,
 *      where @theme computes them.
 *   4. The editorial raw tokens (--ed-*), which are full colours already.
 *   5. The type stacks (system font first, then the self-hosted Inter / JetBrains
 *      Mono through the next/font variables), set on <body> so the next/font
 *      variables on <html> can be read without a var() cycle.
 *   6. Reduce Transparency, no-backdrop-filter support, High Contrast and
 *      forced colours: the WHOLE opaque set for the OS setting (finding F2), and
 *      for Night glass the documented intent, opaque chrome, instead of the
 *      literal translucent values (finding F1). Both are recorded deviations.
 * The scene image: emitted only when the files exist under
 * apps/web/public/liquid-glass/ (scene-day / scene-night, .avif .webp .jpg);
 * until the owner supplies them it is `none` and the opaque --bg shows (Q7).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const SOURCE = join(WEB, 'src', 'styles', 'liquid-glass', 'tokens.source.json');
const OUTPUT = join(WEB, 'src', 'styles', 'liquid-glass', 'tokens.generated.css');
const PUBLIC_SCENE = join(WEB, 'public', 'liquid-glass');

export const ROOT = ':root[data-appearance="liquid-glass"]';
export const ROOT_DARK = `${ROOT}.dark`;

// ── Colour maths ──────────────────────────────────────────────────────────

/** [r, g, b, a] (0-255, 0-1) for #rgb, #rrggbb, rgb(), rgba() and transparent; null otherwise. */
export function parseColour(value) {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    const [r, g, b] = parts.slice(0, 3).map(Number);
    const a = parts.length === 4 ? Number(parts[3]) : 1;
    if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null;
    return [r, g, b, a];
  }
  return null;
}

/** Flatten a colour over an opaque ground (both [r,g,b,a]); returns opaque [r,g,b,1]. */
export function over(top, ground) {
  const a = top[3];
  return [0, 1, 2].map((i) => Math.round(top[i] * a + ground[i] * (1 - a))).concat(1);
}

/** "H S% L%" for an opaque [r,g,b]. */
export function toTriplet([r, g, b]) {
  const [rr, gg, bb] = [r, g, b].map((n) => n / 255);
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
  }
  const f = (n) => String(Math.round(n * 10) / 10);
  return `${f(h)} ${f(s * 100)}% ${f(l * 100)}%`;
}

// ── What maps to what ─────────────────────────────────────────────────────

/** A token name, or `{ light, dark }` per scheme; a value starting with # is a literal. */
export const TRIPLETS = {
  '--background': 'bg',
  '--foreground': 'ink',
  '--card': 'surface',
  '--card-foreground': 'ink',
  '--popover': 'chrome',
  '--popover-foreground': 'ink',
  '--primary': 'ink',
  '--primary-foreground': 'surface',
  '--secondary': 'surface-3',
  '--secondary-foreground': 'ink',
  '--muted': 'surface-3',
  '--muted-foreground': 'ink-3',
  '--accent': 'accent',
  '--accent-foreground': 'accent-text',
  '--accent-ink': 'on-accent',
  '--destructive': 'danger',
  '--destructive-foreground': { light: '#FFFFFF', dark: 'bg' },
  '--destructive-wash': 'danger-wash',
  '--success': 'ok',
  '--success-foreground': { light: '#FFFFFF', dark: 'bg' },
  '--success-wash': 'ok-wash',
  '--warning': 'warn',
  '--warning-foreground': { light: '#FFFFFF', dark: 'bg' },
  '--warning-wash': 'warn-wash',
  '--border': 'line',
  '--input': 'input-line',
  '--ring': 'focus',
  '--chart-1': 'accent',
  '--chart-2': 'warn-fill',
  '--chart-3': 'danger-fill',
  '--chart-4': 'info-fill',
  '--chart-5': 'ink-4',
  '--ed-accent': 'accent',
  '--ed-accent-wash': 'accent-wash',
};

/** Full colour values (translucency allowed) on the Tailwind colour properties. */
export const COLOUR_PROPERTIES = {
  '--color-card': 'card-fill',
  '--color-popover': 'glass-strong',
  '--color-secondary': 'surface-3',
  '--color-muted': 'surface-3',
  '--color-border': 'line',
  '--color-input': 'input-line',
};

/** The editorial raw tokens: full colours already (globals.css :root / .dark). */
export const EDITORIAL = {
  '--ed-bg': 'bg',
  '--ed-bg-elev': 'surface',
  '--ed-bg-sunk': 'surface-3',
  '--ed-ink': 'ink',
  '--ed-ink-2': 'ink-2',
  '--ed-ink-3': 'ink-3',
  '--ed-ink-4': 'ink-4',
  '--ed-ink-5': 'line-3',
  '--ed-line': 'line',
  '--ed-line-strong': 'line-2',
};

/** The variants emitted, with where each block goes. */
const VARIANTS = [
  { key: 'light.glass', scheme: 'light', material: 'glass' },
  { key: 'dark.glass', scheme: 'dark', material: 'glass' },
  { key: 'light.reduced', scheme: 'light', material: 'reduced' },
  { key: 'dark.reduced', scheme: 'dark', material: 'reduced' },
  { key: 'light.contrast', scheme: 'light', material: 'contrast' },
  { key: 'dark.contrast', scheme: 'dark', material: 'contrast' },
];

/**
 * Finding F1: in the literal CSS, Night glass under Reduce Transparency or
 * High Contrast keeps translucent floating and overlay materials. The written
 * intent is "every layer turns opaque", so every opaque material uses
 * --chrome, the pane is transparent and the inner glass highlight goes.
 */
function applyOpaqueIntent(tokens, material) {
  if (material === 'glass') return tokens;
  return {
    ...tokens,
    '--glass': tokens['--chrome'],
    '--glass-strong': tokens['--chrome'],
    '--glass-clear': tokens['--chrome'],
    '--glass-inner': 'none',
    '--pane': 'transparent',
  };
}

function resolveRef(tokens, ref, scheme) {
  const name = typeof ref === 'string' ? ref : ref[scheme];
  if (name.startsWith('#')) return name;
  const value = tokens[`--${name}`];
  if (value === undefined) throw new Error(`token --${name} is missing`);
  return value;
}

function tripletOf(tokens, ref, scheme) {
  const ground = parseColour(tokens['--bg']);
  if (!ground || ground[3] !== 1) throw new Error('--bg must be an opaque colour');
  const value = resolveRef(tokens, ref, scheme);
  const colour = parseColour(value);
  if (!colour) throw new Error(`cannot read ${value} as a colour`);
  return toTriplet(over(colour, ground));
}

function sceneValue(scheme, sceneFiles) {
  const base = scheme === 'dark' ? 'scene-night' : 'scene-day';
  const formats = [
    ['avif', 'image/avif'],
    ['webp', 'image/webp'],
    ['jpg', 'image/jpeg'],
  ].filter(([ext]) => sceneFiles.includes(`${base}.${ext}`));
  if (formats.length === 0) return 'none';
  return `image-set(${formats.map(([ext, type]) => `url(/liquid-glass/${base}.${ext}) type("${type}")`).join(', ')})`;
}

function declarationsFor(source, variant, sceneFiles) {
  const tokens = applyOpaqueIntent(source.variants[variant.key], variant.material);
  const lines = [];
  lines.push(`    /* ${variant.key}: artifact tokens */`);
  for (const [name, value] of Object.entries(tokens).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    --lg-${name.slice(2)}: ${value};`);
  }
  lines.push(
    `    --lg-scene-img: ${variant.material === 'glass' ? sceneValue(variant.scheme, sceneFiles) : 'none'};`,
  );
  lines.push('    /* semantic triplets: always opaque (no alpha inside a triplet) */');
  for (const [name, ref] of Object.entries(TRIPLETS)) {
    lines.push(`    ${name}: ${tripletOf(tokens, ref, variant.scheme)};`);
  }
  lines.push('    /* translucent fills, as full colour values */');
  for (const [name, ref] of Object.entries(COLOUR_PROPERTIES)) {
    lines.push(`    ${name}: ${resolveRef(tokens, ref, variant.scheme)};`);
  }
  lines.push('    /* editorial raw tokens */');
  for (const [name, ref] of Object.entries(EDITORIAL)) {
    lines.push(`    ${name}: ${resolveRef(tokens, ref, variant.scheme)};`);
  }
  return lines.join('\n');
}

/** The type stacks: system font first, then the self-hosted faces next/font loads. */
function fontBlock(source) {
  const swap = (stack) =>
    stack
      .replace('"Inter"', 'var(--lg-font-inter)')
      .replace('"JetBrains Mono"', 'var(--lg-font-jetbrains)')
      .replace(/,/g, ', ');
  const { families } = source.typography;
  return [
    `  ${ROOT} {`,
    '    /* next/font puts its family names on <html> as --font-sans / --font-mono;',
    '       read them here, on <html>, so <body> can use them without a var() cycle. */',
    '    --lg-font-inter: var(--font-sans);',
    '    --lg-font-jetbrains: var(--font-mono);',
    '  }',
    `  ${ROOT} body {`,
    `    --font-sans: ${swap(families['--font'])};`,
    `    --font-display: ${swap(families['--font-display'])};`,
    '    /* The artifact has no serif face: emphasis uses the display stack. */',
    `    --font-serif: ${swap(families['--font-display'])};`,
    `    --font-mono: ${swap(families['--font-mono'])};`,
    '  }',
  ].join('\n');
}

function block(selector, body, indent = '  ') {
  return `${indent}${selector} {\n${body
    .split('\n')
    .map((l) => indent.slice(2) + l)
    .join('\n')}\n${indent}}`;
}

/** The whole generated stylesheet as text. Pure: the caller passes the scene files present. */
export function generateTokensCss(source, { sceneFiles = [] } = {}) {
  const by = Object.fromEntries(VARIANTS.map((v) => [v.key, v]));
  const decl = (key) => declarationsFor(source, by[key], sceneFiles);
  const opaque = (material) =>
    [
      block(ROOT, decl(`light.${material}`), '    '),
      block(ROOT_DARK, decl(`dark.${material}`), '    '),
    ].join('\n');

  return [
    '/* GENERATED by apps/web/scripts/liquid-glass/gen-tokens.mjs from tokens.source.json.',
    '   Do not edit by hand: change the source or the generator and run it again.',
    '   Every rule is scoped to :root[data-appearance="liquid-glass"] inside @media screen',
    '   (glass-scope.guard.test.ts). */',
    '@layer lg {',
    '@media screen {',
    block(ROOT, decl('light.glass')),
    block(ROOT_DARK, decl('dark.glass')),
    fontBlock(source),
    '  /* Reduce Transparency (OS) and browsers without backdrop-filter: the whole opaque set. */',
    '  @media (prefers-reduced-transparency: reduce) {',
    opaque('reduced'),
    '  }',
    '  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {',
    opaque('reduced'),
    '  }',
    '  /* Increased contrast (OS): opaque, 1.5 px borders, darker ink, 3 px focus. */',
    '  @media (prefers-contrast: more) {',
    opaque('contrast'),
    '  }',
    '  /* Forced colours: system colours for every material (the handoff recipe). */',
    '  @media (forced-colors: active) {',
    `    ${ROOT} {`,
    '      --lg-glass: Canvas;',
    '      --lg-glass-strong: Canvas;',
    '      --lg-glass-clear: Canvas;',
    '      --lg-card-fill: Canvas;',
    '      --lg-card-fill-2: Canvas;',
    '      --lg-field-fill: Field;',
    '      --lg-pane: Canvas;',
    '      --lg-chrome: Canvas;',
    '      --lg-card-line: CanvasText;',
    '      --lg-glass-edge: none;',
    '      --lg-card-edge: none;',
    '      --lg-glass-blur: 0px;',
    '      --lg-pane-blur: none;',
    '      --lg-scene-img: none;',
    '      --lg-scene-veil: none;',
    '    }',
    '  }',
    '}',
    '}',
    '',
  ].join('\n');
}

export function readSource() {
  return JSON.parse(readFileSync(SOURCE, 'utf8'));
}

export function presentSceneFiles() {
  const names = ['scene-day', 'scene-night'].flatMap((b) =>
    ['avif', 'webp', 'jpg'].map((e) => `${b}.${e}`),
  );
  return names.filter((n) => existsSync(join(PUBLIC_SCENE, n)));
}

export const OUTPUT_PATH = OUTPUT;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const css = generateTokensCss(readSource(), { sceneFiles: presentSceneFiles() });
  if (process.argv.includes('--check')) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current !== css) {
      console.error(
        'tokens.generated.css is stale: run node apps/web/scripts/liquid-glass/gen-tokens.mjs',
      );
      process.exit(1);
    }
    console.info('tokens.generated.css is up to date');
  } else {
    writeFileSync(OUTPUT, css);
    console.info(`wrote ${OUTPUT}`);
  }
}
