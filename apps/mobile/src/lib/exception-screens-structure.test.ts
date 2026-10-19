import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import { meterColor, meterTrack, pillTone } from '../components/ui/tones';
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
 * THE PHONE'S EXCEPTION SCREENS, READ AS SOURCE (redesign package P5.9a).
 *
 * The Exceptions list (with its recount selection), one exception, the
 * Acknowledge / Add note / Confirm sheet and the Photos section with its two
 * sheets took the redesign look on the per-mode palette: the Open / Resolved
 * tabs became the reference's segmented switch, the select rows draw the
 * shared CheckboxMark (P2.5b) while selecting, the facts, timeline and
 * history became hairline rows on one card, the photos sit on the photo
 * ground, and every word in ink4 moved to ink3. These pin what had to survive
 * the restyle: every word, the role switch on the select rows, the 44pt
 * targets, and the colours, measured in both modes. The behaviour (what each
 * action sends, offline, the server's gates) is pinned in
 * exceptions-screen-wiring, exceptions-recount-wiring,
 * exceptions-confirm-wiring, exception-escalation-wiring and
 * exception-evidence-wiring, which this restyle left unchanged.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const LIST = 'app/(drawer)/exceptions.tsx';
const DETAIL = 'app/exceptions/[id].tsx';
const NOTE_SHEET = 'src/components/exception-note-sheet.tsx';
const PHOTOS = 'src/components/exception-evidence-section.tsx';
const PHOTO_SHEETS = 'src/components/exception-evidence-sheets.tsx';

const FILES = [LIST, DETAIL, NOTE_SHEET, PHOTOS, PHOTO_SHEETS];

const MODES: [string, Palette][] = [
  ['light', palette('light')],
  ['dark', palette('dark')],
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

/** The source of `function name(...)`, comments dropped. */
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

function elements(file: string, match: (el: JsxNode, sf: ts.SourceFile) => boolean) {
  const sf = treeOf(file);
  const els: JsxNode[] = [];
  walkJsx(sf, (el) => {
    if (match(el, sf)) els.push(el);
  });
  return { sf, els };
}

/** Everything a person can read or hear in a file (literals and JSX text). */
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

// ── The palette ──────────────────────────────────────────────────────────

describe('every exception screen draws in the device mode', () => {
  it.each(FILES)('%s: on useTheme(), no mode-independent accent, no paper2 fill', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).toContain('useTheme()');
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toContain('paper2');
    expect(code).not.toMatch(/['"]#[0-9a-fA-F]{3,8}['"]/);
  });

  // ink4 and ink5 held references, times and placeholders under AA.
  it.each(FILES)('%s: no word, placeholder or icon in ink4 or ink5', (file) => {
    expect(codeOnly(sourceOf(file)).match(/c\.ink[45]\b/g) ?? []).toEqual([]);
  });

  it.each([NOTE_SHEET, PHOTO_SHEETS])(
    '%s: the note box is recessed with the stronger border, its count turns the refusal red',
    (file) => {
      const code = codeOnly(sourceOf(file));
      expect(code).toContain('{ borderColor: c.hair2, backgroundColor: c.sunk, color: c.ink }');
      expect(code).toMatch(
        /color=\{(count > EXCEPTION_NOTE_MAX|text\.tooLong) \? c\.critText : c\.ink3\}/,
      );
      expect(code).toMatch(
        /<Body size=\{13\} color=\{c\.critText\} accessibilityRole="alert">\s*\{error\}/,
      );
    },
  );
});

// ── The list (M-SG-02) ───────────────────────────────────────────────────

describe('Exceptions list: words, tabs and the recount selection', () => {
  const code = codeOnly(sourceOf(LIST));

  it.each([
    'INVENTORY · EXCEPTIONS',
    'Exceptions',
    'Select',
    'Done',
    'Check now',
    'Starting...',
    'Open',
    'Resolved, last ',
    ' days',
    'Try again',
    'Nothing resolved',
    'Selected for a recount',
    'Tap to select for a recount',
    'Tap the exceptions a count can settle to recount them together.',
    ' selected',
    'Critical',
    'Warning',
    'Already present when tracking began',
    'Resolved ',
    'First seen ',
    'Showing the first ',
    ' exceptions. There are more; the web page lists the same set.',
    'Recount ',
    ' exception',
  ])('says "%s"', (word) => {
    expect(wordsOf(LIST)).toContain(word);
  });

  // They were 22pt pills inside unframed pressables.
  it('Open / Resolved is a segmented switch: two 44pt buttons with their selected state', () => {
    const body = functionBody(LIST, 'StatusTab');
    expect(body).toContain('accessibilityRole="button"');
    expect(body).toContain('accessibilityState={{ selected: active }}');
    expect(body).toContain("backgroundColor: active ? c.card : 'transparent',");
    expect(body).toContain("borderColor: active ? c.ink3 : 'transparent',");
    expect(styleBlock(LIST, 'tab')).toMatch(/minHeight: MIN_TAP\b/);
    expect(code).toContain('<View style={[styles.tabs, { backgroundColor: c.sunk }]}>');
    expect(code).toMatch(
      /<StatusTab label="Open" active=\{status === 'open'\} onPress=\{\(\) => setStatus\('open'\)\} \/>/,
    );
    expect(code).toMatch(
      /<StatusTab\s+label=\{`Resolved, last \$\{EXCEPTION_RESOLVED_WINDOW_DAYS\} days`\}\s+active=\{status === 'resolved'\}\s+onPress=\{\(\) => setStatus\('resolved'\)\}/,
    );
  });

  it('Select, Check now and Try again are 44pt buttons', () => {
    const { sf, els } = elements(
      LIST,
      (el, s) => tagOf(el, s) === 'Button' && attrText(el, 'size', s) === 'sm',
    );
    expect(els).toHaveLength(3);
    for (const el of els) expect(attrText(el, 'style', sf)).toBe('TAP');
    expect(code).toContain('const TAP = { minHeight: MIN_TAP };');
  });

  // P2.5b: the card is the press target and VoiceOver's checkbox while
  // selecting (a button otherwise); it draws the shared mark alone.
  it('a select row draws CheckboxMark only while selecting, and keeps its role switch and words', () => {
    const { sf, els } = elements(
      LIST,
      (el, s) =>
        tagOf(el, s) === 'Pressable' &&
        (attrText(el, 'accessibilityRole', s) ?? '').includes('checkbox'),
    );
    expect(els).toHaveLength(1);
    const row = els[0]!;
    expect(attrText(row, 'accessibilityRole', sf)).toBe("selecting ? 'checkbox' : 'button'");
    expect(attrText(row, 'accessibilityState', sf)).toBe(
      'selecting ? { checked: picked } : undefined',
    );
    const rowCode = codeOnly(row.getText(sf));
    expect(rowCode).toMatch(
      /\{selecting \? \(\s*<View[^>]*>\s*<CheckboxMark checked=\{picked\} \/>\s*<Body size=\{13\} muted>\s*\{picked \? 'Selected for a recount' : 'Tap to select for a recount'\}/,
    );
    expect(code).not.toContain('checkBox');
    const icons = /import \{([^}]*)\} from 'lucide-react-native';/.exec(code)?.[1] ?? '';
    expect(icons.split(',').map((n) => n.trim())).not.toContain('Check');
  });

  it('a picked card takes the accent wash', () => {
    expect(code).toContain(
      'style={picked && selecting ? { backgroundColor: c.accentWash } : undefined}',
    );
  });

  it('Recount selected stays the select bar’s one ink button, off with the reason', () => {
    expect(code).toContain(
      '<Button block disabled={recountReason !== null} onPress={() => setRecountOpen(true)}>',
    );
    expect(code).toContain('{recountSelectedLabel(pickedCount)}');
  });
});

// ── One exception (M-SG-03) ──────────────────────────────────────────────

describe('exception screen: words and the rows of each card', () => {
  const code = codeOnly(sourceOf(DETAIL));

  it.each([
    'Back',
    'Critical',
    'Warning',
    'ITEM',
    'Not visible to you',
    'LOCATION',
    ' (archived)',
    'Opens the location',
    'FIRST SEEN',
    'Already present when tracking began, ',
    'LAST SEEN BY A CHECK',
    'ACKNOWLEDGED',
    'Former member',
    'RESOLVED',
    'Acknowledge',
    'Add note',
    'RECOUNT',
    'Recount',
    'MAINTENANCE',
    'Opens the maintenance request',
    'WHAT CAN CAUSE THIS',
    'WHAT CLEARS THIS',
    'TIMELINE',
    'No events yet.',
    'THIS CONDITION OVER TIME',
    ' (this one)',
    'Exception',
    'Only the most recent occurrences are shown.',
    'Try again',
    'This exception is not available to you, or it no longer exists.',
    'You are offline. This exception needs a connection to load. Reconnect and pull down to try again.',
    'The server answered for a different workspace. Go back and switch workspace from the menu.',
  ])('says "%s"', (word) => {
    expect(wordsOf(DETAIL)).toContain(word);
  });

  it('the facts, the timeline and the history are each one card of hairline rows', () => {
    expect(code.match(/<RuledRows>/g)).toHaveLength(3);
    const helper = functionBody(DETAIL, 'RuledRows');
    expect(helper).toContain('React.Children.toArray(children)');
    expect(helper).toContain('{i > 0 ? <Hair /> : null}');
    expect(code).toMatch(/<Card padding=\{14\}>\s*<RuledRows>\s*<Fact\s+label="ITEM"/);
    expect(code).toMatch(/<Card padding=\{14\}>\s*<RuledRows>\s*\{detail\.timeline\.map\(/);
    expect(code).toMatch(/<Card padding=\{14\}>\s*<RuledRows>\s*\{detail\.history\.map\(/);
  });

  // They were a line of words each (about 21pt and 38pt).
  it('the linked recount and each earlier occurrence are 44pt targets', () => {
    expect(code).toMatch(
      /onPress=\{\(\) => onNavigate\(`\/cycle-count\/\$\{o\.recount!\.cycleCountId\}`\)\}\s*style=\{\(\{ pressed \}\) => \(\{\s*minHeight: MIN_TAP,/,
    );
    expect(styleBlock(DETAIL, 'historyRow')).toMatch(/minHeight: MIN_TAP\b/);
  });

  it('a confirm that closed it is said on the accent wash', () => {
    expect(code).toMatch(
      /\{notice \? \(\s*<Card padding=\{12\} style=\{\{ backgroundColor: c\.accentWash \}\}>/,
    );
  });
});

// ── Photos (M-SG-03) ─────────────────────────────────────────────────────

describe('Photos: on the photo ground, each a card row', () => {
  const code = codeOnly(sourceOf(PHOTOS));

  it('a photo sits on white with a hairline edge; one that failed is a recessed tile', () => {
    expect(code).toContain(
      'style={[styles.thumb, { backgroundColor: PHOTO_BACKGROUND, borderColor: c.hair }]}',
    );
    expect(code).toContain(
      'style={[styles.thumb, { backgroundColor: c.sunk, borderColor: c.hair }]}',
    );
    expect(styleBlock(PHOTOS, 'thumb')).toContain('borderWidth: 1');
  });

  it('each photo, and each photo being added, is a card row', () => {
    expect(code).toContain('const rowSurface = { backgroundColor: c.card, borderColor: c.hair };');
    expect(
      code.match(/style=\{\[styles\.row, rowSurface, stack \? styles\.stacked : null\]\}/g),
    ).toHaveLength(2);
  });

  it('the upload bar is the reference progress bar; a failure is said in the refusal red', () => {
    expect(code).toContain('<View style={[styles.track, { backgroundColor: meterTrack(c) }]}>');
    expect(code).toContain("backgroundColor: meterColor('ok', c),");
    expect(code).toContain("color={entry.status === 'error' ? c.critText : c.ink}");
  });

  it.each([PHOTO_SHEETS])('%s: the previews sit on the photo ground', (file) => {
    expect(
      codeOnly(sourceOf(file)).match(
        /\{ backgroundColor: PHOTO_BACKGROUND, borderColor: c\.hair \}/g,
      ),
    ).toHaveLength(2);
  });
});

// ── Contrast, both modes ─────────────────────────────────────────────────

describe('the colours the exception screens draw, measured in both modes', () => {
  it.each(MODES)('%s: words at AA, marks at 3:1', (_mode, c) => {
    const words: [string, string, string][] = [
      ['a chosen tab', c.ink, c.card],
      ['an idle tab on its track', c.ink3, c.sunk],
      ['a reference, a time on a card', c.ink3, c.card],
      ['a picked card’s words', c.ink, c.accentWash],
      ['a picked card’s reference and muted words', c.ink3, c.accentWash],
      ['the confirm notice', c.ink, c.accentWash],
      ['a refusal or a failed photo', c.critText, c.card],
      ['the note count', c.ink3, c.card],
      ['a placeholder in the recessed box', c.ink3, c.sunk],
      ['typed words in the recessed box', c.ink, c.sunk],
      ['the severity pill: Critical', pillTone('crit', c).fg, pillTone('crit', c).bg],
      ['the severity pill: Warning', pillTone('warn', c).fg, pillTone('warn', c).bg],
    ];
    for (const [what, fg, bg] of words) {
      expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(AA_TEXT);
    }
    const marks: [string, string, string][] = [
      ['the chosen tab’s ring on the track', c.ink3, c.sunk],
      ['the chosen tab’s ring on its card fill', c.ink3, c.card],
      ['a ticked box on a picked card', c.ink, c.accentWash],
      ['a clear box on a card (the old hairline edge was 1.1 to 1.3:1)', c.ink4, c.card],
      ['the Close X on a sheet', c.ink3, c.card],
      ['the upload fill on its track', meterColor('ok', c), meterTrack(c)],
    ];
    for (const [what, fg, bg] of marks) {
      expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(AA_UI);
    }
  });
});

// Every touchable the restyle touched keeps a role (the sweep in
// verification-screens-wiring covers the location and the card; this covers
// the list's new tab).
describe('no touchable without a role on the list', () => {
  it('every Pressable on the list says what it is', () => {
    const { sf, els } = elements(LIST, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    for (const el of els) expect(attrText(el, 'accessibilityRole', sf)).toBeDefined();
  });
});
