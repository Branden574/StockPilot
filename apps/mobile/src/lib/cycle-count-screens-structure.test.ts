import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import { buttonTone, meterColor, meterTrack, pillTone } from '../components/ui/tones';
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
 * THE PHONE'S CYCLE-COUNT SCREENS, READ AS SOURCE (redesign package P5.9a).
 *
 * The Counts tab, the count picker (cycle-count/new), the count screen
 * (cycle-count/[id]) with its Release and Reassign sheets, and the AI shelf
 * scan took the redesign look on the per-mode palette: the count screen, the
 * AI scan and the two sheets came off the light-only legacy `theme` alias,
 * the AI scan's camera bars took the count scanner's always-dark recipe, and
 * the picker rows draw the shared CheckboxMark. The look is what moved. These
 * pin what had to survive it: every word, spoken name, role and state, the
 * gates, the offline rules (count capture works offline, Post is blocked
 * while this count has unsynced edits), the Release and Reassign reasons,
 * the AI review, and the shared count selection; and the four fixes made on
 * the way (the keyboard over the count boxes and the Notes box, the Post
 * button over the home indicator, the unnamed count boxes, the unnamed X
 * buttons on the picker).
 *
 * The mobile suite has no React Native renderer, so the files are read with
 * the TypeScript parser, as scanner-structure.test.ts and
 * header-chip-a11y.test.ts read theirs, and every colour pair the screens
 * draw is measured with the palette it comes from, in both modes.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const COUNTS_TAB = 'app/(drawer)/(tabs)/cycle-counts.tsx';
const PICKER = 'app/cycle-count/new.tsx';
const COUNT = 'app/cycle-count/[id].tsx';
const AI_SCAN = 'app/cycle-count/ai-scan/[id].tsx';
const RELEASE = 'src/components/cycle-count-release-sheet.tsx';
const REASSIGN = 'src/components/cycle-count-reassign-sheet.tsx';
/** P3.8's count scanner: read only, as the camera recipe the AI scan matches. */
const COUNT_SCANNER = 'app/cycle-count/scan/[id].tsx';

const FILES = [COUNTS_TAB, PICKER, COUNT, AI_SCAN, RELEASE, REASSIGN];

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

/** The body of `function name(...)` (or `async function`), comments dropped. */
function functionBody(file: string, name: string): string {
  const sf = treeOf(file);
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
    if (ts.isJsxText(n)) parts.push(n.getText(sf).replace(/\s+/g, ' ').trim());
    ts.forEachChild(n, visit);
  };
  visit(el);
  return parts.filter(Boolean).join(' ');
}

/** The touchables of a file whose words are exactly `words`. */
function touchablesSaying(file: string, words: string) {
  const { sf, els } = elements(file, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
  return { sf, els: els.filter((el) => textOf(el, sf) === words) };
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

/** The body of one `name: { ... }` entry of a file's StyleSheet. */
function styleBlock(file: string, name: string): string {
  const block = new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(sourceOf(file))?.[1];
  expect(block, `${file} has no style ${name}`).toBeDefined();
  return block!;
}

/** Named imports a file takes from a module. */
function importsFrom(file: string, module: string): string[] {
  const sf = treeOf(file);
  const names: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.moduleSpecifier.text !== module) continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamedImports(b))
      for (const el of b.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
}

/** `name: 'value'` or `name: CAMERA_PALETTE.token` inside a file's `const CAMERA = {...}`. */
function cameraTokens(file: string): Record<string, string> {
  const block = /const CAMERA = \{([\s\S]*?)\n\} as const;/.exec(sourceOf(file))?.[1];
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

/**
 * Top-level helper functions of a screen, compiled from the repository's own
 * source (never from input) and run in an empty context: the pure helpers
 * whose answers are the behaviour (what a box counts as), as
 * scanner-structure.test.ts runs the Scan tab's.
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

// ── The palette ──────────────────────────────────────────────────────────

describe('every cycle-count screen draws in the device mode', () => {
  it.each(FILES)('%s: off the light-only legacy alias, on useTheme()', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(importsFrom(file, '@/lib/theme')).not.toContain('theme');
    expect(code).not.toMatch(/\btheme\./);
    expect(importsFrom(file, '@/lib/use-theme')).toEqual(['useTheme']);
    expect(code).toContain('useTheme()');
  });

  // ACCENT's single values fall under AA as words in one mode or the other;
  // paper2 is the card colour in dark mode, so a fill of it shows nothing.
  it.each(FILES)('%s: no mode-independent accent, no paper2 fill', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toContain('paper2');
  });

  // The always-dark camera surface is the one fixed colour (DESIGN-SPEC 10).
  it.each(FILES)('%s: no hard-coded colour but the camera surface', (file) => {
    const hexes = codeOnly(sourceOf(file)).match(/['"]#[0-9a-fA-F]{3,8}['"]/g) ?? [];
    expect(hexes).toEqual(file === AI_SCAN ? ["'#0a0b09'"] : []);
    // The only translucent colours: the app's sheet scrim (per mode) on the
    // two sheets, the hint's scrim on the AI scan's camera.
    const rgbas = codeOnly(sourceOf(file)).match(/'rgba\([^']*\)'/g) ?? [];
    expect(rgbas).toEqual(
      file === RELEASE || file === REASSIGN
        ? ["'rgba(0,0,0,0.6)'", "'rgba(14,15,13,0.4)'"]
        : file === AI_SCAN
          ? ["'rgba(10, 11, 9, 0.72)'"]
          : [],
    );
  });

  // ink4 and ink5 hold words under AA; ink4 stays for marks only.
  it.each(FILES)(
    '%s: no word in ink4 or ink5 (the picker keeps ink4 on its " · " separator)',
    (file) => {
      const code = codeOnly(sourceOf(file));
      const uses = code.match(/c\.ink[45]\b/g) ?? [];
      if (file === PICKER) {
        expect(uses).toEqual(['c.ink4']);
        expect(code).toMatch(/<Mono size=\{12\.5\} color=\{c\.ink4\}>\s*\{' · '\}\s*<\/Mono>/);
      } else {
        expect(uses).toEqual([]);
      }
    },
  );

  it.each(FILES)('%s: every placeholder is the muted ink (at AA)', (file) => {
    const { sf, els } = elements(file, (el, s) => tagOf(el, s) === 'TextInput');
    for (const input of els) {
      if (attrText(input, 'placeholder', sf) === undefined) continue;
      expect(attrText(input, 'placeholderTextColor', sf)).toBe('c.ink3');
    }
  });

  // A tap target VoiceOver outlines is the one a finger can hit.
  it.each(FILES)('%s: no hitSlop on any control', (file) => {
    const { sf, els } = elements(file, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    expect(els.filter((el) => attrText(el, 'hitSlop', sf) !== undefined)).toEqual([]);
  });
});

// ── The count screen (M-CA-03) ───────────────────────────────────────────

describe('count screen: every word, name and role survives the restyle', () => {
  const words = wordsOf(COUNT);

  it.each([
    '← Back',
    'Back',
    'CYCLE COUNT',
    'Cycle count',
    'Long press to copy the reference',
    'AI Scan',
    'Scan',
    'Assigned to another employee',
    'Release',
    'Reassign',
    'Dismiss',
    'Expected is the system quantity when the line was counted (the quantity at session start until then). Stock that moves after a line is counted is kept when the count is posted.',
    'Expected:',
    '· unsynced',
    'Matches expected',
    'Variance ',
    'Recount for ',
    'an exception',
    'This count has no lines yet. Add lines from the web first.',
    'Check again',
    'Could not load this count',
    'If the app was just updated, the server may still be catching up.',
    'This count could not be read on this phone.',
    'Not cached for offline use',
    'Open this cycle count once while online to use it offline next time.',
    'Retry',
    'Offline',
    'Reconnect to post this cycle count. Your counts are saved locally and will sync first.',
    'Sync first',
    'There are unsynced edits. Wait for sync to finish (or tap the badge to retry) before posting.',
    'Post cycle count?',
    'All lines will be applied as adjustments to inventory.',
    ' not counted will be skipped (no variance applied).',
    'Post',
    'Cancel',
    'Could not post',
    'Posted',
    'Variance adjustments applied.',
  ])('says "%s"', (word) => {
    expect(words).toContain(word);
  });

  // The check mark that led "Matches expected" became an icon.
  it('no check-mark glyph in the words; the icon draws it', () => {
    expect(words.some((w) => /✓/.test(w))).toBe(false);
    expect(codeOnly(sourceOf(COUNT))).toMatch(
      /\{variance === 0 \? <Check size=\{14\} color=\{c\.ink3\} strokeWidth=\{2\} \/> : null\}/,
    );
  });

  it('the reference is mono, selectable, and named for VoiceOver', () => {
    const code = codeOnly(sourceOf(COUNT));
    expect(code).toMatch(
      /<Text\s+style=\{\[styles\.title, styles\.reference, \{ color: c\.ink \}\]\}\s+selectable\s+accessibilityLabel=\{`Cycle count \$\{headerView\.reference\}`\}\s+accessibilityHint="Long press to copy the reference"/,
    );
    expect(styleBlock(COUNT, 'reference')).toContain('fontFamily: FONT.mono');
  });

  // Each was a pressable with words and no role (VoiceOver read the words but
  // not that they act), and Release / Reassign were 32pt with hitSlop.
  it.each(['AI Scan', 'Scan', 'Release', 'Reassign', 'Check again', 'Dismiss'])(
    '"%s" is a button in a frame at least 44pt tall',
    (word) => {
      const { sf, els } = touchablesSaying(COUNT, word);
      expect(els).toHaveLength(1);
      const el = els[0]!;
      expect(attrText(el, 'accessibilityRole', sf)).toBe('button');
      const styleNames = [...(attrText(el, 'style', sf) ?? '').matchAll(/styles\.(\w+)/g)].map(
        (m) => m[1]!,
      );
      expect(styleNames.some((n) => /minHeight: MIN_TAP\b/.test(styleBlock(COUNT, n)))).toBe(true);
    },
  );

  it('the four header actions keep the chrome cap, so the title keeps its width', () => {
    const code = codeOnly(sourceOf(COUNT));
    expect(code).toContain('const SCAN_LABEL_CAP = capTo(13, TYPE_CEILING.chrome);');
    for (const word of ['AI Scan', 'Scan', 'Release', 'Reassign']) {
      expect(code).toMatch(
        new RegExp(`maxFontSizeMultiplier=\\{SCAN_LABEL_CAP\\}\\s*>\\s*${word}\\s*</Text>`),
      );
    }
  });

  it('AI Scan, Scan, Release, Reassign and Check again are outline buttons: the one ink button is Post', () => {
    const code = codeOnly(sourceOf(COUNT));
    expect(code).toContain("const outline = buttonTone('outline', c);");
    expect(code).toContain("const post = buttonTone('primary', c);");
    expect(code.match(/backgroundColor: outline\.bg, borderColor: outline\.border/g)).toHaveLength(
      5,
    );
    expect(code.match(/backgroundColor: post\.bg, borderColor: post\.border/g)).toHaveLength(1);
    // The purple AI Scan fill is gone.
    expect(code).not.toContain('aiScanBtn');
  });
});

describe('count screen: the gates are unchanged', () => {
  const code = codeOnly(sourceOf(COUNT));

  it('AI Scan and Scan only on an open count this reader can count; otherwise who holds it', () => {
    expect(code).toMatch(
      /\{header && canAdjust && isOpen \? \([\s\S]*?router\.push\(`\/cycle-count\/ai-scan\/\$\{header\.id\}`\)[\s\S]*?router\.push\(`\/cycle-count\/scan\/\$\{header\.id\}`\)[\s\S]*?\) : header && isOpen && !isAssignee && !canManage \? \(/,
    );
    expect(code).toContain('const canAdjust = canWrite && (isAssignee || canManage);');
  });

  it('Release for the assignee or a manager; Reassign for a manager; both only on an open count', () => {
    expect(code).toMatch(
      /\{isOpen && !!header\?\.assignedTo && \(header\.assignedTo === user\?\.id \|\| canManage\) \? \(\s*<Pressable\s+onPress=\{\(\) => setReleaseOpen\(true\)\}/,
    );
    expect(code).toMatch(
      /\{isOpen && canManage \? \(\s*<Pressable\s+onPress=\{\(\) => setReassignOpen\(true\)\}/,
    );
  });

  it('the count boxes are frozen unless the count is open and this reader can count', () => {
    expect(code).toContain('editable={isOpen && canAdjust}');
    expect(code).toMatch(/\{!loading && lines\.length > 0 && isOpen && canAdjust && \(/);
  });
});

describe('count screen: offline capture and the Post rule', () => {
  const src = sourceOf(COUNT);

  // Post is refused offline, then while THIS count has unsynced edits (a
  // count still waiting for its save among them), and only then asks to
  // confirm and posts.
  it('Post is blocked offline and while this count has unsynced edits', () => {
    const body = functionBody(COUNT, 'postCount');
    const offline = body.indexOf("if (syncSnapshot.status === 'offline') {");
    const unsaved = body.indexOf('const unsaved = hasUnsavedCount(draft);');
    const flush = body.indexOf('if (unsaved) lineSaver.flushAll();');
    const read = body.indexOf('pending = await pendingCountFor(header.id);');
    const pending = body.indexOf('if (unsaved || pending > 0) {');
    const confirm = body.indexOf("'Post cycle count?'");
    const post = body.indexOf('await postCycleCount(header.id);');
    expect(offline).toBeGreaterThan(-1);
    expect(unsaved).toBeGreaterThan(offline);
    expect(flush).toBeGreaterThan(unsaved);
    expect(read).toBeGreaterThan(flush);
    expect(pending).toBeGreaterThan(read);
    expect(confirm).toBeGreaterThan(pending);
    expect(post).toBeGreaterThan(confirm);
    expect(body).toMatch(
      /if \(unsaved \|\| pending > 0\) \{\s*Alert\.alert\(\s*'Sync first',[\s\S]*?\);\s*return;\s*\}/,
    );
    // The tally starts from the one on screen, so an outbox that cannot be
    // read blocks exactly as before, never less.
    expect(body).toContain('let pending = pendingForThis;');
  });

  // Fix: a count typed within SAVE_DEBOUNCE_MS (300 ms) of tapping Post was
  // neither saved nor queued, so Post was not blocked; the post could reach
  // the server before that line's count, which then posted without it and
  // had its queued count refused. The screen's own rule, run: which boxes
  // hold a count, and whether one is still waiting for its save.
  it('a count still waiting for its save blocks Post; an emptied box or a lone minus does not', () => {
    const { countFromBox, hasUnsavedCount } = screenFunctions(COUNT, [
      'countFromBox',
      'hasUnsavedCount',
    ]);
    const verdicts = Object.fromEntries(
      ['', '   ', '0', ' 0 ', '12', '2.5', '-1', '-', 'abc', '.'].map((raw) => [
        raw,
        countFromBox!(raw),
      ]),
    );
    expect(verdicts).toEqual({
      '': null,
      '   ': null,
      '0': 0,
      ' 0 ': 0,
      '12': 12,
      '2.5': 2.5,
      '-1': null,
      '-': null,
      abc: null,
      '.': null,
    });
    expect(hasUnsavedCount!({})).toBe(false);
    expect(hasUnsavedCount!({ l1: '' })).toBe(false);
    expect(hasUnsavedCount!({ l1: '', l2: '-' })).toBe(false);
    expect(hasUnsavedCount!({ l1: '', l2: '7' })).toBe(true);
    expect(hasUnsavedCount!({ l1: '0' })).toBe(true);
  });

  it('a typed count is saved on the phone first and queued, never posted from the box', () => {
    expect(codeOnly(src)).toMatch(
      /createDraftDebouncer\(SAVE_DEBOUNCE_MS, \(lineId, raw\) => \{[\s\S]*?const num = countFromBox\(raw\);\s*if \(num === null\) return;\s*await updateLocalLine\(lineId, num\);[\s\S]*?void cycleCountSync\.forceSync\(\);/,
    );
    expect(codeOnly(src)).toContain('onChangeText={(v) => setDraftValue(l.id, v)}');
  });

  // Every box that holds a count is saved before the confirm, so the lines
  // the post skips are the ones with no saved count (an emptied box among
  // them; it used to be left out of "not counted").
  it('"not counted will be skipped" counts every line with no saved count', () => {
    const body = functionBody(COUNT, 'postCount');
    expect(body).toContain('const uncounted = lines.filter((l) => l.counted === null);');
    expect(body.indexOf('const uncounted')).toBeGreaterThan(
      body.indexOf('if (unsaved || pending > 0) {'),
    );
  });

  // Fix: load() is fire-and-forget, so a throw from the phone's store left
  // the screen loading for good. Offline, a store that cannot be read is
  // said ("not cached" would be untrue); online, the fetch still runs.
  it('a copy on the phone that cannot be read is said, never an endless spinner', () => {
    const code = codeOnly(src);
    expect(code).toMatch(
      /let cacheUnreadable = false;\s*try \{\s*cached = await getCycleCount\(id\);\s*\} catch \{\s*cacheUnreadable = true;\s*\}/,
    );
    expect(code).toMatch(
      /if \(!online\) \{\s*if \(!cached\) \{\s*if \(cacheUnreadable\) \{\s*setReadError\(COUNT_UNREADABLE_ON_PHONE\);\s*setEmptyState\('read-failed'\);\s*\} else \{\s*setEmptyState\('offline-uncached'\);\s*\}\s*setLoading\(false\);/,
    );
    expect(code).toContain(
      "const COUNT_UNREADABLE_ON_PHONE = 'This count could not be read on this phone.';",
    );
  });

  it('the Post button: its role and disabled state for VoiceOver, its words from the footer, wrapping', () => {
    const { sf, els } = elements(
      COUNT,
      (el, s) => tagOf(el, s) === 'Pressable' && attrText(el, 'onPress', s) === 'postCount',
    );
    expect(els).toHaveLength(1);
    const btn = els[0]!;
    expect(attrText(btn, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(btn, 'accessibilityState', sf)).toBe('{ disabled: footer.disabled }');
    expect(attrText(btn, 'disabled', sf)).toBe('footer.disabled');
    // A partial post keeps its warning fill, as before, with words in the
    // page colour (measured below).
    expect(attrText(btn, 'style', sf)).toContain(
      'footer.partial && { backgroundColor: c.warnText, borderColor: c.warnText }',
    );
    const label = elements(
      COUNT,
      (el, s) => tagOf(el, s) === 'Text' && el.getText(s).includes('{footer.label}'),
    ).els;
    expect(label).toHaveLength(1);
    expect(attrText(label[0]!, 'numberOfLines', sf)).toBeUndefined();
    expect(attrText(label[0]!, 'maxFontSizeMultiplier', sf)).toBeUndefined();
    expect(attrText(label[0]!, 'style', sf)).toBe('[styles.postBtnText, { color: post.fg }]');
  });

  // Fix: the footer is pinned to the bottom of the screen and the Post
  // button sat over the home indicator. The measured reservation follows it.
  it('the footer stands clear of the home indicator, and the list reserves its measured height', () => {
    const code = codeOnly(src);
    expect(code).toContain('const insets = useSafeAreaInsets();');
    expect(code).toMatch(
      /paddingBottom: space\.md \+ insets\.bottom,\s*\},\s*\]\}\s*onLayout=\{\(e\) => setFooterHeight\(e\.nativeEvent\.layout\.height\)\}/,
    );
    expect(code).toContain('paddingBottom: footerReservation(footerHeight, 140),');
  });

  // Fix: a count box opens a number pad, which covered the lower lines with
  // no way to scroll the last ones above it.
  it('the lines scroll clear of the keyboard', () => {
    const { sf, els } = elements(COUNT, (el, s) => tagOf(el, s) === 'ScrollView');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'automaticallyAdjustKeyboardInsets', sf)).toBe('true');
  });

  // Fix: VoiceOver read only a box's value, never which item it counts.
  it('each count box is named for its line, numeric, recessed and mono', () => {
    const { sf, els } = elements(COUNT, (el, s) => tagOf(el, s) === 'TextInput');
    expect(els).toHaveLength(1);
    const box = els[0]!;
    expect(attrText(box, 'accessibilityLabel', sf)).toBe('`Counted, ${l.itemName}`');
    expect(attrText(box, 'keyboardType', sf)).toBe('numeric');
    expect(attrText(box, 'placeholder', sf)).toBe('—');
    expect(attrText(box, 'style', sf)).toContain('backgroundColor: c.sunk, borderColor: c.hair2');
    expect(styleBlock(COUNT, 'countInput')).toContain('fontFamily: FONT.mono');
    // A 44pt target (it was about 36pt), grown, never fixed.
    expect(styleBlock(COUNT, 'countInput')).toMatch(/minHeight: MIN_TAP\b/);
    expect(styleBlock(COUNT, 'countInput')).not.toMatch(/(^|[^a-zA-Z])height:/);
    // The typed number is content: never capped.
    expect(attrText(box, 'maxFontSizeMultiplier', sf)).toBeUndefined();
  });

  it('variance: more in the accent, less in the refusal red, a match in muted ink', () => {
    expect(codeOnly(src)).toContain(
      'color: variance > 0 ? c.accent : variance < 0 ? c.critText : c.ink3,',
    );
  });

  it('the sync badge stays in the header, drawn for the device mode the screen now follows', () => {
    const { sf, els } = elements(COUNT, (el, s) => tagOf(el, s) === 'SyncStatusBadge');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'surface', sf)).toBeUndefined();
  });

  it('the progress bar draws the same counted-of-total the header says, never a new number', () => {
    expect(codeOnly(src)).toMatch(
      /\{headerView\.kind === 'known' && lines\.length > 0 \? \(\s*<View style=\{styles\.progress\}>\s*<StockBar value=\{countedCount\} max=\{lines\.length\} height=\{4\} \/>/,
    );
  });

  it('a linked exception is a link in a 44pt frame around the warning chip', () => {
    const { sf, els } = elements(
      COUNT,
      (el, s) => tagOf(el, s) === 'Pressable' && attrText(el, 'accessibilityRole', s) === 'link',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'style', sf)).toBe('styles.linkFrame');
    expect(styleBlock(COUNT, 'linkFrame')).toMatch(/minHeight: MIN_TAP\b/);
    expect(codeOnly(src)).toContain("const warnPill = pillTone('warn', c);");
    expect(codeOnly(src)).toContain(
      '{ backgroundColor: warnPill.bg, borderColor: warnPill.border }',
    );
  });

  it('the lines are one hairline card: the first row draws the top, the last the bottom', () => {
    const code = codeOnly(src);
    expect(code).toMatch(
      /styles\.line,\s*\{ backgroundColor: c\.card, borderColor: c\.hair \},\s*i === 0 && styles\.lineFirst,\s*i === lines\.length - 1 && styles\.lineLast,/,
    );
    expect(styleBlock(COUNT, 'lineFirst')).toContain('borderTopWidth: 1');
  });

  it('reads nothing new (the organization and the count, as before)', () => {
    expect([...codeOnly(src).matchAll(/\.from\('(\w+)'\)/g)].map((m) => m[1])).toEqual([
      'organizations',
      'cycle_counts',
    ]);
  });
});

// ── Release and Reassign (M-CA-03a) ──────────────────────────────────────

/** The sheet's parts: the scrim, its container and the card beside it. */
function sheetShape(file: string) {
  const sf = treeOf(file);
  let scrim: JsxNode | null = null;
  let container: JsxNode | null = null;
  walkJsx(sf, (el, ancestors) => {
    if (tagOf(el, sf) !== 'Pressable' || attrText(el, 'accessibilityLabel', sf) !== 'Close') return;
    scrim = el;
    container = ancestors[ancestors.length - 1] ?? null;
  });
  expect(scrim, `${file}: no Close scrim`).not.toBeNull();
  return { sf, scrim: scrim! as JsxNode, container: container! as JsxNode };
}

describe.each([
  [RELEASE, 'Release this cycle count?'],
  [REASSIGN, 'Reassign this count'],
])('%s: a sheet VoiceOver can use', (file, title) => {
  it('the backdrop is a childless sibling named Close that closes, on a tap and a VoiceOver double tap', () => {
    const { sf, scrim, container } = sheetShape(file);
    expect(ts.isJsxSelfClosingElement(scrim)).toBe(true);
    expect(attrText(scrim, 'onPress', sf)).toBe('onClose');
    expect(attrText(scrim, 'onAccessibilityTap', sf)).toBe('onClose');
    expect(attrText(scrim, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim, 'style', sf)).toContain('StyleSheet.absoluteFill');
    expect(attrText(scrim, 'style', sf)).toContain(
      "mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)'",
    );
    expect(tagOf(container, sf)).toBe('View');
    expect(attrText(container, 'accessibilityViewIsModal', sf)).toBe('true');
    expect(attrText(container, 'onAccessibilityEscape', sf)).toBe('onClose');
    expect(attrText(container, 'style', sf)).toContain("justifyContent: 'flex-end'");
  });

  it('the card is a plain View on the card colour; its title is a header', () => {
    const code = codeOnly(sourceOf(file));
    expect(code).toContain(
      '<View style={[styles.sheet, { backgroundColor: c.card }, SHADOW.sheet]}>',
    );
    expect(code).toMatch(
      new RegExp(
        `<Text accessibilityRole="header" style=\\{\\[styles\\.title, \\{ color: c\\.ink \\}\\]\\}>\\s*${title.replace('?', '\\?')}\\s*</Text>`,
      ),
    );
  });

  it('starts blank every time it opens (remounted per opening), and fades in', () => {
    const code = codeOnly(sourceOf(file));
    expect(code).toContain('key={String(visible)}');
    expect(code).toMatch(
      /<Modal\s+visible=\{visible\}\s+transparent\s+animationType="fade"\s+onRequestClose=\{onClose\}\s+statusBarTranslucent/,
    );
  });

  it('Cancel is the outline button and the commit the ink one; both buttons with a disabled state', () => {
    const code = codeOnly(sourceOf(file));
    expect(code).toContain("const cancelTone = buttonTone('outline', c);");
    expect(code).toMatch(/const (releaseTone|reassignTone) = buttonTone\('primary', c\);/);
    const { sf, els } = elements(
      file,
      (el, s) =>
        tagOf(el, s) === 'Pressable' &&
        attrText(el, 'style', s)?.includes('styles.action') === true,
    );
    expect(els.map((el) => textOf(el, sf))).toEqual([
      'Cancel',
      file === RELEASE ? 'Release count' : 'Reassign',
    ]);
    for (const el of els) {
      expect(attrText(el, 'accessibilityRole', sf)).toBe('button');
      expect(attrText(el, 'accessibilityState', sf)).toMatch(/^\{ disabled: /);
    }
    // The commit keeps its words beside the spinner.
    expect(els[1]!.getText(sf)).toMatch(
      /\{submitting \? <ActivityIndicator color=\{\w+Tone\.fg\} \/> : null\}\s*<Text/,
    );
    expect(styleBlock(file, 'action')).toContain('minHeight: 52');
  });

  it('a refusal is said in the refusal red, as an alert', () => {
    expect(codeOnly(sourceOf(file))).toMatch(
      /<Text accessibilityRole="alert" style=\{\[styles\.error, \{ color: c\.critText \}\]\}>\s*\{error\}/,
    );
  });
});

describe('Release: the reasons and the rule', () => {
  const code = codeOnly(sourceOf(RELEASE));

  it('the nine owner-approved reasons, in order', () => {
    const block = /const REASON_CATEGORIES = \[([\s\S]*?)\] as const;/.exec(code)?.[1] ?? '';
    expect([...block.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([
      'Shift ending',
      'Unable to locate inventory',
      'Equipment unavailable',
      'Scanner or device problem',
      'Safety issue',
      'Wrong assignment',
      'Workload conflict',
      'Need manager assistance',
      'Other',
    ]);
  });

  it('"Other" needs a note; any other reason may carry one', () => {
    expect(code).toContain("const needsNotes = category === 'Other';");
    expect(code).toContain(
      'const canSubmit = !!category && (!needsNotes || notes.trim().length > 0) && !submitting;',
    );
    expect(code).toContain(
      "const notePrompt = needsNotes ? 'Add a note (required)' : 'Add a note (optional)';",
    );
    expect(code).toMatch(
      /category === 'Other'\s*\? notes\.trim\(\)\s*: notes\.trim\(\)\s*\? `\$\{category\} — \$\{notes\.trim\(\)\}`\s*: category;/,
    );
    expect(code).toMatch(
      /api\(`\/api\/v1\/cycle-counts\/\$\{cycleCountId\}\/release`, \{\s*method: 'POST',\s*body: \{ reason \},/,
    );
  });

  // They were pressables with no role or state: VoiceOver could not tell
  // which reason was chosen. A 44pt target (they were 40pt).
  it('each reason is a button that says whether it is chosen, a 44pt target', () => {
    const { sf, els } = elements(
      RELEASE,
      (el, s) =>
        tagOf(el, s) === 'Pressable' && attrText(el, 'onPress', s) === '() => setCategory(cat)',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!, 'accessibilityState', sf)).toBe('{ selected }');
    expect(styleBlock(RELEASE, 'reason')).toMatch(/minHeight: MIN_TAP\b/);
    expect(code).toContain('borderColor: selected ? c.ink : c.hair2,');
    expect(code).toContain('backgroundColor: selected ? c.ink : c.card,');
    expect(code).toContain('color: selected ? c.paper : c.ink,');
  });
});

describe('Reassign: the members and the rule', () => {
  const code = codeOnly(sourceOf(REASSIGN));

  it('a member and a reason are both required; the request is unchanged', () => {
    expect(code).toContain(
      'const canSubmit = !!selected && reason.trim().length > 0 && !submitting;',
    );
    expect(code).toMatch(
      /api\(`\/api\/v1\/cycle-counts\/\$\{cycleCountId\}\/reassign`, \{\s*method: 'POST',\s*body: \{ assignedTo: selected, reason: reason\.trim\(\) \},/,
    );
    expect(code).toContain('.filter((m) => m.userId !== currentAssigneeId)');
  });

  it('each member is a button that says whether it is chosen', () => {
    const { sf, els } = elements(
      REASSIGN,
      (el, s) =>
        tagOf(el, s) === 'Pressable' &&
        attrText(el, 'onPress', s) === '() => setSelected(m.userId)',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!, 'accessibilityState', sf)).toBe('{ selected: sel }');
  });

  it('a failed member read says so with Try again, a 44pt button; never "no other members"', () => {
    const { sf, els } = touchablesSaying(REASSIGN, 'Try again');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'onPress', sf)).toBe('retryMembers');
    expect(attrText(els[0]!, 'accessibilityRole', sf)).toBe('button');
    expect(styleBlock(REASSIGN, 'retry')).toMatch(/minHeight: MIN_TAP\b/);
    expect(code).toMatch(
      /<Text accessibilityRole="alert" style=\{\[styles\.failed, \{ color: c\.critText \}\]\}>\s*Could not load team members\./,
    );
  });

  it.each([
    'Reassign this count',
    'Assign to',
    'Reason (required)',
    'No other team members to assign.',
    'Could not reassign the count. Try again.',
  ])('says "%s"', (word) => {
    expect(wordsOf(REASSIGN)).toContain(word);
  });
});

// ── The count picker (M-CA-02) ───────────────────────────────────────────

describe('count picker: the shared selection, as checkbox rows', () => {
  const code = codeOnly(sourceOf(PICKER));

  it.each([
    ' ITEM',
    ' SELECTED',
    'New',
    'count.',
    'Search and check the items to count — picks made from the Items or Books tabs show up here too.',
    'Inventory',
    'Books',
    'Search books by title, SKU, barcode',
    'Search items by name, SKU, barcode',
    'Search items to count',
    'Clear search',
    'Couldn&rsquo;t load',
    '. Check your connection and pull back in.',
    'on hand',
    'Load more (',
    'remaining)',
    'selected',
    'Clear',
    ' — check at least one item to start a count',
    'PRODUCTS · ',
    'BOOKS · ',
    'Notes (optional)',
    'e.g. Spot count · Rack 3',
    'Start count',
    'Count started',
    'Could not start count',
    'Please try again.',
  ])('says "%s"', (word) => {
    expect(wordsOf(PICKER)).toContain(word);
  });

  // P2.5b's rule: the row is the press target and VoiceOver's checkbox; it
  // draws the shared mark alone.
  it('each row draws CheckboxMark, toggles the shared store, and is a checkbox with its state', () => {
    const { sf, els } = elements(
      PICKER,
      (el, s) =>
        tagOf(el, s) === 'Pressable' && attrText(el, 'accessibilityRole', s) === 'checkbox',
    );
    expect(els).toHaveLength(1);
    const row = els[0]!;
    expect(attrText(row, 'onPress', sf)).toBe('() => countSelection.toggle(pickFromRow(row))');
    expect(attrText(row, 'accessibilityState', sf)).toBe('{ checked: picked }');
    expect(attrText(row, 'accessibilityLabel', sf)).toBe('`Select ${row.name}`');
    expect(row.getText(sf)).toContain('<CheckboxMark checked={picked} />');
    expect(code).toContain('const picked = useIsPicked(row.id);');
    expect(code).toContain('const PickerRow = React.memo(function PickerRow(');
    expect(code).not.toMatch(/\bCheckCircle2\b|\bCircle\b/);
  });

  // DESIGN-SPEC 6.21 and the Items / Books rows: paper2 showed nothing in
  // dark mode, where it is the card colour. The list's card clips to its
  // corners, so a picked first or last row never paints square ones.
  it('a picked row takes the accent wash, inside the card’s rounded corners', () => {
    expect(code).toContain("backgroundColor: picked ? c.accentWash : 'transparent'");
    expect(code).toContain('<Card padding={0} style={styles.pickerCard}>');
    expect(styleBlock(PICKER, 'pickerCard')).toContain("overflow: 'hidden'");
  });

  it('Load more keeps its words as its name while the spinner stands in for them', () => {
    const { sf, els } = elements(
      PICKER,
      (el, s) =>
        tagOf(el, s) === 'Pressable' && attrText(el, 'onPress', s) === '() => void loadMore()',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityLabel', sf)).toBe(
      '`Load more (${remaining} remaining)`',
    );
    expect(attrText(els[0]!, 'accessibilityState', sf)).toBe(
      '{ disabled: loadingMore, busy: loadingMore }',
    );
  });

  // A PostgREST error's details and hint can quote row values.
  it('a failed read logs its message only', () => {
    expect(code).toContain("console.warn('count picker', error.message);");
    expect(code).not.toContain("console.warn('count picker', error);");
  });

  it('the tabs are tabs (role and selected state), 44pt segments on a recessed track', () => {
    const { sf, els } = elements(
      PICKER,
      (el, s) => tagOf(el, s) === 'Pressable' && attrText(el, 'accessibilityRole', s) === 'tab',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityState', sf)).toBe('{ selected: active }');
    expect(styleBlock(PICKER, 'tabBtn')).toMatch(/minHeight: MIN_TAP\b/);
    expect(styleBlock(PICKER, 'tabBtn')).toContain('flexShrink: 1');
    expect(code).toContain('<View style={[styles.tabs, { backgroundColor: c.sunk }]}>');
    expect(code).toContain("borderColor: active ? c.ink3 : 'transparent',");
  });

  // Start count commits the count: the ink button, a button to VoiceOver
  // (it was a pressable on the ink colour with no role).
  it('Start count is the shared ink Button, off with no picks or while starting', () => {
    const { sf, els } = elements(PICKER, (el, s) => tagOf(el, s) === 'Button');
    expect(els).toHaveLength(1);
    const start = els[0]!;
    expect(textOf(start, sf)).toBe('Start count');
    expect(attrText(start, 'variant', sf)).toBeUndefined();
    expect(attrText(start, 'onPress', sf)).toBe('start');
    expect(attrText(start, 'disabled', sf)).toBe('busy || picks.length === 0');
    expect(attrText(start, 'leading', sf)).toBe(
      'busy ? <ActivityIndicator color={c.paper} /> : undefined',
    );
    expect(code).not.toMatch(/<Pressable[^>]*onPress=\{start\}/);
  });

  it('the start sends the picks once, clears them when the count starts, and says what it left out', () => {
    const body = functionBody(PICKER, 'start');
    expect(body).toMatch(/if \(picks\.length === 0 \|\| busy\) return;/);
    expect(body).toMatch(
      /scope: 'selection',\s*itemIds: picks\.map\(\(p\) => p\.id\),\s*notes: notes\.trim\(\) \|\| null,/,
    );
    expect(body.indexOf('countSelection.clear();')).toBeGreaterThan(
      body.indexOf("await api<StartResult>('/api/v1/cycle-counts'"),
    );
    expect(body).toContain(
      "router.replace({ pathname: '/cycle-count/[id]', params: { id: res.id } });",
    );
  });

  // Each was an unnamed X (VoiceOver found an icon with no words) or words
  // with no role, with hitSlop.
  it('the X buttons say what they remove, and every small control is a 44pt button', () => {
    const { sf, els } = elements(PICKER, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    const byPress = (press: string) => els.find((el) => attrText(el, 'onPress', sf) === press)!;
    expect(attrText(byPress("() => setQ('')"), 'accessibilityLabel', sf)).toBe('Clear search');
    expect(attrText(byPress('() => countSelection.remove(p.id)'), 'accessibilityLabel', sf)).toBe(
      '`Remove ${p.name}`',
    );
    for (const press of [
      "() => setQ('')",
      '() => countSelection.remove(p.id)',
      '() => void loadMore()',
      '() => countSelection.clear()',
    ]) {
      const el = byPress(press);
      expect(attrText(el, 'accessibilityRole', sf), press).toBe('button');
    }
    for (const name of ['clearFrame', 'removeFrame', 'loadMore', 'clearPicks']) {
      expect(styleBlock(PICKER, name), name).toMatch(/minHeight: MIN_TAP\b/);
    }
  });

  // Dynamic Type: the box was a fixed 44pt and the text a 100% height, so
  // the typed words clipped at the larger sizes.
  it('the search box grows with its words (minHeight, never a fixed height)', () => {
    expect(styleBlock(PICKER, 'searchBox')).toMatch(/minHeight: MIN_TAP\b/);
    expect(styleBlock(PICKER, 'searchBox')).not.toMatch(/\bheight:/);
    expect(styleBlock(PICKER, 'searchInput')).not.toMatch(/\bheight:/);
  });

  // Fix: the Notes box sits at the foot of the form and the keyboard
  // covered it.
  it('the form scrolls clear of the keyboard, and the Notes box is named', () => {
    const { sf, els } = elements(PICKER, (el, s) => tagOf(el, s) === 'ScrollView');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'automaticallyAdjustKeyboardInsets', sf)).toBe('true');
    const notes = elements(
      PICKER,
      (el, s) => tagOf(el, s) === 'TextInput' && attrText(el, 'value', s) === 'notes',
    ).els;
    expect(attrText(notes[0]!, 'accessibilityLabel', sf)).toBe('Notes (optional)');
    expect(attrText(notes[0]!, 'maxLength', sf)).toBe('2000');
  });
});

// ── The Counts tab (M-CA-01) ─────────────────────────────────────────────

describe('Counts tab: words, the filters and the offline view', () => {
  const code = codeOnly(sourceOf(COUNTS_TAB));

  it.each([
    'Start a cycle count',
    'Pick what you want to count, then tap Select.',
    'Pick items',
    'Pick books',
    'OFFLINE · ',
    ' DOWNLOADED',
    'OFFLINE',
    ' IN PROGRESS',
    'Offline · searching downloaded counts only',
    'TODAY',
    'started',
    'ACTIVE',
    'in progress',
    'PENDING',
    'to sync',
    'Search count #, warehouse, or notes…',
    'Search cycle counts',
    'Clear search',
    'All',
    'Cycle counts did not load.',
    'Trying again…',
    'Try again',
    'Clear search and filters',
    'No counts are downloaded to this device',
    'Nothing downloaded to this device matches. Older counts are searchable when you are back online.',
    'No counts match your search.',
    'Open counts download when you are online. Connect to see your full history.',
    'Tap ＋ to start a count — pick items or books, tap Select, then Review. Or start one from the web.',
    'Counts started from the web appear here for review.',
    'Previous',
    'Next',
    'POSTED',
    'CANCELED',
    'DOWNLOADED',
    'SYNCED',
    'Ready to post · not finished',
    '% counted',
    'Opens the count',
    'Searching downloaded counts only',
    'Showing downloaded counts only',
  ])('says "%s"', (word) => {
    expect(wordsOf(COUNTS_TAB)).toContain(word);
  });

  // The shared Chip is 36pt; the filter chips are the reference's (6.6) at
  // 44pt, with the same role, state and words.
  it('the status filters are 44pt chips: All and every status, each a button with its selected state', () => {
    expect(code).toMatch(
      /\{\[null, \.\.\.CYCLE_COUNT_STATUSES\]\.map\(\(s\) => \(\s*<FilterChip\s+key=\{s \?\? 'all'\}\s+label=\{s \? CYCLE_COUNT_STATUS_LABELS\[s\] : 'All'\}\s+active=\{view\.status === s\}\s+onPress=\{\(\) => setStatus\(s\)\}/,
    );
    expect(importsFrom(COUNTS_TAB, '@/components/ui/chip')).toEqual([]);
    const body = functionBody(COUNTS_TAB, 'FilterChip');
    expect(body).toContain('accessibilityRole="button"');
    expect(body).toContain('accessibilityState={{ selected: active }}');
    expect(body).toContain("backgroundColor: active ? c.ink : 'transparent',");
    expect(body).toContain('borderColor: active ? c.ink : c.hair2,');
    expect(body).toContain('color={active ? c.paper : c.ink2}');
    expect(styleBlock(COUNTS_TAB, 'filterChip')).toMatch(/minHeight: MIN_TAP\b/);
  });

  it('every small Button is 44pt tall', () => {
    const { sf, els } = elements(COUNTS_TAB, (el, s) => tagOf(el, s) === 'Button');
    expect(els.length).toBeGreaterThan(0);
    for (const el of els) expect(attrText(el, 'style', sf)).toBe('TAP');
    expect(code).toContain('const TAP = { minHeight: MIN_TAP };');
  });

  it('Clear search is a 44pt frame and the pager buttons need no hitSlop', () => {
    expect(styleBlock(COUNTS_TAB, 'clearFrame')).toMatch(
      /minWidth: MIN_TAP,\s*minHeight: MIN_TAP,/,
    );
    expect(styleBlock(COUNTS_TAB, 'pagerButton')).toMatch(/minHeight: 44\b/);
    const body = functionBody(COUNTS_TAB, 'PagerButton');
    expect(body).toContain('accessibilityLabel={`${label} page`}');
    expect(body).toContain('accessibilityState={{ disabled }}');
    expect(body).toContain('backgroundColor: c.card,');
    expect(body).toContain('borderColor: c.hair2,');
  });

  it('PENDING is the per-mode warning, and the reference is mono', () => {
    expect(code).toContain(
      "const valueColor = kind === 'mint' ? c.accent : kind === 'warn' ? c.warnText : c.ink;",
    );
    expect(code).toMatch(
      /<Mono size=\{15\.5\} tracking=\{0\.01\} color=\{c\.ink\}>\s*\{reference\}\s*<\/Mono>/,
    );
  });

  // Fix: a failed read of the phone's unsynced lines was an unhandled
  // rejection that left PENDING at "0 to sync" and every open card SYNCED,
  // claims made from a store that was never read.
  it('unsynced lines that cannot be read are unknown: PENDING shows a dash and no card claims SYNCED', () => {
    expect(code).toMatch(
      /React\.useState<Map<string, number> \| null>\(\s*\(\) => new Map\(\),\s*\)/,
    );
    expect(code).toMatch(
      /void dirtyLineCounts\(\)\.then\(\s*\(dirty\) => \{\s*if \(guard\.current\.isCurrent\(token\)\) setPendingByCount\(dirty\);\s*\},\s*\(\) => \{\s*if \(guard\.current\.isCurrent\(token\)\) setPendingByCount\(null\);\s*\},\s*\);/,
    );
    expect(code).toMatch(
      /try \{\s*const dirty = await dirtyLineCounts\(\);\s*setPendingByCount\(dirty\);\s*\} catch \{\s*setPendingByCount\(null\);\s*\}/,
    );
    expect(code).toContain("value={pendingTotal === null ? '—' : String(pendingTotal)}");
    expect(code).toContain('pending={pendingByCount ? (pendingByCount.get(item.id) ?? 0) : null}');
    const card = functionBody(COUNTS_TAB, 'CountCard');
    expect(card).toContain('const syncUnknown = pending === null;');
    expect(card).toMatch(
      /: !syncUnknown && pending > 0 \? \(\s*<Pill status="warn">PENDING<\/Pill>\s*\) : row\.source === 'downloaded' \? \(\s*<Pill>DOWNLOADED<\/Pill>\s*\) : syncUnknown \? null : \(\s*<Pill status="ok">SYNCED<\/Pill>\s*\);/,
    );
  });

  it('the offline banner is a recessed panel, never claiming "none downloaded" about an unread store', () => {
    expect(code).toContain(
      '<View style={[styles.offlineBanner, { backgroundColor: c.sunk, borderColor: c.hair }]}>',
    );
    expect(code).toMatch(/const empty = error \? \(\s*downloaded \? \(/);
  });
});

// ── The AI shelf scan (M-CA-05) ──────────────────────────────────────────

describe('AI shelf scan: every word, name and step survives the restyle', () => {
  const code = codeOnly(sourceOf(AI_SCAN));

  it.each([
    'Camera access needed',
    'AI Shelf Scan uses the camera to identify books on the shelf.',
    'Camera access is off for StockPilot. Turn it on in Settings to use AI Shelf Scan.',
    'Continue',
    'Open Settings',
    'Cancel',
    'AI Shelf Scan',
    'book',
    'books',
    'in this count',
    'Frame one shelf row from straight on',
    'Capture photo',
    'Capturing…',
    'Analyzing photo…',
    'Tap to capture',
    '← Back',
    'Back',
    'Review AI counts',
    'High confidence',
    'Tap to override if needed',
    'Low confidence — needs review',
    'Enter a count to confirm',
    'Not detected',
    "AI didn't see these — enter manually if needed",
    'Saving…',
    'Confirm counts',
    'Expected',
    ' · AI ',
    '%',
    'Nothing to save',
    'Tap a line to confirm the AI count or enter a manual value.',
    'No cached lines',
    'Open this cycle count from the list once while online so it can be cached for AI scanning.',
    'Could not load this count',
    'This count could not be read on this phone.',
    'Capture failed',
    'Scan failed',
    'This count has no books to scan.',
    'Partially saved',
    'Save failed',
  ])('says "%s"', (word) => {
    expect(wordsOf(AI_SCAN)).toContain(word);
  });

  // Fix: a throw from the phone's store was an unhandled rejection that left
  // "0 books in this count" over a camera with nothing to match.
  it('lines on the phone that cannot be read are said, and the screen goes back', () => {
    expect(code).toMatch(
      /try \{\s*snap = await getCycleCount\(cycleCountId\);\s*\} catch \{\s*Alert\.alert\('Could not load this count', 'This count could not be read on this phone\.', \[\s*\{ text: 'OK', onPress: \(\) => router\.back\(\) \},\s*\]\);\s*return;\s*\}\s*if \(!snap\) \{\s*Alert\.alert\(\s*'No cached lines',/,
    );
  });

  it('the review never writes an AI count the person did not approve', () => {
    expect(code).toContain('const AI_CONFIDENCE_THRESHOLD = 0.85;');
    const body = functionBody(AI_SCAN, 'onConfirm');
    expect(body).toMatch(
      /if \(rl\.override !== null\) \{[\s\S]*?continue;\s*\}\s*if \(rl\.result && rl\.result\.confidence >= AI_CONFIDENCE_THRESHOLD\) \{/,
    );
  });

  it('Confirm counts is the one ink Button, off while saving', () => {
    const { sf, els } = elements(
      AI_SCAN,
      (el, s) => tagOf(el, s) === 'Button' && attrText(el, 'onPress', s) === 'onConfirm',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'variant', sf)).toBeUndefined();
    expect(attrText(els[0]!, 'disabled', sf)).toBe('saving');
    expect(els[0]!.getText(sf)).toContain("{saving ? 'Saving…' : 'Confirm counts'}");
  });

  it('the three confidence sections keep their order, each with its rail in a tone that reads (3:1)', () => {
    expect(code).toMatch(
      /title="High confidence"\s+subtitle="Tap to override if needed"\s+color=\{c\.accent\}[\s\S]*title="Low confidence — needs review"\s+subtitle="Enter a count to confirm"\s+color=\{c\.warnText\}[\s\S]*title="Not detected"\s+subtitle="AI didn't see these — enter manually if needed"\s+color=\{c\.ink3\}/,
    );
  });

  // Fix: the boxes were unnamed (VoiceOver read the number alone) and a
  // fixed 70pt wide; the number pad covered the lower lines.
  it('each line box is named for its book, grows with its number, and scrolls clear of the keyboard', () => {
    const { sf, els } = elements(AI_SCAN, (el, s) => tagOf(el, s) === 'TextInput');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityLabel', sf)).toBe('`Counted, ${rl.line.itemName}`');
    expect(attrText(els[0]!, 'keyboardType', sf)).toBe('numeric');
    expect(attrText(els[0]!, 'editable', sf)).toBe('!disabled');
    expect(styleBlock(AI_SCAN, 'rowQty')).toMatch(/minWidth: 70\b/);
    expect(styleBlock(AI_SCAN, 'rowQty')).not.toMatch(/\bwidth: 70\b/);
    // A 44pt target (it was about 29pt tall).
    expect(styleBlock(AI_SCAN, 'rowQty')).toMatch(/minHeight: 44\b/);
    const scroll = elements(AI_SCAN, (el, s) => tagOf(el, s) === 'ScrollView').els;
    expect(scroll).toHaveLength(1);
    expect(attrText(scroll[0]!, 'automaticallyAdjustKeyboardInsets', sf)).toBe('true');
  });

  it('the permission screen keeps the neutral Continue, or Open Settings once iOS will not ask again', () => {
    expect(code).toMatch(
      /\{permission\.canAskAgain \? \(\s*<Button onPress=\{requestPermission\}[^>]*>\s*Continue\s*<\/Button>\s*\) : \(\s*<Button onPress=\{\(\) => Linking\.openSettings\(\)\}[^>]*>\s*Open Settings\s*<\/Button>\s*\)\}/,
    );
  });

  it('the shelf photo sits on the photo ground with a hairline edge', () => {
    expect(code).toContain(
      'style={[styles.reviewPhoto, { backgroundColor: PHOTO_BACKGROUND, borderColor: c.hair }]}',
    );
    expect(code).toContain('resizeMode="cover"');
  });
});

describe('AI shelf scan: the camera chrome is the count scanner’s, dark in both modes', () => {
  const src = sourceOf(AI_SCAN);
  const code = codeOnly(src);

  it('its CAMERA block matches the count scanner’s for every token they share', () => {
    const mine = cameraTokens(AI_SCAN);
    const scanner = cameraTokens(COUNT_SCANNER);
    for (const name of [
      'surface',
      'ink',
      'ink2',
      'ink3',
      'chip',
      'chipBorder',
      'reticle',
      'scrim',
    ]) {
      expect(mine[name], name).toBeDefined();
      expect(mine[name], name).toBe(scanner[name]);
    }
  });

  it('the bars are solid (they were translucent black over the picture)', () => {
    for (const name of ['root', 'barArea', 'topBar', 'bottomBar', 'viewfinder']) {
      expect(styleBlock(AI_SCAN, name), name).toContain('backgroundColor: CAMERA.surface');
    }
    expect(code).not.toMatch(/rgba\(0,\s*0,\s*0/);
    // The chrome never reads the device palette.
    for (const name of [
      'closeBtn',
      'closeText',
      'headerLabel',
      'headerSub',
      'corner',
      'hintPill',
      'hint',
      'captureBtn',
      'captureBtnInner',
      'captureCaption',
    ]) {
      expect(styleBlock(AI_SCAN, name), name).not.toMatch(/\bc\./);
      expect(styleBlock(AI_SCAN, name), name).toMatch(/CAMERA\./);
    }
  });

  it('the sync badge is drawn for the camera bar', () => {
    const { sf, els } = elements(AI_SCAN, (el, s) => tagOf(el, s) === 'SyncStatusBadge');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'surface', sf)).toBe('camera');
  });

  // Fix: in light mode the root's dark clock and battery sat on the dark bar.
  it('light status-bar words over the camera only; the review and the permission screen follow the device', () => {
    expect(code.match(/<StatusBar style="light" \/>/g)).toHaveLength(1);
    expect(functionBody(AI_SCAN, 'ReviewView')).not.toContain('StatusBar');
    const screen = functionBody(AI_SCAN, 'AiScanScreen');
    expect(screen.indexOf('<StatusBar')).toBeGreaterThan(screen.indexOf('<ReviewView'));
    expect(screen.indexOf('<StatusBar')).toBeGreaterThan(screen.indexOf('Camera access needed'));
  });

  it('the finder is four mint corner brackets in the shelf-row frame, with no scan line', () => {
    const body = functionBody(AI_SCAN, 'ShelfFrame');
    expect(body.match(/styles\.corner, styles\.corner(TL|TR|BL|BR)/g)).toHaveLength(4);
    expect(code).not.toContain('scanLine');
    expect(styleBlock(AI_SCAN, 'frame')).toContain('width: 280, height: 360');
  });

  it('the shutter keeps its name, role and state, and Cancel its 44pt frame', () => {
    const { sf, els } = elements(
      AI_SCAN,
      (el, s) => tagOf(el, s) === 'Pressable' && attrText(el, 'onPress', s) === 'onCapture',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityLabel', sf)).toBe('Capture photo');
    expect(attrText(els[0]!, 'disabled', sf)).toBe("phase.kind !== 'idle'");
    expect(styleBlock(AI_SCAN, 'closeFrame')).toMatch(/minHeight: 44, minWidth: 44/);
  });
});

// ── Contrast, both modes ─────────────────────────────────────────────────

describe('the colours the cycle-count screens draw, measured in both modes', () => {
  it.each(MODES)('%s: words at AA, marks at 3:1', (_mode, c) => {
    const words: [string, string, string][] = [
      // The count screen.
      ['Post words on the ink fill', buttonTone('primary', c).fg, buttonTone('primary', c).bg],
      [
        'a partial Post: page-colour words on the warning fill',
        buttonTone('primary', c).fg,
        c.warnText,
      ],
      ['outline button words', buttonTone('outline', c).fg, buttonTone('outline', c).bg],
      ['eyebrow and subtitle on the page', c.ink3, c.paper],
      ['SKU, Expected and capture time on the card', c.ink3, c.card],
      ['the variant on the card', c.ink2, c.card],
      ['a variance over, in the accent', c.accent, c.card],
      ['a variance under, in the refusal red', c.critText, c.card],
      ['unsynced, in the warning', c.warnText, c.card],
      ['a typed count in its recessed box', c.ink, c.sunk],
      ['the box placeholder', c.ink3, c.sunk],
      ['the linked-exception chip', pillTone('warn', c).fg, pillTone('warn', c).bg],
      ['the conflict banner', c.ink, c.warnWash],
      ['Dismiss on the banner', c.warnText, c.warnWash],
      // The Counts tab and the picker.
      ['an idle filter chip on the page', c.ink2, c.paper],
      ['a chosen filter chip', c.paper, c.ink],
      ['a chosen segment', c.ink, c.card],
      ['an idle segment on its track', c.ink3, c.sunk],
      ['a picked row', c.ink, c.accentWash],
      ['a picked row’s SKU and on hand', c.ink3, c.accentWash],
      ['PENDING in the warning', c.warnText, c.card],
      ['the offline banner', c.ink3, c.sunk],
      // The sheets.
      ['a chosen reason or member', c.paper, c.ink],
      ['an idle reason or member', c.ink, c.card],
      ['a refusal on the sheet', c.critText, c.card],
      ['the reason box placeholder', c.ink3, c.sunk],
      // The AI review.
      ['a review line’s Expected and AI confidence', c.ink3, c.card],
    ];
    for (const [what, fg, bg] of words) {
      expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(AA_TEXT);
    }
    const marks: [string, string, string][] = [
      ['the count progress fill on its track', meterColor('ok', c), meterTrack(c)],
      ['the chosen segment’s ring on the track', c.ink3, c.sunk],
      ['the chosen segment’s ring on its card fill', c.ink3, c.card],
      ['a ticked box on a picked row', c.ink, c.accentWash],
      ['the high-confidence rail', c.accent, c.paper],
      ['the low-confidence rail', c.warnText, c.paper],
      ['the not-detected rail', c.ink3, c.paper],
    ];
    for (const [what, fg, bg] of marks) {
      expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  // The camera chrome is the same in both modes.
  it('the AI scan’s camera bars', () => {
    const cam = cameraTokens(AI_SCAN);
    expect(contrast(cam.ink!, cam.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(cam.ink2!, cam.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(cam.ink!, cam.chip!)).toBeGreaterThanOrEqual(AA_TEXT); // Cancel
    expect(contrast(cam.chipBorder!, cam.surface!)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(cam.reticle!, cam.surface!)).toBeGreaterThanOrEqual(AA_UI);
    // The shutter's ring on the bar, and its disc in the ring.
    expect(contrast(cam.ink!, cam.surface!)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(cam.ink!, cam.chip!)).toBeGreaterThanOrEqual(AA_UI);
    // The hint over the live picture, on its scrim over white and over black.
    const [hex, alpha] = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/
      .exec(cam.scrim!)!
      .slice(1)
      .reduce<[string, number]>(
        (acc, v, i) =>
          i < 3 ? [acc[0] + Number(v).toString(16).padStart(2, '0'), acc[1]] : [acc[0], Number(v)],
        ['#', 0],
      );
    expect(contrast(cam.ink2!, over(hex, alpha, '#ffffff'))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(cam.ink2!, over(hex, alpha, '#000000'))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
