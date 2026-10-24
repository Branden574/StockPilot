import * as path from 'node:path';
import * as vm from 'node:vm';

import { BOOK_REPORT_KPI_LOAD_ERROR } from '@stockpilot/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import { pillTone } from '../components/ui/tones';
import {
  TOUCHABLE_TAG,
  attr,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { syncBadgeState } from './sync-badge';
import { palette, type Palette } from './theme';

/**
 * THE PHONE WORKSPACE SCREENS, READ AS SOURCE (redesign package P5.10a, rows
 * M-WS-01 to M-WS-14): Home, the AI launcher and chat, Schedule and New
 * event, Notifications, Team, Accounts, Maintenance (list, request, new
 * request), Zendesk and its agent web view, and Support.
 *
 * They took the redesign's look: the per-mode palette (no mode-independent
 * accents, no hard-coded colours, no light-only washes), words in the muted
 * ink or stronger, chips and segments as buttons that say which is chosen,
 * 44pt targets as real frames. What had to survive is pinned here: every
 * word, spoken name, role and state, the gates, links and tour target, and
 * the failed-read states that replaced claims made from a failed read
 * (redesign defects D25, D26, D28).
 *
 * The mobile suite has no React Native renderer, so the screens are read
 * with the TypeScript parser (as scanner-structure.test.ts and
 * header-chip-a11y.test.ts read theirs), pure helpers a screen declares are
 * compiled from its own source and run, and every colour pair the screens
 * draw is measured in both modes.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const HOME = 'app/(drawer)/(tabs)/index.tsx';
const AI = 'app/(drawer)/ai.tsx';
const CHAT = 'app/ai/chat.tsx';
const SCHEDULE = 'app/(drawer)/schedule.tsx';
const NEW_EVENT = 'app/schedule/new.tsx';
const NOTIFICATIONS = 'app/(drawer)/notifications.tsx';
const TEAM = 'app/(drawer)/team.tsx';
const ACCOUNTS = 'app/(drawer)/customers.tsx';
const MAINTENANCE = 'app/(drawer)/maintenance.tsx';
const REQUEST = 'app/maintenance/[id].tsx';
const NEW_REQUEST = 'app/maintenance/new.tsx';
const ZENDESK = 'app/(drawer)/zendesk.tsx';
const ZENDESK_WEB = 'app/zendesk/web.tsx';
const SUPPORT = 'app/(drawer)/support.tsx';

const SCREENS = [
  HOME,
  AI,
  CHAT,
  SCHEDULE,
  NEW_EVENT,
  NOTIFICATIONS,
  TEAM,
  ACCOUNTS,
  MAINTENANCE,
  REQUEST,
  NEW_REQUEST,
  ZENDESK,
  ZENDESK_WEB,
  SUPPORT,
];

const LIGHT = palette('light');
const DARK = palette('dark');
const MODES: [string, Palette][] = [
  ['light', LIGHT],
  ['dark', DARK],
];

const sources = new Map<string, string>();
function sourceOf(file: string): string {
  let src = sources.get(file);
  if (src === undefined) {
    src = readSource(path.join(MOBILE_ROOT, file));
    sources.set(file, src);
  }
  return src;
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

/** Every JSX element of a file that matches, with its ancestors. */
function elements(file: string, match: (el: JsxNode, sf: ts.SourceFile) => boolean) {
  const sf = treeOf(file);
  const els: { el: JsxNode; ancestors: JsxNode[] }[] = [];
  walkJsx(sf, (el, ancestors) => {
    if (match(el, sf)) els.push({ el, ancestors: [...ancestors] });
  });
  return { sf, els };
}

/** The words an element shows: its JSX text, children joined. */
function textOf(el: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.getText(sf).replace(/\s+/g, ' ').trim());
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

/**
 * Top-level helper functions and constants of a screen, compiled from the
 * repository's own source (never from input) and run in an empty context,
 * for the pure helpers whose answers are the behaviour.
 */
function screenDeclarations(file: string, names: string[]): Record<string, unknown> {
  const sf = treeOf(file);
  const parts: string[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && names.includes(st.name.text)) {
      parts.push(st.getText(sf));
    } else if (
      ts.isVariableStatement(st) &&
      st.declarationList.declarations.some(
        (d) => ts.isIdentifier(d.name) && names.includes(d.name.text),
      )
    ) {
      parts.push(st.getText(sf));
    }
  }
  expect(parts, `${names.join(', ')} in ${file}`).toHaveLength(names.length);
  const js = ts.transpileModule(`${parts.join('\n')}\n({ ${names.join(', ')} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext({}) as Record<string, unknown>;
}

/** A StyleSheet entry's body, `name: { ... }`, as source text. */
function styleBlock(file: string, name: string): string {
  const m = new RegExp(`\\n\\s+${name}: \\{([^}]*)\\}`).exec(sourceOf(file));
  expect(m, `style ${name} in ${file}`).not.toBeNull();
  return m![1]!;
}

/** The text components whose `color` is the colour of words. */
const TEXT_TAGS = new Set(['Body', 'Mono', 'Display', 'Eyebrow', 'FieldLabel', 'Text', 'Em']);

// ─────────────────────────────────────────────────────────────────────────────

describe('the per-mode palette on every workspace screen', () => {
  // Mutation caught: a mode-independent accent (ACCENT.mint / warn / crit:
  // one value for both modes, under AA as words in one of them), the
  // light-only legacy `theme` alias, or the retired MintWash coming back.
  it.each(SCREENS)('%s: no ACCENT, no legacy theme alias, no MintWash', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toMatch(/import \{[^}]*\btheme\b[^}]*\} from '@\/lib\/theme'/);
    expect(code).not.toContain('MintWash');
  });

  // paper2 is the card colour itself in dark (P2.5), so a well drawn with it
  // on a card vanished there; a recessed fill is `sunk`.
  it.each(SCREENS)('%s: no paper2 fill', (file) => {
    expect(codeOnly(sourceOf(file))).not.toMatch(/\bc\.paper2\b/);
  });

  // Every colour comes from the palette (or the shared photo ground). The one
  // exception is the sheet scrim, the app's per-mode convention for every
  // sheet (sheet-a11y-structure.test.ts pins the same pair on the others).
  it.each(SCREENS)('%s: no hard-coded colour', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).not.toMatch(/['"`]#[0-9a-f]{3,8}['"`]/i);
    const rgba = code.match(/rgba?\([^)]*\)/g) ?? [];
    expect(rgba).toEqual(file === NOTIFICATIONS ? ['rgba(0,0,0,0.55)', 'rgba(14,15,13,0.35)'] : []);
  });

  // CONFLICTS X2: words in ink4 or ink5 read at 3.0-3.7:1, under AA. ink4 is
  // kept for glyphs (an arrow, the empty state's icon), never for words, a
  // placeholder or a spinner.
  it.each(SCREENS)('%s: words, placeholders and spinners are never ink4 or ink5', (file) => {
    const { sf, els } = elements(file, () => true);
    const offenders: string[] = [];
    for (const { el } of els) {
      const tag = tagOf(el, sf);
      const at = `${tag}:${sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1}`;
      for (const prop of ['placeholderTextColor']) {
        if (/ink[45]\b/.test(attrText(el, prop, sf) ?? '')) offenders.push(`${at} ${prop}`);
      }
      if (TEXT_TAGS.has(tag)) {
        for (const prop of ['color', 'style']) {
          if (/ink[45]\b/.test(attrText(el, prop, sf) ?? '')) offenders.push(`${at} ${prop}`);
        }
      }
      if (tag === 'ActivityIndicator' && /ink[45]\b/.test(attrText(el, 'color', sf) ?? '')) {
        offenders.push(`${at} color`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Every press target says what it is, and none widens itself with hitSlop
  // (the IconChip rule: the target VoiceOver outlines is the one a finger
  // can hit, so a 44pt target is a real frame).
  it.each(SCREENS)('%s: every touchable has a role and no hitSlop', (file) => {
    const { sf, els } = elements(file, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    const unnamed = els
      .filter(({ el }) => attrText(el, 'accessibilityRole', sf) === undefined)
      .map(({ el }) => sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1);
    expect(unnamed).toEqual([]);
    expect(els.filter(({ el }) => attrText(el, 'hitSlop', sf) !== undefined)).toEqual([]);
  });
});

describe('contrast: every pair the screens draw, both modes', () => {
  // [what, foreground token, background token]. Words at 4.5:1 (AA), marks
  // at 3:1 (non-text contrast).
  const WORDS: [string, keyof Palette, keyof Palette][] = [
    ['meta, eyebrows and placeholders on the page', 'ink3', 'paper'],
    ['meta and labels on a card', 'ink3', 'card'],
    ['an idle segment on its recessed track', 'ink3', 'sunk'],
    ['an unread notification body and age on its wash', 'ink3', 'accentWash'],
    ['an unread notification title on its wash', 'ink', 'accentWash'],
    ['an idle chip on the page', 'ink2', 'paper'],
    ['an idle chip on a card (Support)', 'ink2', 'card'],
    ['a chosen chip or segment, Open scanner, Send (paper on ink)', 'paper', 'ink'],
    ['See all on the page', 'accent', 'paper'],
    ['New and Start chat on the accent fill', 'accentInk', 'accent'],
    ['failure words on the page (sync not sent)', 'critText', 'paper'],
    ['failure words on a card', 'critText', 'card'],
    ['pending sync words on the page', 'warnText', 'paper'],
    ['a recent movement in (+N) on its card', 'accent', 'card'],
    ['a recent movement out (-N) on its card', 'critText', 'card'],
    ['Open in Outlook and Add note as the outline (ink on the card)', 'ink', 'card'],
  ];
  const MARKS: [string, keyof Palette, keyof Palette][] = [
    ['the accent pip on the recessed barcode well', 'accent', 'sunk'],
    ['the unread card edge against the page', 'accent', 'paper'],
    ['a movement pip (zero change) on its card', 'warnText', 'card'],
    ['the close and remove X on a card', 'ink3', 'card'],
    ['the Send circle on the composer', 'ink', 'card'],
    ['the sending spinner on the recessed circle', 'ink', 'sunk'],
    ['a chosen chip or segment against the page or track', 'ink', 'sunk'],
    ['the Mail glyph on the outline Open in Outlook', 'ink', 'card'],
  ];
  it.each(MODES)('%s: words at AA', (_mode, c) => {
    for (const [what, fg, bg] of WORDS) {
      expect(contrast(c[fg], c[bg]), what).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
  it.each(MODES)('%s: marks at 3:1', (_mode, c) => {
    for (const [what, fg, bg] of MARKS) {
      expect(contrast(c[fg], c[bg]), what).toBeGreaterThanOrEqual(AA_UI);
    }
  });
  it.each(MODES)('%s: the pills the screens show (OPEN, NEW, TODAY, TOMORROW)', (_mode, c) => {
    for (const status of ['ok', 'warn', 'default'] as const) {
      const tone = pillTone(status, c);
      expect(contrast(tone.fg, tone.bg), status).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

// ── Home (M-WS-01) ──────────────────────────────────────────────────────────

describe('Home: real figures, real sync words, no fake sparklines (D26)', () => {
  const home = sourceOf(HOME);
  const code = codeOnly(home);
  type Read = { count?: number | null; data?: unknown; error: unknown };
  const { homeSummary, FIGURES_LOAD_ERROR, RECENT_LOAD_ERROR } = screenDeclarations(HOME, [
    'homeSummary',
    'FIGURES_LOAD_ERROR',
    'RECENT_LOAD_ERROR',
  ]) as {
    homeSummary: (...reads: Read[]) => unknown;
    FIGURES_LOAD_ERROR: string;
    RECENT_LOAD_ERROR: string;
  };
  const ok = (count: number): Read => ({ count, error: null });
  const rpc = (data: unknown): Read => ({ data, error: null });

  // Mutation caught: a failed read counted as 0 (the defect), the low figure
  // not subtracting the awaiting-first-receipt slice, or a value read that
  // was not a number shown as one.
  it('the four figures come from the five reads, or not at all', () => {
    expect(homeSummary(ok(12), ok(3), rpc(4567.8), rpc(9), ok(2))).toEqual({
      itemCount: 12,
      outOfStockCount: 3,
      inventoryValue: 4567.8,
      lowStockCount: 7,
    });
    expect(homeSummary(ok(1), ok(0), rpc('n/a'), rpc(1), ok(5))).toEqual({
      itemCount: 1,
      outOfStockCount: 0,
      inventoryValue: 0,
      lowStockCount: 0,
    });
    for (let failed = 0; failed < 5; failed++) {
      const reads = [ok(12), ok(3), rpc(4567.8), rpc(9), ok(2)];
      reads[failed] = { ...reads[failed]!, error: { message: 'offline' } };
      expect(homeSummary(...reads), `read ${failed} failed`).toBeNull();
    }
  });

  it("the failure is said in the Reports screen's words for the same figures", () => {
    expect(FIGURES_LOAD_ERROR).toBe(BOOK_REPORT_KPI_LOAD_ERROR);
    expect(RECENT_LOAD_ERROR).toBe("Couldn't load recent movements. Pull to refresh.");
    expect(code).toContain('setSummary(homeSummary(items, out, valueRpc, lowRpc, flaggedLow));');
    expect(code).toContain('setRecentFailed(Boolean(movements.error));');
  });

  // Mutation caught: the tiles drawn from a null summary (zeros again), or
  // the failure shown without the alert role.
  it('the tiles render only from read figures; otherwise the failure, as an alert', () => {
    expect(code).toMatch(/\{figures \? \(\s*<View style=\{styles\.statGrid\}>/);
    expect(code).toMatch(
      /<Body size=\{14\.5\} accessibilityRole="alert">\s*\{FIGURES_LOAD_ERROR\}\s*<\/Body>/,
    );
    expect(code).toMatch(
      /\{recentUnavailable \? \([\s\S]{0,200}?\{RECENT_LOAD_ERROR\}[\s\S]{0,200}?\) : recent\.length === 0 \?/,
    );
    expect(code).not.toMatch(/summary\?\.\w+ \?\? 0/);
  });

  it('no sparkline: no tile carries a spark or a spark kind', () => {
    const { sf, els } = elements(HOME, (el, s) => tagOf(el, s) === 'StatCard');
    expect(els.map(({ el }) => attrText(el, 'label', sf))).toEqual([
      'ITEMS',
      'VALUE',
      'LOW',
      'OUT',
    ]);
    for (const { el } of els) {
      expect(attrText(el, 'spark', sf)).toBeUndefined();
      expect(attrText(el, 'sparkKind', sf)).toBeUndefined();
    }
  });

  // Mutation caught: "synced now" written back in, or words that do not come
  // from the sync engine.
  it('the workspace line carries the sync engine’s own words', () => {
    expect(code).toContain('const sync = syncBadgeState(useSyncStatus());');
    expect(code).toMatch(/\{orgName\} ·\{' '\}\s*<Mono[^>]*color=\{syncColor\}>\s*\{sync\.label\}/);
    expect(wordsOf(HOME).join(' ')).not.toMatch(/synced now/);
    // A problem is said in its tone, everything else in the muted ink.
    expect(code).toContain(
      "sync.tone === 'destructive' ? c.critText : sync.tone === 'warning' ? c.warnText : c.ink3;",
    );
    // The words exist for every state the badge has.
    const states = [
      syncBadgeState({ status: 'idle', pendingCount: 0, rejectedCount: 0, unconfirmedCount: 0 }),
      syncBadgeState({ status: 'offline', pendingCount: 2, rejectedCount: 0, unconfirmedCount: 0 }),
      syncBadgeState({ status: 'idle', pendingCount: 0, rejectedCount: 1, unconfirmedCount: 0 }),
    ];
    expect(states.map((s) => s.label)).toEqual(['All synced', 'Offline · 2 queued', '1 not sent']);
  });

  // Mutation caught: the spinner turning forever without a workspace, a load
  // that throws leaving it on, or Refresh not asking for the workspace again.
  it('without a workspace the spinner stops, and Refresh asks for the workspace again', () => {
    expect(code).toContain('const noWorkspace = !activeOrgId && !workspaceLoading;');
    expect(code).toContain('{loading && !noWorkspace ? (');
    expect(code).toContain('const figures = noWorkspace ? null : summary;');
    expect(code).toContain('const recentUnavailable = noWorkspace || recentFailed;');
    expect(code).toMatch(
      /async function onRefresh\(\) \{\s*setNow\(new Date\(\)\);\s*setRefreshing\(true\);\s*try \{\s*if \(activeOrgId\) await Promise\.all\(\[load\(\), refreshUnread\(\)\]\);\s*else await retryWorkspace\(\);\s*\} finally \{\s*setRefreshing\(false\);/,
    );
    expect(code).toMatch(
      /\} catch \{\s*setSummary\(null\);\s*setRecentFailed\(true\);\s*\} finally \{\s*setLoading\(false\);/,
    );
  });

  it('keeps the tour target, every link and the header controls', () => {
    expect(code).toContain("const scanTargetRef = useTourTarget('home-scan');");
    expect(code).toMatch(
      /<View ref=\{scanTargetRef\} collapsable=\{false\}[^>]*>\s*<Pressable\s+onPress=\{\(\) => router\.push\('\/scan'\)\}/,
    );
    for (const href of [
      "'/settings'",
      "'/notifications'",
      "'/scan'",
      "'/movements'",
      "'/bundles'",
    ]) {
      expect(code).toContain(`router.push(${href})`);
    }
    expect(code).toContain("router.push({ pathname: '/item/[id]', params: { id: m.itemId } })");
    expect(code).toContain('<MobileTour tour={MOBILE_HOME_TOUR} />');
  });

  it('every word Home shows is still there', () => {
    const words = wordsOf(HOME).join('\n');
    for (const w of [
      'Open menu',
      'Account settings',
      'Notifications',
      'Refresh',
      'ITEMS',
      'VALUE',
      'LOW',
      'OUT',
      'SKUs',
      'QUICK ADJUST',
      'Scan to',
      'adjust stock.',
      'Point at a barcode, QR, or rack tag. Stock moves before you put the phone down.',
      'Open scanner →',
      'RECENT MOVEMENTS',
      'See all',
      'No stock movements yet. Scan, count, or receive items to fill this feed.',
      'BUNDLES',
      'Bundles',
      'OPEN',
      'Unknown item',
    ]) {
      expect(words, w).toContain(w);
    }
  });

  // See all was an 11pt word with hitSlop; it is a link-sized frame now.
  it('See all is a named 44pt button in the accent link colour', () => {
    const block = styleBlock(HOME, 'seeAll');
    expect(block).toMatch(/minHeight: 44\b/);
    expect(block).toMatch(/minWidth: 44\b/);
    // Padding, not a fixed box the words are centred in: larger words grow
    // the frame and the heading row with it (-15 + 15), where centred ones
    // spilled out of the row into the card below at AX4 and AX5.
    expect(block).toMatch(/paddingVertical: 15,\s*marginVertical: -15,/);
    expect(code).toMatch(
      /accessibilityLabel="See all movements"\s+style=\{\(\{ pressed \}\) => \[styles\.seeAll[\s\S]{0,120}color=\{c\.accent\}>\s*See all/,
    );
  });

  it('the scan card: a recessed well with the accent pip and the ink button look', () => {
    expect(code).toContain('styles.barWell, { backgroundColor: c.sunk, borderColor: c.hair }');
    expect(code).toContain('styles.accentPip, { backgroundColor: c.accent }');
    expect(code).toContain('styles.openScanCta, { backgroundColor: c.ink }');
    expect(styleBlock(HOME, 'openScanCta')).toMatch(/minHeight: 48,[\s\S]*borderRadius: 14/);
    expect(code).toContain('const OPEN_SCANNER_CAP = capTo(15.5, TYPE_CEILING.control);');
  });

  // Beside the 56pt well on a 320pt-wide screen (Display Zoom) the label has
  // 132pt: one line read "Open scann…" from xxL (138pt there, 159pt at the
  // 22pt ceiling). It wrapped before the restyle; it wraps again, to two
  // centred lines, and the button grows (minHeight).
  it('Open scanner → wraps to two centred lines instead of being cut', () => {
    const { sf, els } = elements(
      HOME,
      (el, s) => tagOf(el, s) === 'Text' && textOf(el, s) === 'Open scanner →',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!.el, 'numberOfLines', sf)).toBe('2');
    expect(attrText(els[0]!.el, 'maxFontSizeMultiplier', sf)).toBe('OPEN_SCANNER_CAP');
    expect(styleBlock(HOME, 'openScanLabel')).toMatch(/textAlign: 'center',/);
    expect(styleBlock(HOME, 'openScanCta')).not.toMatch(/\bheight:/);
  });
});

// ── AI launcher and chat (M-WS-02, 03) ──────────────────────────────────────

describe('AI launcher: the footer says what is true (D28)', () => {
  const code = codeOnly(sourceOf(AI));
  const { AI_FOOTER } = screenDeclarations(AI, ['AI_FOOTER']) as { AI_FOOTER: string };

  it('no longer says the native chat ships later', () => {
    expect(AI_FOOTER).toBe('Native mobile chat is in beta.');
    expect(wordsOf(AI).join(' ')).not.toMatch(/ships after|desktop beta exits/);
    expect(code).toContain('{AI_FOOTER}');
  });

  it('Start chat is the accent button and opens the native chat; every prompt opens it too', () => {
    const { sf, els } = elements(AI, (el, s) => tagOf(el, s) === 'Button');
    expect(els.map(({ el }) => textOf(el, sf))).toEqual(['Start chat']);
    const [start] = els;
    expect(attrText(start!.el, 'variant', sf)).toBe('accent');
    expect(attrText(start!.el, 'onPress', sf)).toBe('openChat');
    expect(attrText(start!.el, 'trailing', sf)).toContain('color={c.accentInk}');
    expect(code).toMatch(/function openChat\(\) \{\s*router\.push\('\/ai\/chat'\);/);
    const prompts = elements(AI, (el, s) => tagOf(el, s) === 'Pressable');
    expect(prompts.els.map(({ el }) => attrText(el, 'onPress', prompts.sf))).toEqual([
      '() => openChat()',
    ]);
  });

  it('keeps every word and the Back that honours ?return=', () => {
    const words = wordsOf(AI);
    for (const w of [
      // The drawer section the screen sits in: WORKSPACE until the owner's
      // regroup of 2026-10-19 moved AI Assistant to INSIGHTS.
      'INSIGHTS · BETA',
      'AI',
      'assistant.',
      'BETA · NATIVE',
      'TRY ASKING',
      "What's low at L4L North Region right now?",
      'Draft a PO for the books category from Ingram.',
      'How many Chromebooks did we receive this month?',
      'Which suppliers have the longest lead times?',
    ]) {
      expect(words, w).toContain(w);
    }
    expect(code).toMatch(
      /if \(typeof returnPath === 'string' && returnPath\.length > 0\) \{\s*router\.replace\(returnPath as never\);/,
    );
  });
});

describe('AI chat: Send has a name, both buttons are 44pt frames', () => {
  const code = codeOnly(sourceOf(CHAT));

  // Send was an unnamed icon with no role: VoiceOver could not find it.
  it('Send is a button named Send, dimmed and busy as it should be', () => {
    const { sf, els } = elements(
      CHAT,
      (el, s) => attrText(el, 'onPress', s) === '() => void send()',
    );
    expect(els).toHaveLength(1);
    const send = els[0]!.el;
    expect(attrText(send, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(send, 'accessibilityLabel', sf)).toBe('Send');
    expect(attrText(send, 'accessibilityState', sf)).toBe(
      '{ disabled: !input.trim() || busy, busy }',
    );
    expect(attrText(send, 'disabled', sf)).toBe('!input.trim() || busy');
    expect(attrText(send, 'style', sf)).toContain('styles.tapFrame');
  });

  it('Attach keeps its name and gains its state; both frames are 44 x 44', () => {
    const { sf, els } = elements(CHAT, (el, s) => attrText(el, 'onPress', s) === 'attachPhoto');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!.el, 'accessibilityLabel', sf)).toBe('Attach a book-list photo');
    expect(attrText(els[0]!.el, 'accessibilityState', sf)).toBe(
      '{ disabled: uploading || busy, busy: uploading }',
    );
    expect(styleBlock(CHAT, 'tapFrame')).toMatch(/width: 44,\s*height: 44,/);
    // The frames are 4pt bigger than the 36pt circles: the box gives the 4pt
    // back so nothing moves.
    expect(styleBlock(CHAT, 'inputBox')).toMatch(
      /gap: 4,[\s\S]*paddingLeft: 2,\s*paddingRight: 2,\s*paddingVertical: 2,/,
    );
    expect(styleBlock(CHAT, 'input')).toMatch(/marginVertical: 4,/);
  });

  // While it sends, the circle is the recessed one and the box is empty:
  // the spinner was paper on paper2, invisible in both modes.
  it('the sending spinner shows on the recessed circle', () => {
    expect(code).toContain('backgroundColor: input.trim() && !busy ? c.ink : c.sunk');
    expect(code).toContain('<ActivityIndicator size="small" color={c.ink} />');
  });

  it('keeps the words, the placeholder in the muted ink, the stream and the keyboard wrapper', () => {
    const words = wordsOf(CHAT);
    for (const w of [
      'AI · BETA',
      'Ask anything about your',
      'inventory.',
      'Natural-language queries with real reads + drafts.',
      "What's low at our biggest warehouse?",
      'Show me POs that are overdue.',
      'How many Chromebooks did we receive this month?',
      'Message StockPilot…',
      'thinking…',
      'Chat error',
      'Attach a book list',
      'No ISBNs found',
      'Upload failed',
    ]) {
      expect(words, w).toContain(w);
    }
    expect(code).toContain('placeholderTextColor={c.ink3}');
    expect(code).toContain('`${API_BASE}/api/ai/chat`');
    expect(code).toMatch(
      /behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}\s*keyboardVerticalOffset=\{Platform\.OS === 'ios' \? 0 : 24\}/,
    );
  });
});

// ── The drawer lists: a failed read is said (D25) ───────────────────────────

describe('drawer lists: a failed read is said in the list’s own words, never as empty', () => {
  const LISTS: [string, string, string, { title: string; body: string; reloadNote?: string }][] = [
    [
      SCHEDULE,
      'SCHEDULE_LOAD_FAILED',
      'No upcoming events.',
      {
        title: 'Could not load the schedule.',
        body: 'Check your connection and pull down to try again.',
        reloadNote:
          'Could not load the schedule again, so these events may be out of date. Pull down to try again.',
      },
    ],
    [
      NOTIFICATIONS,
      'NOTIFICATIONS_LOAD_FAILED',
      'All caught up.',
      {
        title: 'Could not load notifications.',
        body: 'Check your connection and pull down to try again.',
        reloadNote:
          'Could not load notifications again, so these may be out of date. Pull down to try again.',
      },
    ],
    [
      ACCOUNTS,
      'ACCOUNTS_LOAD_FAILED',
      'No accounts yet.',
      {
        title: 'Could not load accounts.',
        body: 'Check your connection and pull down to try again.',
        reloadNote:
          'Could not load accounts again, so these may be out of date. Pull down to try again.',
      },
    ],
  ];

  it.each(LISTS)('%s: its failure words, through the failed state', (file, name, empty, words) => {
    const decl = screenDeclarations(file, [name]);
    expect(decl[name]).toEqual(words);
    const code = codeOnly(sourceOf(file));
    expect(code).toContain(`failed={loadFailed ? ${name} : null}`);
    expect(code).toContain(`emptyTitle="${empty}"`);
  });

  // Mutation caught: a failed read clearing the rows (the empty list again)
  // or never setting the flag.
  it.each(LISTS)('%s: the read keeps earlier rows when it fails', (file) => {
    const code = codeOnly(sourceOf(file));
    const load = code.slice(code.indexOf('const load = React.useCallback('));
    const failBranch = /if \(error\) \{([\s\S]*?)\}/.exec(load);
    expect(failBranch, 'error branch').not.toBeNull();
    expect(failBranch![1]).toContain('setLoadFailed(true);');
    expect(failBranch![1]).not.toContain('setRows(');
    expect(load).toContain('setLoadFailed(false);');
    expect(load).toMatch(/const \{ data, error \} = await supabase/);
  });

  it('a failed read with nothing on screen quotes no count', () => {
    expect(codeOnly(sourceOf(NOTIFICATIONS))).toMatch(
      /loadFailed && rows\.length === 0\s*\? 'INBOX'/,
    );
    expect(codeOnly(sourceOf(ACCOUNTS))).toMatch(/loadFailed && rows\.length === 0\s*\? 'B2B'/);
  });

  it('Team: the failure goes through the failed state too, with its own words', () => {
    const code = codeOnly(sourceOf(TEAM));
    expect(code).toMatch(
      /failed=\{\s*loadFailed\s*\?\s*\{\s*title: 'Could not load the team\.',\s*body: 'Check your connection and pull down to try again\.',\s*\}\s*: null\s*\}/,
    );
    expect(code).toContain('emptyTitle="No team yet."');
    expect(code).toContain(
      'emptyBody="Invite teammates on the web. Pending invites and active members show here."',
    );
  });
});

describe('Schedule (M-WS-04)', () => {
  const code = codeOnly(sourceOf(SCHEDULE));
  it('New event stays behind schedule:manage; an event opens the web schedule, as a link', () => {
    expect(code).toContain("const canManageSchedule = showWriteCta(perms, 'schedule:manage');");
    expect(code).toMatch(
      /canManageSchedule \? \([\s\S]{0,300}?router\.push\('\/schedule\/new'\)[\s\S]{0,80}?accessibilityLabel="New event"/,
    );
    expect(code).toContain('Linking.openURL(`https://stockpilotusa.com/dashboard/schedule`)');
    const { sf, els } = elements(SCHEDULE, (el, s) => attrText(el, 'onPress', s) === 'openOnWeb');
    expect(els.map(({ el }) => attrText(el, 'accessibilityRole', sf))).toEqual(['link']);
  });

  // The date column grows with the text size (minWidth, not width), and at
  // the default size every card's divider lines up: the floor holds the
  // widest time, "10:30 AM" (8 mono characters at 10pt, 0.6em plus 0.4pt
  // tracking each = 51.2pt) with the 12pt padding and the 1pt divider.
  it('the date column: one divider line down the list at the default size', () => {
    const widest = 8 * (10 * 0.6 + 10 * 0.04) + 12 + 1;
    const floor = Number(
      /minWidth: (\d+),\s*alignItems: 'center',\s*borderRightWidth: 1,/.exec(code)?.[1],
    );
    expect(floor).toBeGreaterThanOrEqual(widest);
    expect(floor - widest).toBeLessThan(1);
    expect(code).not.toMatch(/\bwidth: 56\b/);
  });
  it('keeps every word', () => {
    const words = wordsOf(SCHEDULE);
    for (const w of [
      'SCHEDULE · NEXT 30 DAYS',
      'Team',
      'calendar.',
      'No upcoming events.',
      'Schedule deliveries, pickups, and team work on the web — it shows here so you can check on the floor.',
      'TODAY',
      'TOMORROW',
      'all day',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe('New event (M-WS-05): the shared boxes, chips and checkbox', () => {
  const code = codeOnly(sourceOf(NEW_EVENT));

  // The All-day box was hand drawn (a check glyph in a 20pt square) with no
  // role or state.
  it('All-day event is the shared checkbox, toggling the same state', () => {
    const { sf, els } = elements(NEW_EVENT, (el, s) => tagOf(el, s) === 'Checkbox');
    expect(els).toHaveLength(1);
    const box = els[0]!.el;
    expect(attrText(box, 'label', sf)).toBe('All-day event');
    expect(attrText(box, 'checked', sf)).toBe('allDay');
    expect(attrText(box, 'onChange', sf)).toBe('() => setAllDay((v) => !v)');
    expect(wordsOf(NEW_EVENT).join(' ')).not.toContain('✓');
  });

  // What is typed is content: 0 lifts the shared box's 24pt input ceiling,
  // as P3.8 did for the Add book and Add item cards.
  it('every box is the shared Field, named for VoiceOver, typed text uncapped', () => {
    const { sf, els } = elements(NEW_EVENT, (el, s) => tagOf(el, s) === 'Field');
    expect(
      els.map(({ el }) => [attrText(el, 'label', sf), attrText(el, 'accessibilityLabel', sf)]),
    ).toEqual([
      ['TITLE', 'Title'],
      ['DAYS FROM TODAY', 'Days from today'],
      ['TIME (HH:MM)', 'Time'],
      ['DURATION (HOURS)', 'Duration in hours'],
      ['LOCATION TEXT', 'Location text'],
      ['NAME', 'Requester name'],
    ]);
    for (const { el } of els) expect(attrText(el, 'maxFontSizeMultiplier', sf)).toBe('0');
    expect(code).toContain("import { Field } from '@/components/ui/field';");
    expect(code).not.toMatch(/<TextInput\b/);
  });

  // The warehouse read spun forever when it failed or found none.
  it('warehouses: loading, then the chips (None first), or the failure with None still offered', () => {
    expect(code).toMatch(/if \(error\) \{\s*setWarehousesRead\('failed'\);\s*return;\s*\}/);
    expect(code).toContain("setWarehousesRead('ready');");
    expect(code).toContain("{warehousesRead === 'loading' ? (");
    expect(code).toMatch(
      /warehousesRead === 'failed' \? \(\s*<Body size=\{13\} color=\{c\.critText\} accessibilityRole="alert">\s*Could not load warehouses\./,
    );
    const { sf, els } = elements(NEW_EVENT, (el, s) => tagOf(el, s) === 'Chip');
    expect(els.map(({ el }) => attrText(el, 'label', sf))).toEqual(['None', 'w.name']);
    expect(code).toContain("import { Chip } from '@/components/ui/chip';");
  });

  it('days and time stack past the stacking scale; the insert and its words are unchanged', () => {
    expect(code).toContain('const stacked = shouldStackRow(fontScale);');
    expect(code).toContain("flexDirection: stacked ? 'column' : 'row'");
    expect(code).toContain("await supabase.from('schedule_events').insert({");
    const words = wordsOf(NEW_EVENT);
    for (const w of [
      'SCHEDULE · NEW EVENT',
      'Add to',
      'calendar.',
      'EVENT',
      'WHEN',
      'WHERE',
      'WAREHOUSE (OPTIONAL)',
      'REQUESTER (OPTIONAL)',
      'Delivery to L4L Fresno',
      'DC4 dock 2, customer HQ, etc.',
      'Who asked for this?',
      'MVP · simple form',
      'Saving…',
      'Add to calendar',
      'Cancel',
      'Could not schedule',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe('Notifications (M-WS-06)', () => {
  const code = codeOnly(sourceOf(NOTIFICATIONS));

  it('a tap marks read and routes through the shared rewriter; web-only links open the sheet', () => {
    const open = functionBody(NOTIFICATIONS, 'open');
    // 2026-10-24 (Phase 3 push tap, rebased onto this redesign): the tap
    // still marks the row read, with one timestamp for the server and the
    // screen, but no longer waits for the answer before opening (brief §13;
    // the fire-and-forget form is pinned in notification-intent-wiring.test.ts
    // section 8). Was: .update({ read_at: new Date().toISOString() }).
    expect(open).toContain('const readAt = new Date().toISOString();');
    expect(open).toMatch(/\.update\(\{ read_at: readAt \}\)/);
    expect(open).toContain('const native = notif.link ? rewriteWebPath(notif.link) : null;');
    expect(open).toMatch(
      /if \(native && native !== '\/' && native !== '\/notifications'\) \{\s*router\.push\(native as never\);\s*\} else \{\s*setDetail\(notif\);/,
    );
    expect(code).toContain("'postgres_changes'");
    expect(code).toContain('await ensureRealtimeAuth();');
    expect(code).toContain('accessibilityLabel="Mark all as read"');
  });

  it('unread is the accent wash with an accent edge, per mode', () => {
    expect(code).toContain(
      'style={unread ? { backgroundColor: c.accentWash, borderColor: c.accent } : undefined}',
    );
    expect(code).toContain("backgroundColor: unread ? c.accent : 'transparent',");
  });

  // The app's sheet rule (sheet-a11y-structure.test.ts): VoiceOver stays in
  // the sheet; the scrim is a Close button that closes on a double tap.
  it('the detail sheet: modal to VoiceOver, a Close scrim, a named 44pt X', () => {
    const fnStart = sourceOf(NOTIFICATIONS).indexOf('function NotifDetailSheet(');
    const { sf, els } = elements(NOTIFICATIONS, (el) => el.getStart() > fnStart);
    const container = els.find(({ el }) => attrText(el, 'accessibilityViewIsModal', sf) === 'true');
    expect(container, 'modal container').toBeDefined();
    expect(attrText(container!.el, 'onAccessibilityEscape', sf)).toBe('onClose');
    const closes = els.filter(
      ({ el }) => tagOf(el, sf) === 'Pressable' && attrText(el, 'onPress', sf) === 'onClose',
    );
    expect(closes).toHaveLength(2);
    const [scrim, x] = closes;
    expect(attrText(scrim!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim!.el, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrText(scrim!.el, 'onAccessibilityTap', sf)).toBe('onClose');
    expect(attrText(scrim!.el, 'style', sf)).toContain(
      "mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'",
    );
    expect(attrText(x!.el, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrText(x!.el, 'style', sf)).toBe('styles.closeFrame');
    const frame = styleBlock(NOTIFICATIONS, 'closeFrame');
    expect(frame).toMatch(/minWidth: 44,\s*minHeight: 44,\s*margin: -13,/);
  });

  it('keeps every word', () => {
    const words = wordsOf(NOTIFICATIONS);
    for (const w of [
      'Notifications',
      'All caught up.',
      'When stock hits reorder, a PO is overdue, or an order needs your approval, it shows up here.',
      'NEW',
      'INBOX',
    ]) {
      expect(words, w).toContain(w);
    }
    expect(code).toContain('`INBOX · ${rows.filter((r) => !r.read_at).length} UNREAD`');
  });
});

describe('Team and Accounts (M-WS-07, 08)', () => {
  it('Team: the member email is a 44pt link that still opens Mail', () => {
    const { sf, els } = elements(TEAM, (el, s) => tagOf(el, s) === 'Pressable');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!.el, 'accessibilityRole', sf)).toBe('link');
    expect(attrText(els[0]!.el, 'onPress', sf)).toBe(
      '() => Linking.openURL(`mailto:${email}`).catch(() => undefined)',
    );
    // Padding, not a fixed box the email is centred in: a wrapped or larger
    // address grows the frame and stays 3pt under the name (-11.5 + 14.5)
    // with the card's padding kept (14.5 - 14.5), where a centred email
    // climbed into the name and sank into the card's padding.
    expect(attrText(els[0]!.el, 'style', sf)).toMatch(
      /minHeight: 44,\s*paddingVertical: 14\.5,\s*marginTop: -11\.5,\s*marginBottom: -14\.5,/,
    );
  });

  // P2.5 hand-off: no visible label sits with the switch, so VoiceOver said
  // "switch, on" with no name.
  it('Accounts: each switch is named for its row; the busy gate and the unconfirmed write stay', () => {
    const { sf, els } = elements(ACCOUNTS, (el, s) => tagOf(el, s) === 'Toggle');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!.el, 'accessibilityLabel', sf)).toBe('row.name');
    expect(attrText(els[0]!.el, 'onValueChange', sf)).toBe('busy ? undefined : onToggle');
    const setStatus = functionBody(ACCOUNTS, 'setStatus');
    expect(setStatus).not.toContain("Alert.alert('Archive");
    expect(setStatus).toMatch(/\.select\('id'\)\s*\.maybeSingle\(\);/);
    expect(setStatus).toContain("'You need manager access to change accounts.'");
  });
});

// ── Maintenance (M-WS-09, 10, 11) ───────────────────────────────────────────

describe('Maintenance list: the scope switch and status chips are buttons with a state', () => {
  const code = codeOnly(sourceOf(MAINTENANCE));

  it('My / All requests: segments that say which is chosen, the chosen one in ink', () => {
    const { sf, els } = elements(MAINTENANCE, (el, s) => tagOf(el, s) === 'ScopeSegment');
    expect(els.map(({ el }) => attrText(el, 'label', sf))).toEqual(['My requests', 'All requests']);
    const seg = functionBody(MAINTENANCE, 'ScopeSegment');
    expect(seg).toContain('accessibilityRole="button"');
    expect(seg).toContain('accessibilityState={{ selected }}');
    expect(seg).toContain('{ backgroundColor: c.ink, borderColor: c.ink }');
    expect(seg).toContain('color: selected ? c.paper : c.ink3');
    expect(styleBlock(MAINTENANCE, 'segment')).toMatch(/minHeight: 38,/);
    expect(styleBlock(MAINTENANCE, 'segmentTrack')).toMatch(/padding: 3,[\s\S]*borderWidth: 1,/);
    // The All scope stays behind read_all / manage.
    expect(code).toMatch(/\{canReadAll \? \(\s*<ScopeSegment\s+label="All requests"/);
  });

  it('status chips: each a 44pt button with its own label and state', () => {
    const chip = functionBody(MAINTENANCE, 'StatusChip');
    expect(chip).toContain('accessibilityRole="button"');
    expect(chip).toContain('accessibilityState={{ selected }}');
    expect(chip).toContain('styles.chipFrame');
    expect(styleBlock(MAINTENANCE, 'chipFrame')).toMatch(/minHeight: 44,\s*minWidth: 44,/);
    expect(code).toMatch(
      /<StatusChip\s+key=\{chip\.label\}\s+label=\{chip\.label\}\s+selected=\{statusLabel === chip\.label\}\s+onPress=\{\(\) => setStatusLabel\(chip\.label\)\}/,
    );
  });

  it('New is the accent button in a 44pt frame, still named New maintenance request', () => {
    expect(code).toMatch(
      /accessibilityLabel="New maintenance request"\s+style=\{\(\{ pressed \}\) => \[styles\.newFrame[\s\S]{0,80}styles\.newBtn, \{ backgroundColor: c\.accent \}/,
    );
    expect(code).toContain('<Plus size={14} color={c.accentInk} strokeWidth={1.8} />');
    expect(styleBlock(MAINTENANCE, 'newFrame')).toMatch(/minHeight: 44,\s*minWidth: 44,/);
    expect(code).toContain('{enabled && canSubmit ? (');
  });

  it('keeps every word', () => {
    const words = wordsOf(MAINTENANCE);
    for (const w of [
      'New',
      'My requests',
      'All requests',
      'SEARCH',
      'Search request #, subject, description, requester…',
      'No maintenance requests',
      'Report a facilities or equipment issue and StockPilot will prepare the email for you.',
      'Nothing to show yet.',
      'Try again',
      'Maintenance',
      'requests.',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe('Maintenance request (M-WS-10)', () => {
  const code = codeOnly(sourceOf(REQUEST));

  it('errors in the refusal tone, photos on the white photo ground with a hairline', () => {
    for (const err of ['photosRefreshError', 'resolveError', 'membersError', 'notesError']) {
      expect(code).toMatch(
        new RegExp(
          `<Body size=\\{1[23](?:\\.5)?\\} color=\\{c\\.critText\\}[^>]*>\\s*\\{${err}\\}`,
        ),
      );
    }
    expect(styleBlock(REQUEST, 'photoThumb')).toMatch(
      /borderWidth: 1,\s*backgroundColor: PHOTO_BACKGROUND,/,
    );
    expect(styleBlock(REQUEST, 'resolvePhotoThumb')).toMatch(
      /borderWidth: 1,\s*backgroundColor: PHOTO_BACKGROUND,/,
    );
    expect(code).toContain('leading={<Trash2 size={16} color={c.critText} strokeWidth={1.5} />}');
  });

  it('the owner picker rows are 44pt buttons that say which is the owner', () => {
    expect(styleBlock(REQUEST, 'pickerRow')).toMatch(/minHeight: 44,/);
    expect(code).toContain(
      'accessibilityState={{ selected: !detail.localOwnerUserId, disabled: assignPending }}',
    );
    expect(code).toMatch(
      /accessibilityState=\{\{\s*selected: detail\.localOwnerUserId === member\.userId,\s*disabled: assignPending,\s*\}\}/,
    );
  });

  it('Retry and the photo source buttons are 44pt frames', () => {
    // Padding, not a fixed box the word is centred in: a taller word at a
    // large text size grows the frame and stays 6pt under the message
    // (-9 + 15), where a centred one rose into the message and sank past the
    // card's padding.
    expect(styleBlock(REQUEST, 'retryFrame')).toMatch(
      /minHeight: 44,\s*minWidth: 44,\s*paddingVertical: 15,\s*justifyContent: 'center',\s*marginTop: -9,\s*marginBottom: -15,/,
    );
    expect(styleBlock(REQUEST, 'addPhotoBtn')).toMatch(/minHeight: 44,/);
    expect(code).toMatch(
      /accessibilityLabel=\{`Retry \$\{label\}`\}\s*style=\{styles\.retryFrame\}/,
    );
  });

  // WCAG 2.5.3 (label in name): each spoken name starts with the word the
  // button shows, so Voice Control's "Tap Camera" and "Tap Library" find it.
  it('the Camera and Library buttons are named with the words they show', () => {
    const { sf, els } = elements(REQUEST, (el, s) => tagOf(el, s) === 'PhotoSourceButton');
    expect(
      els.map(({ el }) => [attrText(el, 'label', sf), attrText(el, 'accessibilityLabel', sf)]),
    ).toEqual([
      ['CAMERA', 'Camera, take a photo for this request'],
      ['LIBRARY', 'Library, choose a photo from your library for this request'],
      ['CAMERA', 'Camera, take a proof photo'],
      ['LIBRARY', 'Library, choose a proof photo from your library'],
    ]);
    for (const { el } of els) {
      const shown = attrText(el, 'label', sf)!.toLowerCase();
      expect(attrText(el, 'accessibilityLabel', sf)!.toLowerCase().startsWith(shown)).toBe(true);
    }
    expect(functionBody(REQUEST, 'PhotoSourceButton')).toContain(
      'accessibilityLabel={accessibilityLabel}',
    );
  });

  it('a fact sits under its label past the stacking scale', () => {
    expect(functionBody(REQUEST, 'DetailRow')).toContain('stacked && styles.detailRowStacked');
    expect(functionBody(REQUEST, 'RelatedRow')).toContain('stacked && styles.detailRowStacked');
    expect(styleBlock(REQUEST, 'detailRowStacked')).toMatch(/flexDirection: 'column'/);
  });

  // One ink button on the screen (DESIGN-SPEC 6.2), whichever forms are
  // open: Open in Outlook while none is; the Resolve or the Internal notes
  // commit while its form shows (Open in Outlook then the outline), and the
  // Resolve commit when both are. Their toggles and every other action are
  // the outline. The variants are the screen's own expressions, run here
  // over the screen's own form flags.
  it('the button hierarchy: one ink button whichever forms are open', () => {
    const flags =
      /const resolveFormShowing = [^;]+;\s*const notesFormShowing = [^;]+;\s*const formCommitShowing = [^;]+;/.exec(
        code,
      );
    expect(flags, 'the form flags').not.toBeNull();
    const { sf, els } = elements(REQUEST, (el, s) => tagOf(el, s) === 'Button');
    const OUTLOOK = 'Open in Outlook';
    const RESOLVE = '() => void doResolve()';
    const ADD_NOTE = '() => void doAddNote()';
    const name = (el: JsxNode) => textOf(el, sf) || attrText(el, 'onPress', sf)!;
    for (const [resolveOpen, notesOpen, ink] of [
      [false, false, OUTLOOK],
      [true, false, RESOLVE],
      [false, true, ADD_NOTE],
      [true, true, RESOLVE],
    ] as const) {
      const scope = new vm.Script(
        `${flags![0]} ({ resolveFormShowing, notesFormShowing, formCommitShowing });`,
      ).runInNewContext({
        actions: { resolve: true, notes: true },
        resolveOpen,
        notesOpen,
      }) as Record<string, boolean>;
      // A form's commit shows only while its form does; the rest may all show.
      const shown = els.filter(({ el }) =>
        name(el) === RESOLVE
          ? scope.resolveFormShowing
          : name(el) === ADD_NOTE
            ? scope.notesFormShowing
            : true,
      );
      const inks = shown
        .filter(({ el }) => {
          const v = attr(el, 'variant', sf)?.initializer;
          if (v === undefined) return true; // Button's default is the ink
          const variant = ts.isStringLiteral(v)
            ? v.text
            : new vm.Script(`(${(v as ts.JsxExpression).expression!.getText(sf)})`).runInNewContext(
                { ...scope },
              );
          return variant === 'primary';
        })
        .map(({ el }) => name(el));
      expect(inks, `resolve ${resolveOpen}, notes ${notesOpen}`).toEqual([ink]);
    }
    // The Mail glyph follows Open in Outlook's fill (paper on the ink, ink on
    // the outline), never paper on the card.
    const outlook = els.find(({ el }) => name(el) === OUTLOOK);
    expect(attrText(outlook!.el, 'leading', sf)).toContain(
      'color={formCommitShowing ? c.ink : c.paper}',
    );
    expect(code).toMatch(/\{resolveOpen \? \([\s\S]*?onPress=\{\(\) => void doResolve\(\)\}/);
    expect(code).toMatch(/\{notesOpen \? \([\s\S]*?onPress=\{\(\) => void doAddNote\(\)\}/);
  });

  it('typed boxes: the stronger border, the Inter Tight body, placeholders in the muted ink', () => {
    expect(code.match(/placeholderTextColor=\{c\.ink3\}/g)).toHaveLength(2);
    expect(styleBlock(REQUEST, 'textarea')).toMatch(/fontFamily: FONT\.displayRegular,/);
    // The two typed boxes and the two copy boxes are controls: hair2, never
    // the hairline alone.
    expect(
      code.match(/styles\.textarea, \{ color: c\.ink, borderColor: c\.hair2 \}/g),
    ).toHaveLength(2);
    expect(code.match(/styles\.copyBox, \{ color: c\.ink, borderColor: c\.hair2\b/g)).toHaveLength(
      2,
    );
  });

  it('keeps every word', () => {
    const words = wordsOf(REQUEST);
    for (const w of [
      'DESCRIPTION',
      'RESOLUTION',
      'REQUESTER',
      'SITE',
      'BUILDING',
      'ROOM OR AREA',
      'DEPARTMENT',
      'CATEGORY',
      'ACCESS INSTRUCTIONS',
      'RELATED ITEM',
      'RELATED LOCATION',
      'CAMERA',
      'LIBRARY',
      'RETRY',
      'EMAIL',
      'To',
      'CC',
      'Open in Outlook',
      'Open in Default Email App',
      'Copy Email Details',
      'Generate new photo share link',
      'Generate photo share link',
      'View photos page',
      'CLOSE-OUT',
      'Open another draft?',
      'Uploading…',
      'Uploaded',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe('New maintenance request (M-WS-11)', () => {
  const code = codeOnly(sourceOf(NEW_REQUEST));

  it('site, category and priority choices are 44pt buttons that say which is chosen', () => {
    const chip = functionBody(NEW_REQUEST, 'ChoiceChip');
    expect(chip).toContain('accessibilityRole="button"');
    expect(chip).toContain('accessibilityState={{ selected }}');
    expect(chip).toContain('<Check size={13} color={c.paper} strokeWidth={2}');
    // Dynamic Type: a site or category name is content, uncapped before the
    // restyle; capped at the 22pt control ceiling it stopped growing at AX2
    // and read smaller than its own field label.
    const labels = elements(
      NEW_REQUEST,
      (el, s) =>
        tagOf(el, s) === 'Body' && attrText(el, 'size', s) === '13' && textOf(el, s) === '',
    );
    const chipLabel = labels.els.filter(({ ancestors }) =>
      ancestors.some((a) => attrText(a, 'style', labels.sf)?.includes('styles.chip,')),
    );
    expect(chipLabel).toHaveLength(1);
    expect(attrText(chipLabel[0]!.el, 'maxFontSizeMultiplier', labels.sf)).toBeUndefined();
    expect(chip).not.toContain('maxFontSizeMultiplier');
    expect(code).not.toContain('CHIP_CAP');
    expect(styleBlock(NEW_REQUEST, 'chipFrame')).toMatch(/minHeight: 44,\s*minWidth: 44,/);
    const { sf, els } = elements(NEW_REQUEST, (el, s) => tagOf(el, s) === 'ChoiceChip');
    expect(els.map(({ el }) => attrText(el, 'onPress', sf))).toEqual([
      '() => setPriority(p)',
      '() => onChange(selected ? null : opt.id)',
      '() => onChange(selected ? null : opt)',
    ]);
  });

  it('every typed box is named, on the card with the stronger border, placeholder in the muted ink', () => {
    const { sf, els } = elements(NEW_REQUEST, (el, s) => tagOf(el, s) === 'TextInput');
    expect(els.map(({ el }) => attrText(el, 'accessibilityLabel', sf))).toEqual([
      'Subject',
      'Describe the issue',
      'Contact phone (optional)',
      'Building',
      'Room or area',
      'Department',
      'Additional access instructions',
    ]);
    for (const { el } of els) {
      expect(attrText(el, 'placeholderTextColor', sf)).toBe('c.ink3');
      expect(attrText(el, 'style', sf)).toMatch(/box\]$/);
      expect(attrText(el, 'maxFontSizeMultiplier', sf)).toBeUndefined();
    }
    expect(code).toContain(
      'const box = { color: c.ink, borderColor: c.hair2, backgroundColor: c.card };',
    );
  });

  it('the photo step: named source buttons, a named Retry in a 44pt frame, a Done button', () => {
    expect(code).toMatch(
      /onPress=\{onCamera\}\s*accessibilityRole="button"\s*accessibilityLabel="Camera, take a photo for this request"/,
    );
    expect(code).toMatch(
      /onPress=\{onLibrary\}\s*accessibilityRole="button"\s*accessibilityLabel="Library, choose a photo from your library for this request"/,
    );
    expect(code).toMatch(/onPress=\{onFinish\}\s*accessibilityRole="button"/);
    expect(code).toContain("accessibilityLabel={`Retry ${entry.fileName ?? 'photo'}`}");
    // Padding, not a fixed box the pill is centred in: a taller pill at a
    // large text size grows the frame and stays where it was (-8 + 8),
    // where a centred one rose into the 6pt gap under the message.
    expect(styleBlock(NEW_REQUEST, 'retryFrame')).toMatch(
      /minHeight: 44,\s*paddingVertical: 8,\s*justifyContent: 'center',\s*marginVertical: -8,/,
    );
    expect(styleBlock(NEW_REQUEST, 'addBtn')).toMatch(/minHeight: 44,/);
    expect(styleBlock(NEW_REQUEST, 'thumb')).toMatch(
      /borderWidth: 1,[\s\S]*backgroundColor: PHOTO_BACKGROUND,/,
    );
  });

  it('keeps every word', () => {
    const words = wordsOf(NEW_REQUEST);
    for (const w of [
      'NEW MAINTENANCE REQUEST',
      'ESCALATE TO MAINTENANCE',
      'ADD PHOTOS',
      'WHAT&apos;S THE ISSUE',
      'SUBJECT',
      'DESCRIBE THE ISSUE',
      'DETAILS',
      'SITE',
      'CATEGORY',
      'PRIORITY',
      'CONTACT PHONE (OPTIONAL)',
      'LOCATION',
      'BUILDING',
      'ROOM OR AREA',
      'DEPARTMENT',
      'ADDITIONAL ACCESS INSTRUCTIONS',
      'Example: Air conditioner is not working in Room 204',
      '(555) 555-0100',
      'Main building',
      'Room 204',
      'No sites configured.',
      'Save request',
      'Done',
      'CAMERA',
      'LIBRARY',
      'Retry',
      'Uploading…',
      'Uploaded',
      'Low',
      'Normal',
      'High',
      'Urgent',
      'LINKED EXCEPTION',
      'You do not have permission to submit maintenance requests.',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

// ── Zendesk, its web view, Support (M-WS-12, 13, 14) ────────────────────────

describe('Zendesk (M-WS-12)', () => {
  const code = codeOnly(sourceOf(ZENDESK));

  // The head promised the agent console "(soon)" while the AGENT CONSOLE card
  // already opens it in the app (the redesign allows no coming-soon words).
  it('says the console is here, not coming', () => {
    expect(wordsOf(ZENDESK)).toContain('Support tickets + an in-app agent console.');
    expect(wordsOf(ZENDESK).join(' ')).not.toMatch(/\(soon\)/);
  });

  it('one ink button a screen; Disconnect still has no confirm; the console opens in the app', () => {
    expect(code).toContain("variant={canManage && !connected ? 'outline' : 'primary'}");
    expect(code).toMatch(
      /pathname: '\/zendesk\/web',\s*params: \{ subdomain: connection\.subdomain! \},/,
    );
    const disconnect = functionBody(ZENDESK, 'onDisconnect');
    expect(disconnect.indexOf("await api('/api/v1/zendesk/disconnect'")).toBeLessThan(
      disconnect.indexOf('Alert.alert'),
    );
    expect(code).toContain("setApiToken('');");
    expect(code).toContain('secureTextEntry');
  });

  it('keeps every word', () => {
    const words = wordsOf(ZENDESK);
    for (const w of [
      'ZENDESK',
      'Support',
      'CONNECTION',
      'AGENT CONSOLE',
      'Not connected yet.',
      'ACTIVE',
      'OFFLINE',
      'Subdomain',
      'Agent email',
      'API token',
      'Connecting…',
      'Connect',
      'Disconnecting…',
      'Disconnect',
      'Ask an admin to connect Zendesk.',
      'Open Zendesk',
      'Ask an admin to set your Zendesk subdomain (on the web app).',
      "Couldn't load Zendesk status",
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe('Zendesk web view (M-WS-13)', () => {
  const code = codeOnly(sourceOf(ZENDESK_WEB));
  it('Retry carries its icon in the leading slot; the guard and the session props stay', () => {
    expect(code).toMatch(
      /<Button\s+variant="outline"\s+size="sm"\s+onPress=\{handleRetry\}\s+leading=\{<RefreshCw size=\{14\} color=\{c\.ink\} \/>\}\s*>\s*Retry\s*<\/Button>/,
    );
    expect(code).toContain('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(trimmed)');
    for (const prop of ['domStorageEnabled', 'sharedCookiesEnabled', 'thirdPartyCookiesEnabled']) {
      expect(code).toContain(prop);
    }
    const words = wordsOf(ZENDESK_WEB);
    for (const w of [
      'Zendesk',
      'No Zendesk subdomain set — set it on the web app first.',
      'Open in browser',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe('Support (M-WS-14): Back and a named menu (D28)', () => {
  const code = codeOnly(sourceOf(SUPPORT));

  it('the bar is the other screens’ bar: Back (honouring ?return=) and Open menu', () => {
    const { sf, els } = elements(SUPPORT, (el, s) => tagOf(el, s) === 'IconChip');
    expect(
      els.map(({ el }) => [attrText(el, 'icon', sf), attrText(el, 'accessibilityLabel', sf)]),
    ).toEqual([
      ['ArrowLeft', 'Back'],
      ['Menu', 'Open menu'],
    ]);
    for (const { el } of els) expect(attrText(el, 'minTap', sf)).toBe('true');
    expect(code).toMatch(
      /const goBack = \(\) => \{\s*if \(typeof returnPath === 'string' && returnPath\.length > 0\) \{\s*router\.replace\(returnPath as never\);\s*\} else if \(router\.canGoBack\(\)\) \{\s*router\.back\(\);\s*\} else \{\s*router\.replace\('\/'\);/,
    );
    expect(styleBlock(SUPPORT, 'topbar')).toMatch(/paddingHorizontal: 9,\s*paddingTop: 5,/);
    expect(styleBlock(SUPPORT, 'chipsSpacer')).toMatch(/width: 90/);
  });

  it('category chips are 44pt buttons that say which is chosen; the remove X is named', () => {
    expect(code).toMatch(
      /onPress=\{\(\) => setCategory\(cat\.value\)\}\s*accessibilityRole="button"\s*accessibilityState=\{\{ selected \}\}/,
    );
    expect(styleBlock(SUPPORT, 'chipFrame')).toMatch(/minHeight: 44, minWidth: 44/);
    expect(code).toMatch(
      /onPress=\{removeAttachment\}\s*accessibilityRole="button"\s*accessibilityLabel="Remove screenshot"/,
    );
    expect(styleBlock(SUPPORT, 'removeFrame')).toMatch(/width: 44, height: 44/);
  });

  it('still posts the same ticket, and keeps every word', () => {
    expect(code).toContain("await api('/api/v1/support', {");
    const words = wordsOf(SUPPORT);
    for (const w of [
      'Support &amp; feedback',
      'WE READ EVERYTHING',
      'How can we',
      'help?',
      'CATEGORY',
      'Bug',
      'Feature request',
      'Billing',
      'Other',
      'Subject',
      'Short summary',
      'Details',
      'What happened, and what did you expect?',
      'SCREENSHOT (OPTIONAL)',
      'Screenshot attached',
      'Camera',
      'Photos',
      'Sending…',
      'Send to StockPilot',
      'Thanks — we got it.',
      'Our team will follow up by email. You can send another any time.',
      'Send another',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

describe('wording: never "book" for a recorded quantity, no emoji', () => {
  it.each(SCREENS)('%s', (file) => {
    for (const w of wordsOf(file)) {
      expect(w, w).not.toMatch(/\bbook (?:qty|quantity|count)\b|\bthe book\b/i);
      expect(w, w).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
