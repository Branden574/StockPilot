import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every bottom sheet in the phone's core flows takes ONE Liquid Glass frame
 * (.ios-sheet.glass-strong [740], the boards' Adjust and filter sheets):
 *
 *   the scrim     Classic's tint with `lg && glassScrim(lg)` over it (--scrim;
 *                 it tints the page and never blurs it),
 *   the card      Classic's card with `lg && GLASS_SHEET_CARD` over it (8pt in
 *                 from the sides and the foot, radius 36, no fill of its own),
 *   the material  `{lg ? <GlassSheetBackdrop /> : null}` as the card's FIRST
 *                 child, so it sits under every word and control the card
 *                 holds (the overlay glass with the glass-strong fill, the
 *                 opaque chrome under Reduce Transparency),
 *   the grabber   --ios-sep in place of Classic's faint ink, or, where the
 *                 Classic card draws none, `{lg ? <GlassSheetGrabber /> : null}`
 *                 (decoration, hidden from VoiceOver).
 *
 * A centred dialog (the order's signature, Deny and Reopen dialogs) takes the
 * same scrim and material, its card at the dialog radius:
 *   the card      `lg && <styles>.dialog` over Classic's card (no fill of its
 *                 own, the radius, overflow hidden),
 *   the material  `{lg ? <GlassSheetBackdrop radius={RADIUS} /> : null}` as
 *                 the card's first child.
 *
 * Classic is untouched by any of it: each is a branch on the look, folded
 * away by the classic projection (glass-classic-pins.test.ts pins each file).
 * A sheet added to this list before it is converted fails here first.
 */
const ROOT = path.resolve(__dirname, '../..');

/** [file, how many bottom sheets it draws, how many centred dialogs]. */
const SHEETS: [string, number, number][] = [
  ['app/item/[id].tsx', 4, 0],
  ['app/order/[id].tsx', 2, 3],
  ['src/components/filter-sheet.tsx', 1, 0],
  ['src/components/move-stock-modal.tsx', 1, 0],
  ['src/components/remove-from-rack-modal.tsx', 1, 0],
  ['src/components/item-history-sheet.tsx', 1, 0],
  ['src/components/biometric-optin-sheet.tsx', 1, 0],
  ['src/components/workspace-switcher.tsx', 1, 0],
  // Stage 4, native-admin lane: the role picker on Users.
  ['app/(drawer)/admin/users.tsx', 1, 0],
];

/** Source with comments stripped, one space per whitespace run. */
function codeOf(file: string): string {
  return fs
    .readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
}

const count = (code: string, re: RegExp) => code.match(re)?.length ?? 0;

describe.each(SHEETS)('%s', (file, sheets, dialogs) => {
  const code = codeOf(file);

  it('reads the look once per component and folds every glass part on it', () => {
    expect(code).toContain("import { useGlass } from '@/components/ui/glass/use-glass';");
    expect(count(code, /const lg = useGlass\(\);/g)).toBeGreaterThanOrEqual(1);
  });

  it('tints the page with the glass scrim over Classic’s', () => {
    expect(count(code, /lg && glassScrim\(lg\)/g)).toBe(sheets + dialogs);
  });

  it('draws each card as the glass sheet, with the material as its first child', () => {
    expect(count(code, /lg && GLASS_SHEET_CARD\b/g)).toBe(sheets);
    expect(count(code, /\{lg \? <GlassSheetBackdrop \/> : null\}/g)).toBe(sheets);
    // The card's style array ends, the element opens, and the material is
    // the first thing in it.
    expect(
      count(
        code,
        /lg && GLASS_SHEET_CARD,[^\]]*\]\} ?(?:[a-zA-Z]+=\{[^}]*\} ?)*> ?\{lg \? <GlassSheetBackdrop \/> : null\}/g,
      ),
    ).toBe(sheets);
  });

  it('draws the grabber in --ios-sep', () => {
    expect(
      count(code, /lg \? lg\.ios\.sep : /g) +
        count(code, /lg && glassGrabber\(lg\)/g) +
        count(code, /\{lg \? <GlassSheetGrabber \/> : null\}/g),
    ).toBe(sheets);
  });

  it('draws each centred dialog on the same material at the dialog radius', () => {
    expect(count(code, /\{lg \? <GlassSheetBackdrop radius=\{[A-Z_]+\} \/> : null\}/g)).toBe(
      dialogs,
    );
    expect(
      count(
        code,
        /lg && [\w.()]+\.dialog,[^\]]*\]\} ?(?:[a-zA-Z]+=\{[^}]*\} ?)*> ?\{lg \? <GlassSheetBackdrop radius=\{[A-Z_]+\} \/> : null\}/g,
      ),
    ).toBe(dialogs);
  });
});
