#!/usr/bin/env node
/**
 * Generates the phone's Liquid Glass tokens (src/lib/appearance/glass-tokens.generated.ts)
 * from src/lib/appearance/glass-tokens.source.json, so no glass value is typed by hand
 * (stockpilot-work/liquid-glass/IMPLEMENTATION-PLAN.md 5.1, 5.3).
 *
 *   node scripts/gen-glass-tokens.mjs                 write the generated file from the source
 *   node scripts/gen-glass-tokens.mjs --check         exit 1 when the committed file is stale
 *   node scripts/gen-glass-tokens.mjs --from <tokens.json>
 *                                                     re-prune the source from the full spec
 *                                                     (stockpilot-work/liquid-glass/spec/tokens.json)
 *                                                     and then write the generated file
 *
 * The spec already resolved the sp.css cascade per variant (tokens.json "variants"), so the
 * values are copied, not recomputed. One deliberate change, recorded as a deviation from the
 * literal CSS (spec/design-system.md section 16, finding F1): in the reduced variants the
 * floating and overlay glass is opaque (--chrome), the documented intent, where the literal
 * dark CSS leaves it translucent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, '../src/lib/appearance/glass-tokens.source.json');
const TARGET = join(here, '../src/lib/appearance/glass-tokens.generated.ts');

/** The variant tokens the phone reads, in output order: CSS name -> camelCase key. */
const VARIANT_KEYS = [
  '--bg',
  '--bg-2',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--surface-4',
  '--ink',
  '--ink-2',
  '--ink-3',
  '--ink-4',
  '--line',
  '--line-2',
  '--line-3',
  '--accent',
  '--accent-hover',
  '--accent-press',
  '--accent-text',
  '--on-accent',
  '--accent-wash',
  '--accent-wash-2',
  '--ok',
  '--ok-wash',
  '--ok-fill',
  '--warn',
  '--warn-wash',
  '--warn-fill',
  '--danger',
  '--danger-wash',
  '--danger-fill',
  '--info',
  '--info-wash',
  '--info-fill',
  '--card-fill',
  '--card-fill-2',
  '--card-line',
  '--chrome',
  '--glass',
  '--glass-strong',
  '--glass-clear',
  '--glass-ring',
  '--pane',
  '--pane-line',
  '--scrim',
  '--sel-fill',
  '--field-fill',
  '--field-line',
  '--focus',
];

/** Which spec variant each phone variant is (light = Day glass, dark = Night glass). */
const VARIANTS = {
  day: 'light.glass',
  night: 'dark.glass',
  dayOpaque: 'light.reduced',
  nightOpaque: 'dark.reduced',
};

const TYPE_KEYS = {
  '.ios-large': 'largeTitle',
  '.ios-h': 'heading',
  '.ios-nav .ttl': 'navTitle',
  '.ios-row': 'row',
  '.ios-sub': 'sub',
  '.ios-btn': 'button',
  '.ios-tab': 'tab',
  '.ios-seg button': 'segmented',
  '.ios-stepper output': 'stepper',
  '.count-big': 'countBig',
  '.kp-key': 'keypadKey',
  '.md-appbar .t': 'mdAppBar',
  '.md-title-m': 'mdTitleM',
  '.md-label': 'mdLabel',
  '.md-li .h': 'mdListHeadline',
  '.md-li .s': 'mdListSupporting',
  '.md-btn': 'mdButton',
  '.md-nav': 'mdNav',
};

const RADIUS_KEYS = {
  '--r-xs': 'xs',
  '--r-sm': 'sm',
  '--r-md': 'md',
  '--r-lg': 'lg',
  '--r-xl': 'xl',
  '--r-2xl': 'xxl',
  pill: 'pill',
};

const camel = (name) => name.replace(/^--/, '').replace(/-(\w)/g, (_, ch) => ch.toUpperCase());

function fail(message) {
  throw new Error(`gen-glass-tokens: ${message}`);
}

/** A colour the phone can draw: hex, rgb()/rgba() or transparent. Gradients and shadows are refused. */
function colour(value, where) {
  const v = String(value).trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v) || /^rgba?\([^()]*\)$/.test(v) || v === 'transparent') return v;
  return fail(`${where} is not a plain colour: ${v}`);
}

/** Prune the full spec into the source file: only what the phone reads. */
function prune(tokens) {
  const variants = {};
  for (const name of Object.values(VARIANTS)) {
    const all = tokens.variants?.[name] ?? fail(`spec has no variant ${name}`);
    variants[name] = Object.fromEntries(
      VARIANT_KEYS.map((k) => [k, all[k] ?? fail(`variant ${name} has no ${k}`)]),
    );
  }
  const local = (selector) =>
    (tokens.component_local_custom_properties ?? []).find((b) => b.selector === selector)
      ?.declarations ?? fail(`spec has no component block ${selector}`);
  const radii = {};
  for (const k of Object.keys(RADIUS_KEYS)) {
    radii[k] = tokens.radii?.tokens?.[k] ?? fail(`spec has no radius ${k}`);
  }
  return {
    note: 'Pruned from stockpilot-work/liquid-glass/spec/tokens.json by scripts/gen-glass-tokens.mjs --from. Design data only.',
    source: tokens.meta?.source ?? null,
    variants,
    ios: { light: local('.ios'), dark: local('[data-theme="dark"] .ios,.ios[data-theme="dark"]') },
    md: { light: local('.md'), dark: local('[data-theme="dark"] .md,.md[data-theme="dark"]') },
    typography_native: tokens.typography?.native ?? fail('spec has no typography.native'),
    radii,
  };
}

/** "34px/41px 700 -.4px" -> { fontSize, lineHeight, fontWeight, letterSpacing, fontVariant }. */
function parseType(value, where) {
  const m =
    /^(\d+(?:\.\d+)?)px(?:\/(\d+(?:\.\d+)?)px)?(?:\s+(\d{3}))?(?:\s+(-?\d*\.?\d+)px)?(\s+tabular)?$/.exec(
      String(value).trim(),
    );
  if (!m) return fail(`${where} is not a type spec: ${value}`);
  const out = { fontSize: Number(m[1]) };
  if (m[2]) out.lineHeight = Number(m[2]);
  if (m[3]) out.fontWeight = m[3];
  if (m[4]) out.letterSpacing = Number(m[4]);
  if (m[5]) out.fontVariant = ['tabular-nums'];
  return out;
}

function px(value, where) {
  const m = /^(\d+(?:\.\d+)?)px/.exec(String(value).trim());
  return m ? Number(m[1]) : fail(`${where} is not a px value: ${value}`);
}

function build(source) {
  const variants = {};
  for (const [key, name] of Object.entries(VARIANTS)) {
    const v = source.variants?.[name] ?? fail(`source has no variant ${name}`);
    const out = {};
    for (const k of VARIANT_KEYS)
      out[camel(k)] = colour(v[k] ?? fail(`${name} has no ${k}`), `${name} ${k}`);
    if (key.endsWith('Opaque')) {
      // F1: the documented intent is opaque floating and overlay glass under Reduce
      // Transparency; the literal dark CSS leaves it translucent. Opaque here, in both schemes.
      out.glass = out.chrome;
      out.glassStrong = out.chrome;
      out.glassClear = out.chrome;
      out.glassRing = out.line2;
      out.pane = 'transparent';
    }
    variants[key] = out;
  }

  const ios = {};
  const md = {};
  for (const scheme of ['light', 'dark']) {
    ios[scheme] = Object.fromEntries(
      Object.entries(source.ios?.[scheme] ?? fail(`source has no ios.${scheme}`)).map(([k, v]) => [
        camel(k.replace(/^--ios-/, '--')),
        colour(v, `ios.${scheme} ${k}`),
      ]),
    );
    md[scheme] = Object.fromEntries(
      Object.entries(source.md?.[scheme] ?? fail(`source has no md.${scheme}`)).map(([k, v]) => [
        camel(k.replace(/^--md-/, '--')),
        // #fff is written short in the source; RN reads it as is.
        colour(v, `md.${scheme} ${k}`),
      ]),
    );
  }

  const type = {};
  for (const [selector, key] of Object.entries(TYPE_KEYS)) {
    const raw = source.typography_native?.[selector] ?? fail(`source has no type ${selector}`);
    if (selector === '.ios-row') {
      // "16px/21px; .sub 13px/17px": the row and its sub-line.
      const [row, sub] = String(raw)
        .split(';')
        .map((s) => s.trim());
      type.row = parseType(row, selector);
      type.rowSub = parseType(sub.replace(/^\.sub\s+/, ''), `${selector} .sub`);
      continue;
    }
    type[key] = parseType(raw, selector);
  }

  const radii = {};
  for (const [k, key] of Object.entries(RADIUS_KEYS)) {
    radii[key] = px(source.radii?.[k] ?? fail(`source has no radius ${k}`), `radius ${k}`);
  }

  return { variants, ios, md, type, radii };
}

const lit = (value) =>
  JSON.stringify(value, null, 2).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:');

function render(built) {
  const tokenKeys = Object.keys(built.variants.day);
  const iosKeys = Object.keys(built.ios.light);
  const mdKeys = Object.keys(built.md.light);
  return `// GENERATED by apps/mobile/scripts/gen-glass-tokens.mjs from glass-tokens.source.json.
// Do not edit by hand: change the source (or re-prune it from the spec with --from) and
// run \`node scripts/gen-glass-tokens.mjs\`. glass-tokens.generated.test.ts fails when
// this file and the generator disagree.

/** One Liquid Glass variant's colours (spec/tokens.json "variants", camelCased). */
export interface GlassTokens {
${tokenKeys.map((k) => `  readonly ${k}: string;`).join('\n')}
}

/**
 * Day glass (light), Night glass (dark), and their opaque twins for Reduce
 * Transparency and Android (the spec's "reduced" material; floating glass opaque
 * per finding F1).
 */
export const GLASS_TOKENS: {
  readonly day: GlassTokens;
  readonly night: GlassTokens;
  readonly dayOpaque: GlassTokens;
  readonly nightOpaque: GlassTokens;
} = ${lit(built.variants)};

/** The iOS boards' component palette (sp.css .ios). */
export interface GlassIosTokens {
${iosKeys.map((k) => `  readonly ${k}: string;`).join('\n')}
}

export const GLASS_IOS_TOKENS: { readonly light: GlassIosTokens; readonly dark: GlassIosTokens } = ${lit(built.ios)};

/** The Android boards' Material 3 palette (sp.css .md). */
export interface GlassMdTokens {
${mdKeys.map((k) => `  readonly ${k}: string;`).join('\n')}
}

export const GLASS_MD_TOKENS: { readonly light: GlassMdTokens; readonly dark: GlassMdTokens } = ${lit(built.md)};

export interface GlassTypeToken {
  readonly fontSize: number;
  readonly lineHeight?: number;
  readonly fontWeight?: '400' | '500' | '600' | '700';
  readonly letterSpacing?: number;
  readonly fontVariant?: readonly 'tabular-nums'[];
}

/** The native type scale (spec typography.native), in points. */
export const GLASS_TYPE_TOKENS = ${lit(built.type)} as const satisfies Record<string, GlassTypeToken>;

/** Corner radii (spec radii.tokens), in points. */
export const GLASS_RADII = ${lit(built.radii)} as const;
`;
}

/** Format like the repo's lint-staged step does, so a commit never rewrites the generated file. */
async function format(code) {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(TARGET)) ?? {};
  return prettier.format(code, { ...options, filepath: TARGET });
}

async function main(argv) {
  const fromIdx = argv.indexOf('--from');
  if (fromIdx !== -1) {
    const path = argv[fromIdx + 1] ?? fail('--from needs the path to spec/tokens.json');
    const pruned = prune(JSON.parse(readFileSync(path, 'utf8')));
    writeFileSync(SOURCE, `${JSON.stringify(pruned, null, 2)}\n`);
    // The source is JSON; lint-staged formats it too, so keep it in prettier's shape.
    const prettier = await import('prettier');
    const options = (await prettier.resolveConfig(SOURCE)) ?? {};
    writeFileSync(
      SOURCE,
      await prettier.format(readFileSync(SOURCE, 'utf8'), { ...options, filepath: SOURCE }),
    );
  }
  const output = await format(render(build(JSON.parse(readFileSync(SOURCE, 'utf8')))));
  if (argv.includes('--check')) {
    const current = readFileSync(TARGET, 'utf8');
    if (current !== output) {
      console.error('glass-tokens.generated.ts is stale: run node scripts/gen-glass-tokens.mjs');
      process.exit(1);
    }
    return;
  }
  writeFileSync(TARGET, output);
}

await main(process.argv.slice(2));
