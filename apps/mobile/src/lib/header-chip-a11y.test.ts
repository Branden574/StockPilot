import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
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

  it('back arrows say Back and the drawer chip says Open menu', () => {
    const back = chips.filter((c) => /^(ArrowLeft|ChevronLeft)$/.test(attrText(c.el, 'icon', c.sf) ?? ''));
    expect(back.length).toBeGreaterThanOrEqual(30);
    expect(back.filter((c) => !/^Back\b/.test(label(c) ?? '')).map(where)).toEqual([]);
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

describe('the Home avatar is named too', () => {
  it('Account settings, announced as a button', () => {
    const home = readSource(path.join(MOBILE_ROOT, 'app/(drawer)/(tabs)/index.tsx'));
    expect(home).toMatch(/<Avatar\s+size=\{38\}\s+onPress=\{\(\) => router\.push\('\/settings'\)\}\s+accessibilityLabel="Account settings"/);
    const avatar = readSource(path.join(MOBILE_ROOT, 'src/components/ui/avatar.tsx'));
    expect(avatar).toMatch(/accessibilityRole="button"\s+accessibilityLabel=\{accessibilityLabel\}/);
  });
});
