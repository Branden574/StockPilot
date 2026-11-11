import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { facedProp } from '../../components/ui/glass/merge-styles';
import {
  glassBody,
  glassButtonLabel,
  glassDisplay,
  glassEyebrow,
  glassPillLabel,
  glassRowSub,
  glassRowTitle,
} from '../../components/ui/glass/primitive-styles';
import type { GlassLook } from '../../components/ui/glass/use-glass';
import { FONT, GLASS_FONT, GLASS_SYSTEM_FAMILY, palette, type ThemeMode } from '../theme';
import { themeValueFor } from './theme-value';

/**
 * SWITCHING THE DESIGN KEEPS EACH LOOK'S TYPEFACE (the "Tour" chip, CHIP).
 *
 * After Liquid Glass -> Classic without a relaunch, Home's "Tour" chip kept
 * its glass width until a cold start: its label was still drawn in the system
 * face. So was every other text that stayed mounted through the switch and
 * was drawn through Body, Display or Eyebrow without a family of its own, the
 * Items rows' Mono lines and the pill label; and the other way round, Classic
 * -> Liquid Glass left Classic's Inter Tight and JetBrains Mono in glass.
 *
 * The cause is how React Native sends a style array to native. A text
 * primitive lays the glass entry AFTER its Classic entry
 * (`[classic, lg && glass, style]`), and the glass faces cleared Classic's
 * family with a key that was present but undefined. React Native diffs the
 * array entry by entry (Libraries/ReactNative/ReactFabricPublicInstance/
 * ReactNativeAttributePayload.js, 0.86.3): when the glass entry goes away, a
 * key whose old value was undefined is skipped ("was already empty anyway"),
 * the Classic entry itself did not change, and so the family is never sent
 * again; when the glass entry arrives, an undefined key sends nothing. A
 * DEFINED family is flagged and restored correctly both ways, so the glass
 * faces now name the system face (theme.ts GLASS_SYSTEM_FAMILY).
 *
 * This runs React Native's own diff, loaded from node_modules (its Flow types
 * removed by the TypeScript transpiler, nothing copied into the repo), over
 * the style arrays the primitives build, and applies each payload to a model
 * of the native props the way native does (a value sets, null clears).
 */

vi.mock('react-native', () => {
  // React Native's flattenStyle (Libraries/StyleSheet/flattenStyle.js): later
  // entries win key by key, undefined values included.
  const flatten = (style: unknown): Record<string, unknown> | undefined => {
    if (style === null || typeof style !== 'object') return undefined;
    if (!Array.isArray(style)) return style as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const entry of style) {
      const flat = flatten(entry);
      if (flat) for (const key in flat) out[key] = flat[key];
    }
    return out;
  };
  return { StyleSheet: { create: (s: unknown) => s, hairlineWidth: 0.5, flatten } };
});

// ── React Native's own style diff ────────────────────────────────────────

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const requireFromApp = createRequire(path.join(MOBILE_ROOT, 'package.json'));
const RN_ROOT = path.dirname(requireFromApp.resolve('react-native/package.json'));
const DIFF_FILE = 'Libraries/ReactNative/ReactFabricPublicInstance/ReactNativeAttributePayload.js';

type Style = Record<string, unknown>;
type Payload = Record<string, unknown> | null;
interface RnDiff {
  create(props: { style: unknown }, validAttributes: object): Payload;
  diff(prev: { style: unknown }, next: { style: unknown }, validAttributes: object): Payload;
}

const transpileProblems: string[] = [];
const loaded = new Map<string, { exports: Record<string, unknown> }>();

/** One of React Native's modules, run from its own source. */
function loadRn(file: string): Record<string, unknown> {
  const hit = loaded.get(file);
  if (hit) return hit.exports;
  const out = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true,
    fileName: `${path.basename(file, '.js')}.ts`,
  });
  for (const d of out.diagnostics ?? []) {
    transpileProblems.push(
      `${path.basename(file)}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
    );
  }
  const module = { exports: {} as Record<string, unknown> };
  loaded.set(file, module);
  const require = (spec: string): unknown => {
    // Only object-valued props (a transform, a shadow offset) reach the deep
    // compare; the text styles here are scalars. A structural stand-in.
    if (spec.endsWith('/deepDiffer')) {
      return { default: (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b) };
    }
    return loadRn(path.resolve(path.dirname(file), `${spec}.js`));
  };
  const run = vm.runInThisContext(`(function (require, module, exports) {${out.outputText}\n})`, {
    filename: file,
  }) as (r: typeof require, m: typeof module, e: Record<string, unknown>) => void;
  run(require, module, module.exports);
  return module.exports;
}

const rn = loadRn(path.join(RN_ROOT, DIFF_FILE)) as unknown as RnDiff;
const rnFlatten = (
  loadRn(path.join(RN_ROOT, 'Libraries/StyleSheet/flattenStyle.js')) as {
    default: (style: unknown) => Style | undefined;
  }
).default;

const KEYS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'color',
  'textTransform',
  'marginTop',
  'flexShrink',
  'minWidth',
] as const;
const VALID = { style: Object.fromEntries(KEYS.map((k) => [k, true])) };

/** What native holds after a payload: a value sets the prop, null clears it. */
function applied(native: Style, payload: Payload): Style {
  const next = { ...native };
  for (const key in payload ?? {}) {
    if (payload![key] === null) delete next[key];
    else next[key] = payload![key];
  }
  return next;
}

const defined = (style: Style | undefined): Style =>
  Object.fromEntries(Object.entries(style ?? {}).filter(([, v]) => v !== undefined && v !== null));

// ── The looks and the arrays the primitives build ────────────────────────

type LookName = 'classicLight' | 'classicDark' | 'glassDay' | 'glassNight';

function look(name: LookName): { lg: GlassLook | null; mode: ThemeMode } {
  const mode: ThemeMode = name === 'classicDark' || name === 'glassNight' ? 'dark' : 'light';
  const glass = name === 'glassDay' || name === 'glassNight';
  return {
    lg: glass ? (themeValueFor('liquid-glass', mode, 'glass', true) as GlassLook) : null,
    mode,
  };
}

/** The palette a primitive reads through useTheme(): the glass one in Liquid Glass. */
const inkOf = (name: LookName) => {
  const { lg, mode } = look(name);
  return (lg ? lg.c : palette(mode)).ink3;
};

// components/ui/text.tsx styles.eyebrow and components/ui/pill.tsx styles.label.
const EYEBROW = {
  fontFamily: FONT.mono,
  fontSize: 11,
  letterSpacing: 11 * 0.18,
  textTransform: 'uppercase',
  lineHeight: 11 * 1.2,
};
const PILL_LABEL = {
  fontFamily: FONT.mono,
  fontSize: 10.5,
  letterSpacing: 0.4,
  fontWeight: '500',
  flexShrink: 1,
  minWidth: 0,
};

type CallerStyle = (lg: GlassLook | null) => unknown;
const none: CallerStyle = () => undefined;

/** The `style` each primitive hands its <Text>, entry for entry as the source lays it. */
const PRIMITIVES = {
  // ui/text.tsx Body
  Body: (name: LookName, size: number, caller: CallerStyle) => {
    const { lg } = look(name);
    const style = caller(lg);
    return [
      {
        fontFamily: FONT.displayRegular,
        fontSize: size,
        lineHeight: size * 1.5,
        color: inkOf(name),
        letterSpacing: -size * 0.012,
      },
      lg && glassBody(lg, size),
      lg ? facedProp(lg, style) : style,
    ];
  },
  // ui/text.tsx Display
  Display: (name: LookName, size: number, caller: CallerStyle) => {
    const { lg } = look(name);
    const style = caller(lg);
    return [
      {
        fontFamily: FONT.display,
        fontSize: size,
        lineHeight: size * 1.05,
        letterSpacing: -size * 0.028,
        color: inkOf(name),
      },
      lg && glassDisplay(lg, size),
      lg ? facedProp(lg, style) : style,
    ];
  },
  // ui/text.tsx Mono
  Mono: (name: LookName, size: number, caller: CallerStyle) => {
    const { lg } = look(name);
    const style = caller(lg);
    return [
      { fontFamily: FONT.mono, fontSize: size, color: inkOf(name), letterSpacing: size * 0.04 },
      lg ? facedProp(lg, style) : style,
    ];
  },
  // ui/text.tsx Eyebrow
  Eyebrow: (name: LookName) => {
    const { lg } = look(name);
    return [EYEBROW, { color: inkOf(name) }, lg && glassEyebrow(lg)];
  },
  // ui/pill.tsx Pill
  Pill: (name: LookName) => {
    const { lg } = look(name);
    return [PILL_LABEL, { color: inkOf(name) }, lg && glassPillLabel(lg)];
  },
} as const;

/** A text on screen: which primitive, at what size, with what the call site passes. */
const TEXTS: [string, (name: LookName) => unknown[]][] = [
  // Home's "Tour" chip (components/onboarding/mobile-tour.tsx): the defect as reported.
  ['the Tour chip (Body, no style of its own)', (n) => PRIMITIVES.Body(n, 11, none)],
  [
    'Appearance: a choice name (Body with the display face)',
    (n) => PRIMITIVES.Body(n, 15.5, () => ({ fontFamily: FONT.display })),
  ],
  [
    'Appearance: a choice description (Body with a margin)',
    (n) => PRIMITIVES.Body(n, 13, () => ({ marginTop: 2 })),
  ],
  ['a page title (Display)', (n) => PRIMITIVES.Display(n, 34, none)],
  [
    'a page title with a margin (Display)',
    (n) => PRIMITIVES.Display(n, 34, () => ({ marginTop: 12 })),
  ],
  ['a section eyebrow (Eyebrow)', (n) => PRIMITIVES.Eyebrow(n)],
  ['a reference (Mono, no style of its own)', (n) => PRIMITIVES.Mono(n, 12, none)],
  [
    'a figure set in the display face (Mono)',
    (n) => PRIMITIVES.Mono(n, 22, () => ({ fontFamily: FONT.display })),
  ],
  // app/(drawer)/(tabs)/inventory.tsx, the row: name, then SKU or placement.
  [
    'Items row: the name',
    (n) =>
      PRIMITIVES.Mono(n, 15.5, (lg) =>
        lg ? glassRowTitle(lg) : { fontFamily: FONT.display, letterSpacing: -0.19 },
      ),
  ],
  [
    'Items row: the SKU line',
    (n) => PRIMITIVES.Mono(n, 11.5, (lg) => (lg ? glassRowSub(lg) : { marginTop: 4 })),
  ],
  ['a status pill label (Pill)', (n) => PRIMITIVES.Pill(n)],
];

const SWITCHES: LookName[][] = [
  ['glassDay', 'classicLight'],
  ['glassNight', 'classicDark', 'classicLight'],
  ['classicLight', 'glassDay'],
  ['classicLight', 'glassDay', 'classicLight'],
  ['glassDay', 'classicLight', 'glassDay'],
  ['glassDay', 'glassNight'],
];

/** Every step where what native holds differs from what the look asks for. */
function wrongAfter(build: (name: LookName) => unknown[], steps: LookName[]): string[] {
  const wrong: string[] = [];
  let prev: unknown[] | null = null;
  let native: Style = {};
  for (const step of steps) {
    const style = build(step);
    native = applied(
      native,
      prev === null ? rn.create({ style }, VALID) : rn.diff({ style: prev }, { style }, VALID),
    );
    prev = style;
    const want = defined(rnFlatten(style));
    const got = defined(native);
    for (const key of KEYS) {
      if (JSON.stringify(want[key]) !== JSON.stringify(got[key])) {
        wrong.push(
          `at ${step}: ${key} is ${JSON.stringify(got[key])}, wanted ${JSON.stringify(want[key])}`,
        );
      }
    }
  }
  return wrong;
}

describe("React Native's style diff, from node_modules", () => {
  it('loads as written (a React Native upgrade that changes it is seen here)', () => {
    expect(transpileProblems).toEqual([]);
    expect(typeof rn.create).toBe('function');
    expect(typeof rn.diff).toBe('function');
    const src = readFileSync(path.join(RN_ROOT, DIFF_FILE), 'utf8');
    // The two rules the defect came from.
    expect(src).toContain('// was already empty anyway');
    expect(src).toContain('// Discard the prop if it was previously defined.');
  });

  it('skips an undefined key when its entry is dropped, and restores a defined one', () => {
    const classic = [{ fontFamily: 'Classic Face', lineHeight: 10 }, false];
    const cleared = [
      { fontFamily: 'Classic Face', lineHeight: 10 },
      { fontFamily: undefined, fontWeight: '500' },
    ];
    const named = [
      { fontFamily: 'Classic Face', lineHeight: 10 },
      { fontFamily: 'system-ui', fontWeight: '500' },
    ];
    // The defect: the family is cleared at first draw and never sent again.
    expect(rn.create({ style: cleared }, VALID)).toMatchObject({ fontFamily: null });
    expect(rn.diff({ style: cleared }, { style: classic }, VALID)).toEqual({ fontWeight: null });
    expect(rn.diff({ style: classic }, { style: cleared }, VALID)).toEqual({ fontWeight: '500' });
    // A named family is sent both ways.
    expect(rn.diff({ style: named }, { style: classic }, VALID)).toEqual({
      fontFamily: 'Classic Face',
      fontWeight: null,
    });
    expect(rn.diff({ style: classic }, { style: named }, VALID)).toEqual({
      fontFamily: 'system-ui',
      fontWeight: '500',
    });
  });
});

describe('the glass faces', () => {
  it('each names its family: the system face by name, references in the mono face', () => {
    for (const [role, face] of Object.entries(GLASS_FONT)) {
      expect(typeof face.fontFamily, role).toBe('string');
    }
    expect(GLASS_SYSTEM_FAMILY).toBe('system-ui');
    for (const role of ['display', 'displayRegular', 'displaySemi', 'serifItalic'] as const) {
      expect(GLASS_FONT[role].fontFamily, role).toBe(GLASS_SYSTEM_FAMILY);
    }
    expect(GLASS_FONT.mono.fontFamily).toBe(FONT.mono);
    expect(GLASS_FONT.monoRegular.fontFamily).toBe(FONT.monoRegular);
    // The weights and the italic are as they were.
    expect(GLASS_FONT.display.fontWeight).toBe('500');
    expect(GLASS_FONT.displayRegular.fontWeight).toBe('400');
    expect(GLASS_FONT.displaySemi.fontWeight).toBe('600');
    expect(GLASS_FONT.serifItalic).toMatchObject({ fontWeight: '400', fontStyle: 'italic' });
  });

  it('no glass text style that is laid over a Classic one carries an undefined key', () => {
    for (const name of ['glassDay', 'glassNight'] as const) {
      const lg = look(name).lg!;
      const laid: [string, object][] = [
        ['glassBody', glassBody(lg, 15)],
        ['glassDisplay', glassDisplay(lg, 34)],
        ['glassEyebrow', glassEyebrow(lg)],
        ['glassRowTitle', glassRowTitle(lg)],
        ['glassRowSub', glassRowSub(lg)],
        ['glassPillLabel', glassPillLabel(lg)],
        ['glassButtonLabel', glassButtonLabel(lg, 'primary', 'md')],
        ['facedProp of a Classic face', facedProp(lg, { fontFamily: FONT.display })],
      ];
      for (const [what, style] of laid) {
        const undefinedKeys = Object.entries(style)
          .filter(([, v]) => v === undefined)
          .map(([k]) => k);
        expect(undefinedKeys, `${name} ${what}`).toEqual([]);
      }
    }
  });
});

describe('a Design switch without a relaunch', () => {
  it.each(TEXTS)('%s: native holds the look on screen after every switch', (_what, build) => {
    for (const steps of SWITCHES) {
      expect(wrongAfter(build, steps), steps.join(' > ')).toEqual([]);
    }
  });

  it('the arrays above are the ones the primitives lay (source)', () => {
    const flat = (file: string) =>
      readFileSync(path.join(MOBILE_ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\s+/g, ' ');
    const text = flat('src/components/ui/text.tsx');
    expect(text).toContain(
      'style={[ styles.eyebrow, { color: color ?? c.ink3 }, lg && glassEyebrow(lg), ]}',
    );
    expect(text).toContain(
      'style={[ { fontFamily: FONT.display, fontSize: size, lineHeight: size * 1.05, letterSpacing: -size * 0.028, color: color ?? c.ink, }, lg && glassDisplay(lg, size), lg ? facedProp(lg, style) : style, ]}',
    );
    expect(text).toContain(
      'style={[ { fontFamily: FONT.displayRegular, fontSize: size, lineHeight: size * 1.5, color: color ?? (muted ? c.ink3 : c.ink), letterSpacing: -size * 0.012, }, lg && glassBody(lg, size), lg ? facedProp(lg, style) : style, ]}',
    );
    expect(text).toContain(
      "style={[ { fontFamily: FONT.mono, fontSize: size, color: color ?? c.ink, letterSpacing: size * tracking, ...(upper ? { textTransform: 'uppercase' as const } : null), }, lg ? facedProp(lg, style) : style, ]}",
    );
    expect(text).toContain(
      "eyebrow: { fontFamily: FONT.mono, fontSize: 11, letterSpacing: 11 * 0.18, textTransform: 'uppercase', lineHeight: 11 * 1.2, },",
    );
    const pill = flat('src/components/ui/pill.tsx');
    expect(pill).toContain('style={[styles.label, { color: fg }, lg && glassPillLabel(lg)]}');
    expect(pill).toContain(
      "label: { fontFamily: FONT.mono, fontSize: 10.5, letterSpacing: 0.4, fontWeight: '500',",
    );
    expect(flat('src/components/onboarding/mobile-tour.tsx')).toContain(
      '<Body size={TOUR_PILL_LABEL} color={c.ink3}> Tour </Body>',
    );
  });
});
