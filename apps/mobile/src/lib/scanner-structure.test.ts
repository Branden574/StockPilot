import * as path from 'node:path';
import * as vm from 'node:vm';

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

  // Number('') is 0: a Counted box cleared to type a new number and saved
  // before the typing recorded a count of zero for the line, where the count
  // screen (app/cycle-count/[id].tsx) records nothing from an empty box. This
  // runs the screen's own lines that turn the box into a number, then its own
  // check. Mutation caught: the old `Number(sheet.qty)` (it accepts '' and
  // '   ' as 0), or a check that refuses a typed 0.
  it('an emptied Counted box is refused, never saved as 0; a typed 0 still counts', () => {
    const body = functionBody(sourceOf(COUNT_SCANNER), COUNT_SCANNER, 'confirmSheet');
    const from = body.indexOf('if (!sheet) return;') + 'if (!sheet) return;'.length;
    const to = body.indexOf('if (!Number.isFinite(num) || num < 0)');
    expect(from).toBeGreaterThan('if (!sheet) return;'.length - 1);
    expect(to).toBeGreaterThan(from);
    // The screen's own statements (read from the repository's source, never
    // from input), run in an empty context that holds only the sheet.
    const parse = new vm.Script(`${body.slice(from, to)}\n!(!Number.isFinite(num) || num < 0);`);
    const accepts = (qty: string): boolean => parse.runInNewContext({ sheet: { qty } }) as boolean;
    const verdicts = Object.fromEntries(
      ['', '   ', '0', ' 0 ', '12', '2.5', '-1', 'abc', '1,5'].map((qty) => [qty, accepts(qty)]),
    );
    expect(verdicts).toEqual({
      '': false,
      '   ': false,
      '0': true,
      ' 0 ': true,
      '12': true,
      '2.5': true,
      '-1': false,
      abc: false,
      '1,5': false,
    });
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

// ── The Scan tab ─────────────────────────────────────────────────────────

const SCAN_TAB = 'app/(drawer)/(tabs)/scan.tsx';

/** A `name: {...}` style block inside a file's `makeStyles(c)` (4-space indent). */
function styleBlock(src: string, name: string): string {
  return new RegExp(`\\n {4}${name}: \\{([^}]*)\\}`).exec(src)?.[1] ?? '';
}

/**
 * Top-level helper functions of a screen, compiled from the repository's own
 * source (never from input) and run in an empty context, for the pure
 * helpers whose answers are the behaviour (which QR is which, what a note
 * says).
 */
function screenFunctions(
  file: string,
  names: string[],
): Record<string, (...args: unknown[]) => unknown> {
  const sf = treeOf(file);
  const parts = sf.statements
    .filter(
      (st): st is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(st) && !!st.name && names.includes(st.name.text),
    )
    .map((st) => st.getText(sf));
  expect(parts, `${names.join(', ')} in ${file}`).toHaveLength(names.length);
  const js = ts.transpileModule(`${parts.join('\n')}\n({ ${names.join(', ')} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext({}) as Record<string, (...args: unknown[]) => unknown>;
}

/** Everything a person reads or hears on the Scan tab, word for word as before. */
const SCAN_WORDS = [
  'Close scanner',
  'Scan',
  'Photo ID',
  '— ALIGN BARCODE',
  'Point at a barcode or QR code',
  'Snap a clear photo of the front cover. Vision will read the title and author.',
  'Identifying…',
  'Capture cover',
  'No image',
  ' · ',
  'On hand',
  'Reorder at',
  'Price',
  'Location',
  'Split stock',
  'In crate',
  'Bin/shelf',
  'Elsewhere',
  'Rack',
  'Crate',
  'Grade',
  'Grade ',
  '−1',
  '+1',
  '+5',
  '+25',
  'Take photo',
  'Scan another',
  'Report a problem',
  'Multiple placements found',
  'Unassigned charter',
  'SKU',
  'No bin set',
  '·',
  'on hand',
  'Cancel',
  'Loading camera permission…',
  'Camera access needed',
  'StockPilot uses the camera to scan barcodes and QR codes.',
  'Camera access is off for StockPilot. Turn it on in Settings to scan barcodes and QR codes.',
  'Continue',
  'Open Settings',
  'Not confirmed · may still be saving',
  'Not confirmed · scan again to check',
  'ISBN lookup failed',
  'Lookup failed',
  'Network error',
  'OK',
  'Allow camera to capture a cover.',
  'Photo ID failed',
  'Unknown error',
  'Allow camera to take photos.',
  'Upload failed',
];

describe('Scan tab: every word, name and role survives the restyle', () => {
  const words = wordsOf(SCAN_TAB);

  it.each(SCAN_WORDS)('says "%s"', (word) => {
    expect(words).toContain(word);
  });

  it('Close scanner is a named button that goes back, or Home', () => {
    const { sf, els } = elements(
      SCAN_TAB,
      (el, s) => attrText(el, 'accessibilityLabel', s) === 'Close scanner',
    );
    expect(els).toHaveLength(1);
    const close = els[0]!;
    expect(tagOf(close, sf)).toBe('Pressable');
    expect(attrText(close, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(close, 'hitSlop', sf)).toBe('10');
    expect(attrText(close, 'onPress', sf)).toMatch(
      /if \(router\.canGoBack\(\)\) router\.back\(\);\s*else router\.replace\('\/'\);/,
    );
  });

  // The reference's segmented switch, carrying this tab's own two modes.
  it('the mode switch keeps Scan and Photo ID, each a button that says whether it is on', () => {
    const { sf, els } = elements(
      SCAN_TAB,
      (el, s) =>
        tagOf(el, s) === 'Pressable' && /^\(\) => setMode\(/.test(attrText(el, 'onPress', s) ?? ''),
    );
    expect(
      els.map((el) => [
        textOf(el, sf),
        attrText(el, 'onPress', sf),
        attrText(el, 'accessibilityRole', sf),
        attrText(el, 'accessibilityState', sf),
        attrText(el, 'hitSlop', sf),
      ]),
    ).toEqual([
      [
        'Scan',
        "() => setMode('lookup')",
        'button',
        "{ selected: mode === 'lookup' }",
        'SEGMENT_SLOP',
      ],
      [
        'Photo ID',
        "() => setMode('cover')",
        'button',
        "{ selected: mode === 'cover' }",
        'SEGMENT_SLOP',
      ],
    ]);
    // A 36pt segment whose target reaches the 44pt track's edge.
    const src = sourceOf(SCAN_TAB);
    expect(styleBlock(src, 'modeSegment')).toMatch(/minHeight: 36,/);
    expect(src).toContain('const SEGMENT_SLOP = { top: 4, bottom: 4 } as const;');
  });

  it('the camera emoji became an icon beside the same words', () => {
    expect(words.filter((w) => /\p{Extended_Pictographic}/u.test(w))).toEqual([]);
    const { sf, els } = elements(SCAN_TAB, (el, s) => tagOf(el, s) === 'Button');
    const byPress = (press: string) => els.filter((el) => attrText(el, 'onPress', sf) === press);
    const [capture] = byPress('captureCoverId');
    expect(codeOnly(capture!.getText(sf))).toContain("{busy ? 'Identifying…' : 'Capture cover'}");
    expect(attrText(capture!, 'leading', sf)).toMatch(/^busy \? undefined : <Camera\b/);
    const [photo] = byPress('capturePhoto');
    expect(textOf(photo!, sf)).toBe('Take photo');
    expect(attrText(photo!, 'leading', sf)).toMatch(/^<Camera\b/);
  });

  it('the permission screen keeps the neutral Continue, or Open Settings once iOS will not ask again', () => {
    const code = codeOnly(sourceOf(SCAN_TAB));
    expect(code).toContain(
      'if (!permission) return <CenterMessage>Loading camera permission…</CenterMessage>;',
    );
    const gate = code.slice(
      code.indexOf('if (!permission.granted) {'),
      code.indexOf('const storage = item ?'),
    );
    expect(gate).toMatch(
      /\{permission\.canAskAgain \? \(\s*<Button onPress=\{requestPermission\}[^>]*>\s*Continue\s*<\/Button>\s*\) : \(\s*<Button onPress=\{\(\) => Linking\.openSettings\(\)\}[^>]*>\s*Open Settings\s*<\/Button>\s*\)\}/,
    );
    expect(gate).not.toMatch(/\b(Grant|Allow)\b/);
  });
});

describe('Scan tab: the flows and their gates are unchanged', () => {
  const src = sourceOf(SCAN_TAB);
  const code = codeOnly(src);

  it('reads the camera with the same ten symbologies, into the same handler', () => {
    expect(src).toContain(SYMBOLOGIES);
    const { sf, els } = elements(SCAN_TAB, (el, s) => tagOf(el, s) === 'CameraView');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'onBarcodeScanned', sf)).toBe('onBarCodeScanned');
    expect(attrText(els[0]!, 'facing', sf)).toBe('back');
  });

  it('ignores a repeat of the code it just read', () => {
    expect(functionBody(src, SCAN_TAB, 'onBarCodeScanned')).toMatch(
      /^\{\s*if \(busy \|\| !orgId \|\| data === lastCode\) return;\s*setLastCode\(data\);/,
    );
  });

  it('resolves in the same order: packing slip, item label, barcode or SKU, then ISBN or UPC', () => {
    const body = functionBody(src, SCAN_TAB, 'onBarCodeScanned');
    const at = (s: string) => {
      const i = body.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    expect(at('const signToken = parseSignToken(data);')).toBeLessThan(
      at('const directId = parseItemId(data);'),
    );
    expect(at('const directId = parseItemId(data);')).toBeLessThan(
      at('await loadItemByValue(data)'),
    );
    expect(at("if (found === 'ambiguous')")).toBeLessThan(at('if (looksLikeIsbn(data))'));
    expect(at('if (looksLikeIsbn(data))')).toBeLessThan(at('/api/v1/books/isbn-lookup?isbn='));
    expect(at('/api/v1/books/isbn-lookup?isbn=')).toBeLessThan(at('/api/v1/items/upc-lookup?upc='));
    expect(body).toMatch(/if \(is404\) \{\s*setAddItem\(\{\s*upc: data,\s*source: 'not_found',/);
  });

  it('tells a packing-slip QR, an item label QR and an ISBN apart exactly as before', () => {
    const fns = screenFunctions(SCAN_TAB, ['parseItemId', 'parseSignToken', 'looksLikeIsbn']);
    const id = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
    expect(fns.parseItemId!(`https://stockpilotusa.com/p/items/${id}`)).toBe(id);
    expect(fns.parseItemId!(`https://stockpilotusa.com/dashboard/inventory/${id}`)).toBe(id);
    expect(fns.parseItemId!(`https://stockpilotusa.com/dashboard/books/${id}`)).toBe(id);
    expect(fns.parseItemId!('012345678905')).toBeNull();
    expect(fns.parseSignToken!('https://stockpilotusa.com/orders/sign/abc.DEF_12-~')).toBe(
      'abc.DEF_12-~',
    );
    expect(fns.parseSignToken!(`https://stockpilotusa.com/p/items/${id}`)).toBeNull();
    expect(fns.looksLikeIsbn!('978-0-7432-7356-5')).toBe(true);
    expect(fns.looksLikeIsbn!('0-306-40615-X')).toBe(true);
    expect(fns.looksLikeIsbn!('012345678905')).toBe(false);
  });

  it('offers −1, +1, +5 and +25 only to a member who may adjust, on an item that is not archived', () => {
    expect(code).toMatch(
      /const canQuickAdjust =\s*showWriteCta\(permissions, 'stock:adjust'\) && item\?\.status !== 'archived';/,
    );
    const { sf, els } = elements(SCAN_TAB, (el, s) => tagOf(el, s) === 'ActionBtn');
    expect(
      els.map((el) => [
        attrText(el, 'label', sf),
        attrText(el, 'onPress', sf),
        attrText(el, 'disabled', sf),
      ]),
    ).toEqual([
      ['−1', '() => void adjust(-1)', 'busy'],
      ['+1', '() => void adjust(1)', 'busy'],
      ['+5', '() => void adjust(5)', 'busy'],
      ['+25', '() => void adjust(25)', 'busy'],
    ]);
    // All four sit together under the gate.
    expect(code).toMatch(
      /\{canQuickAdjust && \(\s*<View style=\{styles\.actions\}>\s*(?:<ActionBtn\b[^\n]*\/>\s*){4}<\/View>\s*\)\}/,
    );
  });

  it('each stepper is one 52pt button for VoiceOver that grows rather than clips', () => {
    const { sf, els } = elements(
      SCAN_TAB,
      (el, s) => tagOf(el, s) === 'Pressable' && attrText(el, 'onPress', s) === 'onPress',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'disabled', sf)).toBe('disabled');
    expect(attrText(els[0]!, 'accessibilityRole', sf)).toBe('button');
    expect(styleBlock(src, 'actionBtn')).toMatch(/minHeight: 52,/);
    expect(styleBlock(src, 'actionBtn')).not.toMatch(/\bheight:/);
  });

  // Never optimistic: the number moves only to the total the server sent.
  it('never moves the number before the server answers: one paint, of the total it returned', () => {
    const body = functionBody(src, SCAN_TAB, 'adjust');
    const send = body.indexOf('await submitItemAdjust(itemId, delta, {');
    expect(send).toBeGreaterThan(-1);
    const paints = [...body.matchAll(/setItem\(/g)].map((m) => m.index);
    expect(paints).toHaveLength(1);
    expect(paints[0]).toBeGreaterThan(send);
    expect(body).toMatch(
      /const q = outcome\.quantityOnHand;[\s\S]*setItem\(\(prev\) => \(prev && prev\.id === itemId \? \{ \.\.\.prev, quantity_on_hand: q \} : prev\)\);/,
    );
    expect(body).not.toMatch(/quantity_on_hand\s*[+-]\s*delta/);
  });

  it('Report a problem shows only with the maintenance module and the submit permission', () => {
    expect(code).toMatch(
      /const canReportProblem =\s*maintenanceEnabled && showWriteCta\(permissions, 'maintenance_requests:submit'\);/,
    );
    expect(code).toMatch(
      /\{canReportProblem \? \(\s*<Button\b[\s\S]*?pathname: '\/maintenance\/new',[\s\S]*?params: \{ itemId: item\.id \},[\s\S]*?Report a problem\s*<\/Button>\s*\) : null\}/,
    );
  });

  it('Take photo and Scan another do what they did', () => {
    const { sf, els } = elements(SCAN_TAB, (el, s) => tagOf(el, s) === 'Button');
    const by = (word: string) => els.filter((el) => textOf(el, sf) === word);
    expect(
      by('Take photo').map((el) => [attrText(el, 'onPress', sf), attrText(el, 'disabled', sf)]),
    ).toEqual([['capturePhoto', 'busy']]);
    expect(by('Scan another').map((el) => attrText(el, 'onPress', sf))).toEqual(['reset']);
  });

  it('the result card keeps the photo or "No image", the name, SKU · barcode, On hand, Reorder at and Price', () => {
    expect(code).toMatch(
      /\{item\.image_url \? \(\s*<CachedImage uri=\{item\.image_url\} style=\{styles\.thumb\} recyclingKey=\{item\.id\} \/>\s*\) : \(/,
    );
    expect(code).toMatch(/\{item\.sku\}\s*\{item\.barcode \? ` · \$\{item\.barcode\}` : ''\}/);
    expect(code).toMatch(/<Text style=\{styles\.sheetName\} numberOfLines=\{2\}>\s*\{item\.name\}/);
    expect(code).toMatch(
      /<Text style=\{\[styles\.statValue, lowStock && styles\.statValueLow\]\}>\s*\{item\.quantity_on_hand\}\s*<\/Text>/,
    );
    expect(code).toMatch(
      /\{unconfirmed \? \(\s*<Text style=\{styles\.unconfirmedNote\}>\{unconfirmedScanLabel\(unconfirmed\)\}<\/Text>\s*\) : null\}/,
    );
    expect(code).toContain('<Text style={styles.statValueMuted}>{item.reorder_point}</Text>');
    expect(code).toContain('{formatCurrency(item.retail_price)}');
    expect(code).toMatch(
      /const lowStock =\s*item && item\.reorder_point > 0 && item\.quantity_on_hand <= item\.reorder_point;/,
    );
  });

  it('the on-hand note and the price read exactly as before', () => {
    const fns = screenFunctions(SCAN_TAB, ['unconfirmedScanLabel', 'formatCurrency']);
    expect(fns.unconfirmedScanLabel!({ mayStillLand: true })).toBe(
      'Not confirmed · may still be saving',
    );
    expect(fns.unconfirmedScanLabel!({ mayStillLand: false })).toBe(
      'Not confirmed · scan again to check',
    );
    expect(fns.formatCurrency!(12.5)).toBe('$12.50');
  });

  it('the location box keeps every row, in order, behind the same test', () => {
    expect(code).toMatch(
      /\{\(item\.primary_location_name \|\|\s*item\.bin_location \|\|\s*placement\?\.source === 'holdings' \|\|\s*elsewhereLoc \|\|\s*elsewhereNote \|\|\s*structuredRack \|\|\s*storage\?\.crateNumber \|\|\s*storage\?\.grade\) && \(\s*<View style=\{styles\.locationBox\}>/,
    );
    const box = code.slice(code.indexOf('<View style={styles.locationBox}>'));
    const order = [
      '<LocRow label="Location" value={item.primary_location_name} />',
      "label={placement.reason === 'split' ? 'Split stock' : 'In crate'}",
      '<LocRow label="Bin/shelf" value={item.bin_location} />',
      '{elsewhereLoc && <LocRow label="Elsewhere" value={elsewhereLoc.value} />}',
      '{elsewhereNote && <Text style={styles.locNote}>{elsewhereNote}</Text>}',
      '{structuredRack && <LocRow label="Rack" value={structuredRack} mono />}',
      '{storage?.crateNumber && (',
      'label="Grade"',
    ].map((s) => box.indexOf(s));
    expect(
      order.every((i) => i > -1),
      String(order),
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The crate: its number, beside a dot that is hollow when no colour is set.
    expect(box).toMatch(/styles\.crateDot,\s*crateHex \? \{ backgroundColor: crateHex \} : null,/);
    expect(box).toContain('<Text style={styles.locValue}>{storage.crateNumber}</Text>');
    expect(box).toMatch(
      /\/\^\\d\{1,2\}\$\/\.test\(storage\.grade\)\s*\? `Grade \$\{storage\.grade\}`\s*: storage\.grade/,
    );
  });

  it('the placement picker keeps its title, subtitle, rows and Cancel', () => {
    expect(code).toContain('<Text style={styles.pickerTitle}>Multiple placements found</Text>');
    expect(code).toContain(
      '<Text style={styles.pickerSubtitle}>{scanPickerSubtitle(placementChoices)}</Text>',
    );
    const rows = elements(
      SCAN_TAB,
      (el, s) =>
        tagOf(el, s) === 'Pressable' &&
        attrText(el, 'onPress', s) === '() => void choosePlacement(c)',
    );
    expect(rows.els).toHaveLength(1);
    const row = rows.els[0]!;
    expect(attrText(row, 'disabled', rows.sf)).toBe('busy');
    expect(attrText(row, 'accessibilityRole', rows.sf)).toBe('button');
    const rowCode = codeOnly(row.getText(rows.sf));
    expect(rowCode).toContain("{c.charterName ?? 'Unassigned charter'}");
    expect(rowCode).toMatch(/SKU \{c\.sku\}/);
    expect(rowCode).toMatch(/\{c\.binLocation \?\? 'No bin set'\} · \{c\.quantityOnHand\} on hand/);
    const cancel = elements(
      SCAN_TAB,
      (el, s) =>
        tagOf(el, s) === 'Button' && attrText(el, 'onPress', s) === 'cancelPlacementChoice',
    );
    expect(cancel.els).toHaveLength(1);
    expect(textOf(cancel.els[0]!, cancel.sf)).toBe('Cancel');
    expect(attrText(cancel.els[0]!, 'disabled', cancel.sf)).toBe('busy');
  });

  it('the Add book and Add item cards open with the same wiring', () => {
    for (const card of ['AddBookCard', 'AddItemCard']) {
      const { sf, els } = elements(SCAN_TAB, (el, s) => tagOf(el, s) === card);
      expect(els, card).toHaveLength(1);
      const el = els[0]!;
      expect(attrText(el, 'user', sf)).toBe('user');
      expect(attrText(el, 'result', sf)).toBe(card === 'AddBookCard' ? 'addBook' : 'addItem');
      expect(attrText(el, 'onCancel', sf)).toBe('reset');
      expect(codeOnly(attrText(el, 'onCreated', sf)!)).toMatch(
        /const found = await loadItemById\(id\);\s*if \(found\) showScannedItem\(found\);\s*else reset\(\);/,
      );
    }
  });

  it('a packing slip still opens the signature pad, which closes back to scanning', () => {
    const { sf, els } = elements(SCAN_TAB, (el, s) => tagOf(el, s) === 'SignaturePadModal');
    expect(els).toHaveLength(1);
    const pad = els[0]!;
    expect(attrText(pad, 'visible', sf)).toBe('signatureModalVisible');
    expect(attrText(pad, 'signatureToken', sf)).toBe('signatureToken');
    for (const prop of ['onClose', 'onSuccess']) {
      expect(codeOnly(attrText(pad, prop, sf)!), prop).toMatch(
        /setSignatureModalVisible\(false\);\s*setSignatureToken\(null\);\s*reset\(\);/,
      );
    }
    expect(code).toMatch(/\{signatureToken \? \(\s*<SignaturePadModal\b/);
  });
});

describe('Scan tab: the finder respects Reduce Motion', () => {
  const src = sourceOf(SCAN_TAB);

  it('asks iOS whether Reduce Motion is on, and keeps listening while the tab is mounted', () => {
    const body = functionBody(src, SCAN_TAB, 'useReduceMotion');
    expect(body).toContain('AccessibilityInfo.isReduceMotionEnabled()');
    expect(body).toMatch(/AccessibilityInfo\.addEventListener\('reduceMotionChanged',/);
    expect(body).toMatch(/return \(\) => \{\s*active = false;\s*sub\.remove\(\);\s*\};/);
  });

  // Mutation caught: the sweep starting before iOS has answered, or whatever
  // it answers (the base screen looped regardless of the setting).
  it('the scan line sweeps only when Reduce Motion is known to be off; otherwise it rests mid-frame', () => {
    const body = functionBody(src, SCAN_TAB, 'ScanReticle');
    expect(body).toContain('const reduceMotion = useReduceMotion();');
    expect(body).toContain('const t = useAnimatedValue(0.5);');
    const guard = body.search(
      /if \(reduceMotion !== false\) \{\s*t\.setValue\(0\.5\);\s*return;\s*\}/,
    );
    expect(guard).toBeGreaterThan(-1);
    expect(body.indexOf('Animated.loop(')).toBeGreaterThan(guard);
    expect(body).toContain('}, [t, reduceMotion]);');
  });
});

describe('Scan tab: Dynamic Type caps only the chrome', () => {
  const src = sourceOf(SCAN_TAB);
  const { sf, els } = elements(SCAN_TAB, (el, s) => tagOf(el, s) === 'Text');
  const capOf = (style: string) =>
    els
      .filter((el) => (attrText(el, 'style', sf) ?? '').includes(style))
      .map((el) => attrText(el, 'maxFontSizeMultiplier', sf));

  it('the mode switch, the steppers, the field labels and the placeholder are capped', () => {
    expect(src).toContain('const MODE_CAP = capTo(12.5, TYPE_CEILING.control);');
    expect(src).toContain('const STEP_CAP = capTo(18, TYPE_CEILING.control);');
    expect(src).toContain('const EYEBROW_CAP = capTo(11, TYPE_CEILING.eyebrow);');
    expect(src).toContain('const LABEL_CAP = capTo(10.5, TYPE_CEILING.eyebrow);');
    expect(src).toContain('const PLACEHOLDER_CAP = capTo(10, TYPE_CEILING.chrome);');
    expect(capOf('styles.modeLabel')).toEqual(['MODE_CAP', 'MODE_CAP']);
    expect(capOf('styles.actionLabel')).toEqual(['STEP_CAP']);
    expect(capOf('styles.reticleLabel')).toEqual(['EYEBROW_CAP']);
    expect(capOf('styles.statLabel')).toEqual(['LABEL_CAP', 'LABEL_CAP', 'LABEL_CAP']);
    expect(capOf('styles.locLabel')).toEqual(['LABEL_CAP', 'LABEL_CAP']);
    expect(capOf('styles.thumbPlaceholderText')).toEqual(['PLACEHOLDER_CAP']);
  });

  it('content scales all the way: names, SKUs, numbers, notes and hints', () => {
    for (const style of [
      'styles.sheetName',
      'styles.sheetSku',
      'styles.statValue',
      'styles.unconfirmedNote',
      'styles.locValue',
      'styles.locNote',
      'styles.pickerTitle',
      'styles.pickerSubtitle',
      'styles.pickerRow',
      'styles.hint',
      'styles.coverHint',
      'styles.permTitle',
      'styles.permBody',
      'styles.centerText',
    ]) {
      const caps = capOf(style);
      expect(caps.length, style).toBeGreaterThan(0);
      expect(
        caps.every((cap) => cap === undefined),
        style,
      ).toBe(true);
    }
  });

  it('rows stack past the stacking scale', () => {
    expect(src).toContain('const stacked = shouldStackRow(useWindowDimensions().fontScale);');
    expect(src).toContain('<View style={[styles.statRow, stacked && styles.statRowStacked]}>');
    expect(src).toContain(
      '<View style={[styles.secondaryActions, stacked && styles.secondaryActionsStacked]}>',
    );
  });
});

describe('Scan tab: the camera chrome is dark in both modes and reads at AA', () => {
  const src = sourceOf(SCAN_TAB);
  let tokens: Record<string, string> | null = null;
  /** Read on first use, so a missing block fails the tests that need it. */
  const camera = new Proxy({} as Record<string, string>, {
    get: (_t, name: string) => (tokens ??= cameraTokens(SCAN_TAB))[name],
  });

  it('draws the bar, the viewfinder and the finder from the dark palette, never the device mode', () => {
    expect(src).toContain("const CAMERA_PALETTE = palette('dark');");
    expect(camera.surface).toBe('#0a0b09');
    expect(camera.reticle).toBe(DARK.accent);
    for (const name of [
      'container',
      'cameraBar',
      'closeBtn',
      'modeTrack',
      'modeSegmentOn',
      'modeLabel',
      'modeLabelOn',
      'viewfinder',
      'corner',
      'scanLine',
      'caption',
      'reticleLabel',
      'hint',
    ]) {
      const block = styleBlock(src, name);
      expect(block, name).toMatch(/CAMERA\.\w+/);
      expect(block, name).not.toMatch(/\bc\.\w+/);
    }
    expect(src).toContain('<X size={20} color={CAMERA.ink} strokeWidth={1.8} />');
    expect(src).toContain('<ActivityIndicator color={CAMERA.ink} size="large" />');
  });

  it('is the same camera as the count scanner', () => {
    expect(cameraTokens(SCAN_TAB)).toEqual(cameraTokens(COUNT_SCANNER));
  });

  it('every word and mark on the camera reads at AA, over any picture', () => {
    expect(contrast(camera.ink!, camera.chip!)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(camera.chipBorder!, camera.surface!)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(camera.ink3!, camera.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(camera.ink!, camera.segment!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(camera.reticle!, camera.surface!)).toBeGreaterThanOrEqual(AA_UI);
    const [hex, alpha] = rgba(camera.scrim!);
    for (const scene of ['#ffffff', '#808080', '#000000']) {
      const ground = over(hex, alpha, scene);
      expect(contrast(camera.ink2!, ground), scene).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(camera.ink!, ground), scene).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('the light clock and battery go with the dark bar, only while the tab is on screen', () => {
    expect(src).toContain('const focused = useIsFocused();');
    expect(src).toContain('{focused ? <StatusBar style="light" /> : null}');
  });
});

describe('Scan tab: the cards and the permission screen follow the device mode', () => {
  const src = sourceOf(SCAN_TAB);

  it('is off the light-only legacy alias, the single-mode accents and the system mono', () => {
    expect(themeImports(SCAN_TAB)).not.toContain('theme');
    expect(themeImports(SCAN_TAB)).not.toContain('ACCENT');
    expect(src).toContain('const { mode: themeMode, c: colors } = useTheme();');
    expect(src).toContain(
      "const SCAN_STYLES = { light: makeStyles(palette('light')), dark: makeStyles(palette('dark')) };",
    );
    expect(wordsOf(SCAN_TAB)).not.toContain('Menlo');
  });

  it('words take ink, ink2 or ink3, never the faint inks', () => {
    const reads = [...paletteReads(SCAN_TAB, 'c'), ...paletteReads(SCAN_TAB, 'colors')];
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((t) => t === 'ink4' || t === 'ink5')).toEqual([]);
  });

  it('the cards name the tokens measured below', () => {
    expect(styleBlock(src, 'sheet')).toMatch(
      /backgroundColor: c\.card,[\s\S]*borderColor: c\.hair,/,
    );
    expect(styleBlock(src, 'statValueLow')).toMatch(/color: c\.warnText/);
    expect(styleBlock(src, 'unconfirmedNote')).toMatch(/color: c\.warnText,/);
    expect(styleBlock(src, 'locationBox')).toMatch(/backgroundColor: c\.sunk,/);
    expect(styleBlock(src, 'crateDot')).toMatch(/borderColor: c\.ink3/);
    expect(styleBlock(src, 'thumb')).toMatch(/backgroundColor: PHOTO_BACKGROUND,/);
    expect(styleBlock(src, 'thumbPlaceholderText')).toMatch(/color: c\.ink3,/);
    expect(styleBlock(src, 'page')).toMatch(/backgroundColor: c\.paper/);
  });

  it.each(MODES)(
    '%s: every pair the cards and the permission screen draw reads at AA',
    (_mode, p) => {
      // Names, numbers, labels, the low on hand and the "Not confirmed" note.
      for (const t of [p.ink, p.ink3, p.warnText])
        expect(contrast(t, p.card)).toBeGreaterThanOrEqual(AA_TEXT);
      // The location box, the "No image" square and the picker rows.
      for (const t of [p.ink, p.ink3]) expect(contrast(t, p.sunk)).toBeGreaterThanOrEqual(AA_TEXT);
      // The hollow crate ring, a mark.
      expect(contrast(p.ink3, p.sunk)).toBeGreaterThanOrEqual(AA_UI);
      // The permission screen.
      for (const t of [p.ink, p.ink3]) expect(contrast(t, p.paper)).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );
});

describe('Scan tab: none of the reference sample content was added', () => {
  it.each(NOT_THE_PRODUCTS.map((re) => [re.source, re] as const))(
    'nothing reads %s',
    (_name, re) => {
      expect(wordsOf(SCAN_TAB).filter((w) => re.test(w))).toEqual([]);
    },
  );

  it('has no Single / Batch switch: its two modes are Scan and Photo ID', () => {
    expect(codeOnly(sourceOf(SCAN_TAB))).not.toMatch(/burst|batch/i);
  });
});
