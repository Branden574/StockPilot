import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  TOUCHABLE_TAG,
  attr,
  attrText,
  listTsx,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';

/**
 * EVERY HEADER ICON CHIP IS NAMED, AND A 44PT TARGET (walks 2026-09-28/29).
 *
 * The round icon buttons in the screens' top bars (IconChip: back arrows,
 * the drawer menu, notifications, refresh, new, edit, select) were unnamed
 * for VoiceOver on most screens (it found an element with no words and no
 * button role) and their target was the 38pt chip, under the 44pt iOS
 * minimum. Every one now carries an accessibilityLabel (which also makes it a
 * button) and IconChip's `minTap` 44pt frame; each bar takes the frame's 3pt
 * off its padding so the chips sit where they did.
 *
 * This sweeps every screen and component (the mobile suite has no React
 * Native renderer; same technique as sheet-backdrop-guard.test.ts), so a new
 * chip without a name, or without the frame, fails here.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

/**
 * Files this sweep skips, each with the reason. The Staging tab's chips are
 * named and framed on feat/f2-3-put-away-partial (b80c904f), which edits the
 * same lines; this branch leaves the file alone so that merge stays clean.
 * Drop the entry once F2-3 is on main (the sweep then covers it too).
 */
const PENDING_ELSEWHERE = new Set(['app/(drawer)/staging.tsx']);

type Chip = { el: JsxNode; sf: ts.SourceFile; file: string };

function allChips(): Chip[] {
  const files = listTsx(path.join(MOBILE_ROOT, 'app'), path.join(MOBILE_ROOT, 'src'));
  const out: Chip[] = [];
  for (const abs of files) {
    const file = path.relative(MOBILE_ROOT, abs);
    if (PENDING_ELSEWHERE.has(file)) continue;
    const sf = parseTsx(readSource(abs), file);
    walkJsx(sf, (el) => {
      if (tagOf(el, sf) === 'IconChip') out.push({ el, sf, file });
    });
  }
  return out;
}

function where(c: Chip): string {
  const { line } = c.sf.getLineAndCharacterOfPosition(c.el.getStart(c.sf));
  return `${c.file}:${line + 1} <IconChip icon={${attrText(c.el, 'icon', c.sf)}}>`;
}

const chips = allChips();
const label = (c: Chip) => attrText(c.el, 'accessibilityLabel', c.sf);

describe('header icon chips: named, and a 44pt target', () => {
  it('finds the chips (the sweep is not vacuous)', () => {
    expect(chips.length).toBeGreaterThanOrEqual(55);
    expect(new Set(chips.map((c) => c.file)).size).toBeGreaterThanOrEqual(35);
  });

  // Mutation caught: any chip's accessibilityLabel removed or emptied.
  it('every chip has an accessibilityLabel', () => {
    const unnamed = chips.filter((c) => !label(c) || label(c)!.trim() === '' || label(c) === "''");
    expect(unnamed.map(where)).toEqual([]);
  });

  // Mutation caught: minTap dropped (the target is the 38pt chip again) or the
  // target widened with hitSlop, which VoiceOver's outline does not show.
  it('every chip takes the 44pt frame, never hitSlop', () => {
    expect(chips.filter((c) => attrText(c.el, 'minTap', c.sf) !== 'true').map(where)).toEqual([]);
    expect(chips.filter((c) => attrText(c.el, 'hitSlop', c.sf) !== undefined).map(where)).toEqual([]);
  });

  // The Zendesk screen had a help chip with no action: a button that did
  // nothing. Mutation caught: a chip without onPress.
  it('every chip does something when tapped', () => {
    expect(chips.filter((c) => !attrText(c.el, 'onPress', c.sf)).map(where)).toEqual([]);
  });

  // A written label starts with "Back" ("Back", "Back to the order"); a
  // computed one (the Staging tab's, on F2-3: `fromOrderId ?
  // STAGING_FILTER_BACK_LABEL : 'Back'`) must at least be one of those.
  it('back arrows say Back and the drawer chip says Open menu', () => {
    const back = chips.filter((c) => /^(ArrowLeft|ChevronLeft)$/.test(attrText(c.el, 'icon', c.sf) ?? ''));
    expect(back.length).toBeGreaterThanOrEqual(30);
    const saysBack = (c: Chip) => {
      const init = attr(c.el, 'accessibilityLabel', c.sf)?.initializer;
      const written = init !== undefined && ts.isStringLiteral(init);
      return written ? /^Back\b/.test(label(c) ?? '') : /back/i.test(label(c) ?? '');
    };
    expect(back.filter((c) => !saysBack(c)).map(where)).toEqual([]);
    const menu = chips.filter((c) => attrText(c.el, 'icon', c.sf) === 'Menu');
    expect(menu.length).toBeGreaterThanOrEqual(12);
    expect(menu.filter((c) => label(c) !== 'Open menu').map(where)).toEqual([]);
  });

  it('the other chips say what they do', () => {
    const named = (file: string) =>
      chips.filter((c) => c.file === file && !/^(ArrowLeft|ChevronLeft|Menu)$/.test(attrText(c.el, 'icon', c.sf) ?? '')).map(label);
    expect(named('app/(drawer)/(tabs)/index.tsx')).toEqual([
      "unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'",
      'Refresh',
    ]);
    expect(named('app/(drawer)/(tabs)/inventory.tsx')).toEqual([
      "selectMode ? 'Done selecting' : 'Select items'",
      'New item',
    ]);
    expect(named('app/(drawer)/(tabs)/books.tsx')).toEqual([
      "selectMode ? 'Done selecting' : 'Select books'",
      'New book',
    ]);
    expect(named('app/(drawer)/(tabs)/cycle-counts.tsx')).toEqual(['Start a cycle count']);
    expect(named('app/(drawer)/settings.tsx')).toEqual(['Email StockPilot support']);
    expect(named('app/(drawer)/settings/integrations.tsx')).toEqual(['Refresh']);
    expect(named('app/(drawer)/schedule.tsx')).toEqual(['New event']);
    expect(named('app/(drawer)/notifications.tsx')).toEqual(['Mark all as read']);
    expect(named('app/item/[id].tsx')).toEqual(['Edit item']);
    expect(named('app/(drawer)/zendesk.tsx')).toEqual([]);
  });

  // The frame is 3pt wider than the chip on every side, so a bar that keeps
  // its old 8pt top padding drops its chips 3pt below every other screen's.
  // Mutation caught: a bar's paddingTop put back to 8 (src/screens/reports.tsx
  // had taken minTap without it).
  it('every bar with framed chips takes the 3pt off its top padding', () => {
    const files = [...new Set(chips.map((c) => c.file))];
    const offenders: string[] = [];
    for (const file of files) {
      const src = readSource(path.join(MOBILE_ROOT, file));
      for (const m of src.matchAll(/\btopbar: \{[^}]*?paddingTop: (\d+)/g)) {
        if (Number(m[1]) !== 5) offenders.push(`${file}: topbar paddingTop ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the Home avatar is named too, and a 44pt target', () => {
  const home = readSource(path.join(MOBILE_ROOT, 'app/(drawer)/(tabs)/index.tsx'));
  const avatar = readSource(path.join(MOBILE_ROOT, 'src/components/ui/avatar.tsx'));

  it('Account settings, announced as a button', () => {
    expect(home).toMatch(/<Avatar\s+size=\{38\}\s+onPress=\{\(\) => router\.push\('\/settings'\)\}\s+accessibilityLabel="Account settings"/);
    expect(avatar).toMatch(/accessibilityRole="button"\s+accessibilityLabel=\{accessibilityLabel\}/);
  });

  // Review of 2026-09-29: the 38pt avatar took hitSlop 8, so VoiceOver
  // outlined 38pt, not the 44pt the chips beside it now have. Mutation
  // caught: hitSlop back, or the frame dropped or sized to the picture.
  it('a tappable avatar is a real 44pt frame around the same picture, never hitSlop', () => {
    expect(avatar).not.toMatch(/hitSlop=/);
    expect(avatar).toMatch(/const frame = Math\.max\(MIN_TAP, size\);/);
    expect(avatar).toMatch(/const MIN_TAP = 44;/);
    expect(avatar).toMatch(/width: frame,\s*height: frame,\s*alignItems: 'center',\s*justifyContent: 'center',/);
  });

  // The frame is 3pt wider than the 38pt picture on every side, so the gap
  // from the menu chip's frame takes the 3pt: the picture stays where it was
  // (12 + 38 + 8 from the left edge). Mutation caught: the gap left at 5.
  it('Home gives the 3pt back, so the picture does not move', () => {
    expect(home).toMatch(/<View style=\{\{ flexDirection: 'row', alignItems: 'center', gap: 2 \}\}>\s*<IconChip icon=\{Menu\}/);
  });
});

/**
 * THE TEXT BACK LINKS AND THE COUNTING CAMERAS' DONE AND CANCEL (review of
 * 2026-09-29). Not IconChips, so the sweep above did not see them: "← Back"
 * on a cycle count (its three states), on Bundles and a bundle, and on the AI
 * count's review; Done and Cancel over the counting cameras. VoiceOver read
 * the arrow and the word with no button role, and each was about 25-28pt
 * tall. Each is now a button named for what it does, in a frame at least
 * 44pt tall (a real frame, not hitSlop), the frame's extra height taken from
 * the padding around it where there is room.
 */
describe('text Back links and the cameras Done and Cancel: buttons, and a 44pt target', () => {
  type Touch = { el: JsxNode; sf: ts.SourceFile; file: string; src: string; text: string };
  const textOf = (el: JsxNode, sf: ts.SourceFile): string => {
    const parts: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isJsxText(n)) parts.push(n.getText(sf).trim());
      ts.forEachChild(n, visit);
    };
    visit(el);
    return parts.filter(Boolean).join(' ');
  };
  const touches: Touch[] = [];
  for (const abs of listTsx(path.join(MOBILE_ROOT, 'app'), path.join(MOBILE_ROOT, 'src'))) {
    const file = path.relative(MOBILE_ROOT, abs);
    const src = readSource(abs);
    const sf = parseTsx(src, file);
    walkJsx(sf, (el) => {
      if (TOUCHABLE_TAG.test(tagOf(el, sf))) touches.push({ el, sf, file, src, text: textOf(el, sf) });
    });
  }
  const at = (t: Touch) => `${t.file}:${t.sf.getLineAndCharacterOfPosition(t.el.getStart(t.sf)).line + 1} (${t.text})`;
  /** The StyleSheet entries the touchable's own style names, as source text. */
  const styleBlocks = (t: Touch) =>
    [...(attrText(t.el, 'style', t.sf) ?? '').matchAll(/styles\.(\w+)/g)].map(
      ([, name]) => new RegExp(`\\n  ${name}: \\{([^}]*)\\}`).exec(t.src)?.[1] ?? '',
    );
  const has44Frame = (t: Touch) => styleBlocks(t).some((b) => /minHeight: (44|MIN_TAP)\b/.test(b));

  const backLinks = touches.filter((t) => /^←\s*Back$/.test(t.text));

  it('finds them (the sweep is not vacuous)', () => {
    expect(backLinks.map((t) => t.file).sort()).toEqual([
      'app/bundles/[id].tsx',
      'app/bundles/index.tsx',
      'app/cycle-count/[id].tsx',
      'app/cycle-count/[id].tsx',
      'app/cycle-count/[id].tsx',
      'app/cycle-count/ai-scan/[id].tsx',
    ]);
  });

  // Mutation caught: the role or the name dropped from any of them.
  it('every "← Back" is a button named Back', () => {
    const wrong = backLinks.filter(
      (t) => attrText(t.el, 'accessibilityRole', t.sf) !== 'button' || attrText(t.el, 'accessibilityLabel', t.sf) !== 'Back',
    );
    expect(wrong.map(at)).toEqual([]);
  });

  // Mutation caught: the frame's minHeight dropped (25pt again), or hitSlop.
  it('every "← Back" is a frame at least 44pt tall, never hitSlop', () => {
    expect(backLinks.filter((t) => !has44Frame(t)).map(at)).toEqual([]);
    expect(backLinks.filter((t) => attr(t.el, 'hitSlop', t.sf)).map(at)).toEqual([]);
  });

  it("Bundles' Refresh beside it is a button named Refresh, 44pt tall", () => {
    const refresh = touches.filter((t) => t.file === 'app/bundles/index.tsx' && attrText(t.el, 'onPress', t.sf) === 'refresh');
    expect(refresh).toHaveLength(1);
    expect(attrText(refresh[0]!.el, 'accessibilityRole', refresh[0]!.sf)).toBe('button');
    expect(attrText(refresh[0]!.el, 'accessibilityLabel', refresh[0]!.sf)).toBe('Refresh');
    expect(has44Frame(refresh[0]!)).toBe(true);
  });

  // The counting cameras' way out: Done (scan) and Cancel (AI shelf scan).
  it.each([
    ['app/cycle-count/scan/[id].tsx', 'Done'],
    ['app/cycle-count/ai-scan/[id].tsx', 'Cancel'],
  ])('%s: %s is a button, in a 44pt frame around the same pill', (file, word) => {
    const found = touches.filter((t) => t.file === file && t.text === word);
    expect(found).toHaveLength(1);
    const t = found[0]!;
    expect(attrText(t.el, 'accessibilityRole', t.sf)).toBe('button');
    expect(attrText(t.el, 'accessibilityLabel', t.sf)).toBe(word);
    expect(has44Frame(t)).toBe(true);
    expect(styleBlocks(t).some((b) => /minWidth: (44|MIN_TAP)\b/.test(b))).toBe(true);
    expect(attr(t.el, 'hitSlop', t.sf)).toBeUndefined();
  });
});
