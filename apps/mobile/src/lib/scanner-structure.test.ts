import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import {
  TOUCHABLE_TAG,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { palette, type Palette } from './theme';

/**
 * THE PHONE SCANNERS, READ AS SOURCE (redesign package P3.8, the M8 look).
 *
 * The count scanner (app/cycle-count/scan/[id].tsx) and the Scan tab
 * (app/(drawer)/(tabs)/scan.tsx), with the cards it opens, took the
 * reference's scanner look: the finder's corner brackets, the scanned card,
 * the Single / Batch switch (Burst off / Burst, on the count scanner only),
 * on the per-mode palette, with the camera chrome dark in both modes. The
 * look is all that moved. These pin what had to survive it: every word,
 * spoken name and role, the gates, the counting rules, the offline path, and
 * that none of the reference's sample content (a Receive / Pick / Move /
 * Count strip, a Recent scans list, zones, a Batch mode on the Scan tab)
 * was added.
 *
 * The mobile suite has no React Native renderer, so the screens are read with
 * the TypeScript parser, the way header-chip-a11y.test.ts and
 * primitives-structure.test.ts read theirs, and the colours each screen names
 * are measured with the palette they come from.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const COUNT_SCANNER = 'app/cycle-count/scan/[id].tsx';

const LIGHT = palette('light');
const DARK = palette('dark');
const MODES: [string, Palette][] = [
  ['light', LIGHT],
  ['dark', DARK],
];

function sourceOf(file: string): string {
  return readSource(path.join(MOBILE_ROOT, file));
}

function treeOf(file: string): ts.SourceFile {
  return parseTsx(sourceOf(file), file);
}

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The body of `function name(...) {...}` or `async function name(...)`, comments dropped. */
function functionBody(src: string, file: string, name: string): string {
  const sf = parseTsx(src, file);
  let body: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) body = n.body.getText(sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(body, `function ${name} not found in ${file}`).not.toBeNull();
  return codeOnly(body!);
}

/** Every element of a file that matches. */
function elements(file: string, match: (el: JsxNode, sf: ts.SourceFile) => boolean) {
  const sf = treeOf(file);
  const els: JsxNode[] = [];
  walkJsx(sf, (el) => {
    if (match(el, sf)) els.push(el);
  });
  return { sf, els };
}

/** The words an element shows: its JSX text, children joined. */
function textOf(el: JsxNode, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.getText(sf).trim());
    ts.forEachChild(n, visit);
  };
  visit(el);
  return parts.filter(Boolean).join(' ');
}

/**
 * Everything a person can read or hear in a file: JSX text and every string
 * and template literal (comments are not literals, so they never count).
 */
function wordsOf(file: string): string[] {
  const sf = treeOf(file);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const t = n.getText(sf).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
    } else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** An opaque colour laid at `alpha` over another, as '#rrggbb'. */
function over(top: string, alpha: number, under: string): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(ch(top, i) * alpha + ch(under, i) * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** `name: 'value'` or `name: CAMERA_PALETTE.token` inside a file's `const CAMERA = {...}`. */
function cameraTokens(file: string): Record<string, string> {
  const src = sourceOf(file);
  const block = /const CAMERA = \{([\s\S]*?)\n\} as const;/.exec(src)?.[1];
  expect(block, `${file} has no CAMERA block`).toBeDefined();
  const out: Record<string, string> = {};
  for (const m of codeOnly(block!).matchAll(
    /\n\s*(\w+):\s*(?:'([^']+)'|CAMERA_PALETTE\.(\w+)),/g,
  )) {
    const [, name, literal, token] = m;
    out[name!] = literal ?? DARK[token as keyof Palette];
  }
  return out;
}

/** 'rgba(r, g, b, a)' as [hex, alpha]. */
function rgba(colour: string): [string, number] {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(colour);
  expect(m, `${colour} is not rgba()`).not.toBeNull();
  const hex = `#${[m![1], m![2], m![3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  return [hex, Number(m![4])];
}

/** Named imports a file takes from lib/theme. */
function themeImports(file: string): string[] {
  const sf = treeOf(file);
  const names: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.moduleSpecifier.text !== '@/lib/theme') continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamedImports(b))
      for (const el of b.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
}

/** Every `c.<token>` (or `<alias>.<token>`) a file reads from its palette. */
function paletteReads(file: string, alias = 'c'): string[] {
  const sf = treeOf(file);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === alias &&
      n.name.text in LIGHT
    ) {
      out.push(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const SYMBOLOGIES =
  "barcodeTypes: ['qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'codabar', 'pdf417'],";

/** Sample content the reference shows that the product does not have. */
const NOT_THE_PRODUCTS = [
  /\bRecent scans?\b/i,
  /\bZone\b/i,
  /^Receive$/,
  /^Pick$/,
  /^Move$/,
  /^Count$/,
  /^Single$/,
  /^Batch$/,
  /\bunits\b/,
  /Tap to (simulate|scan next)/i,
  /\bTasks\b/,
];

// ── The count scanner ────────────────────────────────────────────────────

describe('count scanner: every word, name and role survives the restyle', () => {
  const words = wordsOf(COUNT_SCANNER);

  it.each([
    'Done',
    'Counting',
    'of',
    'done',
    'Burst off',
    'Burst',
    'Burst mode — scan to add 1 to count',
    'Scan a barcode to record the line',
    'Expected',
    'Counted',
    'Cancel',
    'Saving…',
    'Save',
    'Camera access needed',
    'Scan-to-count uses the camera to read item barcodes.',
    'Camera access is off for StockPilot. Turn it on in Settings to scan-to-count.',
    'Continue',
    'Open Settings',
    'No cached lines',
    'Open this cycle count from the list once while online so it can be cached for offline scanning.',
    'Not in this count',
    'No item with barcode/SKU "',
    '" in this cycle count\'s scope. Scan the barcode on the individual size or number, not a shared product label.',
    'Invalid count',
    'Enter a non-negative number.',
  ])('says "%s"', (word) => {
    expect(words).toContain(word);
  });

  // "Counting · x of y done": the live tally under the screen name.
  it('the tally is the count of lines done out of all lines, uncapped', () => {
    const code = codeOnly(sourceOf(COUNT_SCANNER));
    expect(code).toMatch(
      /<Text style=\{styles\.headerSub\}>\s*\{counted\} of \{total\} done\s*<\/Text>/,
    );
    expect(code).toContain('const total = lines.length;');
    expect(code).toMatch(
      /const counted = lines\.filter\(\s*\(l\) => scannedMap\.has\(l\.id\) \|\| l\.counted != null,?\s*\)\.length;/,
    );
  });

  // Mutation caught: Burst turned into two buttons (a tap on the shown word
  // would stop flipping it), or the switch's name, role or state dropped.
  it('Burst is one switch named Burst: a tap anywhere flips it, VoiceOver hears on or off', () => {
    const { sf, els } = elements(COUNT_SCANNER, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    const burst = els.filter((el) => /Burst/.test(textOf(el, sf)));
    expect(burst).toHaveLength(1);
    const sw = burst[0]!;
    expect(textOf(sw, sf)).toBe('Burst off Burst');
    expect(attrText(sw, 'onPress', sf)).toBe('() => setBurstMode((v) => !v)');
    expect(attrText(sw, 'accessibilityRole', sf)).toBe('switch');
    expect(attrText(sw, 'accessibilityLabel', sf)).toBe('Burst');
    expect(attrText(sw, 'accessibilityState', sf)).toBe('{ checked: burstMode }');
    // The selected half is the mode that is on.
    const src = sourceOf(COUNT_SCANNER);
    expect(src).toContain(
      '<View style={[styles.burstSegment, !burstMode && styles.burstSegmentOn]}>',
    );
    expect(src).toContain(
      '<View style={[styles.burstSegment, burstMode && styles.burstSegmentOn]}>',
    );
    expect(src).toMatch(/\n {2}burstFrame: \{[^}]*minHeight: 44\b/);
  });

  it('the hint says which mode is on', () => {
    expect(codeOnly(sourceOf(COUNT_SCANNER))).toMatch(
      /\{burstMode\s*\? 'Burst mode — scan to add 1 to count'\s*: 'Scan a barcode to record the line'\}/,
    );
  });

  it('the Counted box is named Counted for VoiceOver, numeric, and selects its text on focus', () => {
    const { sf, els } = elements(COUNT_SCANNER, (el, s) => tagOf(el, s) === 'TextInput');
    expect(els).toHaveLength(1);
    const input = els[0]!;
    expect(attrText(input, 'accessibilityLabel', sf)).toBe('Counted');
    expect(attrText(input, 'keyboardType', sf)).toBe('numeric');
    expect(attrText(input, 'selectTextOnFocus', sf)).toBe('true');
    expect(attrText(input, 'value', sf)).toBe('sheet.qty');
    expect(attrText(input, 'onChangeText', sf)).toBe('(v) => setSheet({ ...sheet, qty: v })');
  });

  // Save commits the count (the ink button); Cancel is the outline beside it.
  // Both are the shared Button, so each is a button to VoiceOver, and both
  // wait while a save runs.
  it('Save is the one ink button and Cancel its outline, both off while saving', () => {
    const { sf, els } = elements(COUNT_SCANNER, (el, s) => tagOf(el, s) === 'Button');
    const byPress = (press: string) => els.filter((el) => attrText(el, 'onPress', sf) === press);
    const [cancel] = byPress('() => setSheet(null)');
    expect(textOf(cancel!, sf)).toBe('Cancel');
    expect(attrText(cancel!, 'variant', sf)).toBe('outline');
    expect(attrText(cancel!, 'disabled', sf)).toBe('busy');
    const [save] = byPress('confirmSheet');
    expect(attrText(save!, 'variant', sf)).toBeUndefined(); // primary: the ink fill
    expect(attrText(save!, 'disabled', sf)).toBe('busy');
    expect(codeOnly(save!.getText(sf))).toContain("{busy ? 'Saving…' : 'Save'}");
    // The ink buttons: the sheet's Save, and the permission screen's Continue
    // or Open Settings, which never show at the same time as the sheet.
    const ink = els.filter((el) => (attrText(el, 'variant', sf) ?? 'primary') === 'primary');
    expect(ink.map((el) => attrText(el, 'onPress', sf))).toEqual([
      'requestPermission',
      '() => Linking.openSettings()',
      'confirmSheet',
    ]);
  });

  it('the permission screen keeps the neutral Continue, or Open Settings once iOS will not ask again', () => {
    const code = codeOnly(sourceOf(COUNT_SCANNER));
    expect(code).toMatch(
      /\{permission\.canAskAgain \? \(\s*<Button onPress=\{requestPermission\}[^>]*>\s*Continue\s*<\/Button>\s*\) : \(\s*<Button onPress=\{\(\) => Linking\.openSettings\(\)\}[^>]*>\s*Open Settings\s*<\/Button>\s*\)\}/,
    );
    expect(code).not.toMatch(/\b(Grant|Allow) (access|camera)\b/);
  });
});

describe('count scanner: the counting rules are unchanged', () => {
  const src = sourceOf(COUNT_SCANNER);
  const code = codeOnly(src);

  it('a repeat of the same code within 600 ms is dropped', () => {
    const body = functionBody(src, COUNT_SCANNER, 'onBarcode');
    expect(body).toMatch(
      /const now = Date\.now\(\);\s*if \(lastScan && lastScan\.code === code && now - lastScan\.at < 600\) return;\s*setLastScan\(\{ code, at: now \}\);/,
    );
  });

  it('matches the barcode first, then the SKU, within the cached lines only', () => {
    const body = functionBody(src, COUNT_SCANNER, 'findLineByCode');
    expect(body).toMatch(
      /const byBarcode = lines\.find\(\(l\) => l\.itemBarcode && l\.itemBarcode === norm\);\s*if \(byBarcode\) return byBarcode;\s*const bySku = lines\.find\(\(l\) => l\.itemSku === norm\);\s*return bySku \?\? null;/,
    );
  });

  it('a code in no line says "Not in this count" and counts nothing', () => {
    const body = functionBody(src, COUNT_SCANNER, 'onBarcode');
    expect(body).toMatch(
      /if \(!line\) \{\s*Alert\.alert\(\s*'Not in this count',[\s\S]*?\);\s*return;\s*\}/,
    );
  });

  it('Burst adds 1 to the line without opening the sheet', () => {
    const body = functionBody(src, COUNT_SCANNER, 'onBarcode');
    expect(body).toMatch(
      /if \(burstMode\) \{\s*const current = scannedMap\.get\(line\.id\) \?\? line\.counted \?\? 0;\s*const next = current \+ 1;\s*await recordCount\(line, next\);\s*return;\s*\}/,
    );
  });

  it('the sheet opens with Counted prefilled with the expected quantity', () => {
    expect(functionBody(src, COUNT_SCANNER, 'onBarcode')).toContain(
      'setSheet({ line, qty: String(line.expected) });',
    );
  });

  it('a count of 0 is a count: only a negative or non-number is refused', () => {
    const body = functionBody(src, COUNT_SCANNER, 'confirmSheet');
    expect(body).toMatch(
      /if \(!Number\.isFinite\(num\) \|\| num < 0\) \{\s*Alert\.alert\('Invalid count', 'Enter a non-negative number\.'\);\s*return;\s*\}/,
    );
    expect(body).not.toMatch(/num <= 0|num < 1|num === 0/);
    expect(functionBody(src, COUNT_SCANNER, 'recordCount')).toMatch(
      /if \(!Number\.isFinite\(qty\) \|\| qty < 0\) return;/,
    );
  });

  // Offline: each save is a local write plus an outbox row, then a drain.
  it('every count is written to the phone first and sent by the sync engine', () => {
    const body = functionBody(src, COUNT_SCANNER, 'recordCount');
    expect(body).toMatch(
      /await updateLocalLine\(line\.id, qty\);[\s\S]*await cycleCountSync\.refreshPendingCount\(\);\s*void cycleCountSync\.forceSync\(\);/,
    );
    expect(code).not.toMatch(/\bfetch\(|from '@\/lib\/supabase'|from '@\/lib\/api'/);
    expect(code).toContain('const snap = await getCycleCount(id);');
  });

  it('reads the camera with the same ten symbologies', () => {
    expect(src).toContain(SYMBOLOGIES);
  });

  it('the camera is off while the confirm sheet is open', () => {
    expect(code).toMatch(/\{!sheet \? \(\s*<CameraView\b/);
  });

  // A fullScreenModal renders outside the root SafeAreaProvider on iOS.
  it('keeps its own SafeAreaProvider', () => {
    expect(code).toMatch(
      /export default function CycleCountScanScreen\(\) \{\s*return \(\s*<SafeAreaProvider>\s*<CycleCountScanScreenInner \/>\s*<\/SafeAreaProvider>\s*\);\s*\}/,
    );
  });

  it('keeps the sync badge on the bar, drawn for a camera bar', () => {
    const { sf, els } = elements(COUNT_SCANNER, (el, s) => tagOf(el, s) === 'SyncStatusBadge');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'surface', sf)).toBe('camera');
  });

  it('no serial is ever asked for', () => {
    expect(wordsOf(COUNT_SCANNER).some((w) => /serial/i.test(w))).toBe(false);
  });
});

describe('count scanner: defects fixed in this package', () => {
  // The Counted box opens iOS's decimal pad, which has no key that puts it
  // away, and the sheet sat at the bottom of the screen under it: once the box
  // took focus, the box and Save were hidden and the only way out was Done,
  // which dropped the count. Mutation caught: the sheet outside a
  // KeyboardAvoidingView, or one that does nothing on iOS.
  it('the confirm sheet rides above the keyboard', () => {
    const sf = treeOf(COUNT_SCANNER);
    const chains: string[][] = [];
    walkJsx(sf, (el, ancestors) => {
      if (attrText(el, 'style', sf) === 'styles.sheetWrap') {
        chains.push(
          ancestors.map((a) =>
            tagOf(a, sf) === 'KeyboardAvoidingView'
              ? `KeyboardAvoidingView behavior={${attrText(a, 'behavior', sf)}}`
              : tagOf(a, sf),
          ),
        );
      }
    });
    expect(chains).toHaveLength(1);
    expect(chains[0]).toContain(
      "KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}",
    );
    // The sheet is laid out at the foot of that view (not absolutely
    // positioned, which the view's padding would not move).
    expect(sourceOf(COUNT_SCANNER)).toMatch(/\n {2}sheetWrap: \{[^}]*justifyContent: 'flex-end'/);
    expect(sourceOf(COUNT_SCANNER)).not.toMatch(/\n {2}sheet: \{[^}]*position: 'absolute'/);
  });
});

describe('count scanner: Dynamic Type caps stay where they were', () => {
  const src = sourceOf(COUNT_SCANNER);

  it('Done, Burst and the screen name are capped at the chrome ceiling; the tally is not', () => {
    expect(src).toContain('const CLOSE_CAP = capTo(13, TYPE_CEILING.chrome);');
    expect(src).toContain('const BURST_CAP = capTo(12.5, TYPE_CEILING.chrome);');
    expect(src).toContain('const TITLE_CAP = capTo(12, TYPE_CEILING.chrome);');
    const { sf, els } = elements(COUNT_SCANNER, (el, s) => tagOf(el, s) === 'Text');
    const cap = (word: string) =>
      els
        .filter((el) => textOf(el, sf) === word)
        .map((el) => attrText(el, 'maxFontSizeMultiplier', sf));
    expect(cap('Done')).toEqual(['CLOSE_CAP']);
    expect(cap('Burst off')).toEqual(['BURST_CAP']);
    expect(cap('Burst')).toEqual(['BURST_CAP']);
    expect(cap('Counting')).toEqual(['TITLE_CAP']);
    expect(cap('of done')).toEqual([undefined]);
    // The 12.5pt Burst words are the reference's segment size (DESIGN-SPEC 6.5).
    expect(src).toMatch(/\n {2}burstLabel: \{[^}]*fontSize: 12\.5\b/);
  });

  it('the bar wraps rather than squeezing the tally, and the title keeps its floor', () => {
    expect(src).toMatch(/\n {2}topBar: \{[^}]*flexWrap: 'wrap',/);
    expect(src).toContain('titleCol: { flex: 1, minWidth: 120 },');
  });

  it('the sheet stacks Expected over Counted past the stacking scale', () => {
    expect(src).toContain('const stacked = shouldStackRow(useWindowDimensions().fontScale);');
    expect(src).toContain('<View style={[styles.row, stacked && styles.rowStacked]}>');
  });
});

describe('count scanner: the camera chrome is dark in both modes and reads at AA', () => {
  const src = sourceOf(COUNT_SCANNER);
  let tokens: Record<string, string> | null = null;
  /** Read on first use, so a missing block fails the tests that need it. */
  const camera = new Proxy({} as Record<string, string>, {
    get: (_t, name: string) => (tokens ??= cameraTokens(COUNT_SCANNER))[name],
  });

  it('draws from the dark palette and the reference viewfinder, never the device mode', () => {
    expect(src).toContain("const CAMERA_PALETTE = palette('dark');");
    expect(camera.surface).toBe('#0a0b09');
    expect(camera.reticle).toBe(DARK.accent);
    for (const name of [
      'root',
      'barArea',
      'topBar',
      'viewfinder',
      'closeBtn',
      'closeText',
      'headerLabel',
      'headerSub',
      'burstTrack',
      'burstSegmentOn',
      'burstLabel',
      'burstLabelOn',
      'corner',
      'scanLine',
      'hintPill',
      'hint',
    ]) {
      const block = new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(src)?.[1] ?? '';
      expect(block, name).toMatch(/CAMERA\.\w+/);
      expect(block, name).not.toMatch(/\bc\.\w+|theme\./);
    }
  });

  it('every word on the bar reads at AA on it; the tally and Done stay the brightest', () => {
    expect(contrast(camera.ink!, camera.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(camera.ink2!, camera.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(camera.ink3!, camera.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(camera.ink!, camera.chip!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(camera.ink!, camera.segment!)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('Done and the selected half of Burst stand out from the bar at 3:1 by their outline', () => {
    expect(contrast(camera.chipBorder!, camera.surface!)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(camera.chipBorder!, camera.chip!)).toBeGreaterThanOrEqual(AA_UI);
    expect(src).toMatch(/\n {2}burstSegmentOn: \{[^}]*borderColor: CAMERA\.chipBorder/);
  });

  // The frame it replaces was the ink #0e0f0d: 1.09:1 on a dark scene.
  it("the finder's brackets and line stand out from the viewfinder", () => {
    expect(contrast(camera.reticle!, camera.surface!)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast('#0e0f0d', '#000000')).toBeLessThan(AA_UI);
  });

  it('the hint reads at AA over any picture, white shelf or black', () => {
    const [hex, alpha] = rgba(camera.scrim!);
    for (const scene of ['#ffffff', '#000000', '#808080']) {
      expect(contrast(camera.ink2!, over(hex, alpha, scene)), scene).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
  });
});

describe('count scanner: the sheet and the permission screen follow the device mode', () => {
  const src = sourceOf(COUNT_SCANNER);

  it('is off the light-only legacy alias and the single-mode accents', () => {
    expect(themeImports(COUNT_SCANNER)).not.toContain('theme');
    expect(themeImports(COUNT_SCANNER)).not.toContain('ACCENT');
    expect(src).toContain('const { c } = useTheme();');
  });

  it('words take ink, ink2 or ink3, never the faint inks', () => {
    const reads = paletteReads(COUNT_SCANNER);
    expect(reads.filter((t) => t === 'ink4' || t === 'ink5')).toEqual([]);
    expect([...new Set(reads)].sort()).toEqual([
      'card',
      'hair',
      'hair2',
      'ink',
      'ink2',
      'ink3',
      'paper',
      'sunk',
    ]);
  });

  it.each(MODES)(
    '%s: every pair the sheet and the permission screen draw reads at AA',
    (_mode, p) => {
      // Sheet: SKU, name, variant, labels and Expected on the card.
      for (const t of [p.ink, p.ink2, p.ink3])
        expect(contrast(t, p.card)).toBeGreaterThanOrEqual(AA_TEXT);
      // The Counted box: typed digits on the recessed fill.
      expect(contrast(p.ink, p.sunk)).toBeGreaterThanOrEqual(AA_TEXT);
      // Permission screen and the loading spinner on the page.
      expect(contrast(p.ink, p.paper)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(p.ink3, p.paper)).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it('the sheet is the reference card: the card fill, a hairline, radius 16', () => {
    expect(src).toContain(
      '<View style={[styles.sheet, { backgroundColor: c.card, borderColor: c.hair }]}>',
    );
    expect(src).toMatch(/\n {2}sheet: \{[^}]*borderRadius: 16,/);
    expect(src).toContain('{ backgroundColor: c.sunk, borderColor: c.hair2, color: c.ink }');
  });
});

describe('count scanner: none of the reference sample content was added', () => {
  it.each(NOT_THE_PRODUCTS.map((re) => [re.source, re] as const))(
    'nothing reads %s',
    (_name, re) => {
      expect(wordsOf(COUNT_SCANNER).filter((w) => re.test(w))).toEqual([]);
    },
  );
});
