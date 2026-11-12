import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * B42 on the phone: WIRING PINS for who is offered a count start.
 *
 * Only a manager with cycle_counts:assign and stock:adjust can start a count
 * (the server's assertCountStartFloors; the cycle_counts INSERT policy is
 * manager-only). The Cycle counts tab offered ＋ and its hint on stock:adjust
 * alone, the select bar drew Review for everyone, Items and Books offered
 * Select to everyone, and New count put the server's raw refusal ("Missing
 * permission: cycle_counts:assign") in its alert. Staff hold stock:adjust, so
 * they were offered a start the server always refused.
 *
 * The screens cannot render under this node test environment (app/ imports
 * native modules at load), so the wiring is pinned at source level, as in
 * exceptions-recount-wiring.test.ts. The rules are pure and tested in
 * count-select-offers.test.ts and core.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const tab = codeOnly(read('../../app/(drawer)/(tabs)/cycle-counts.tsx'));
const bar = codeOnly(read('../components/count-select-bar.tsx'));
const items = codeOnly(read('../../app/(drawer)/(tabs)/inventory.tsx'));
const books = codeOnly(read('../../app/(drawer)/(tabs)/books.tsx'));
const newCount = codeOnly(read('../../app/cycle-count/new.tsx'));

describe('the Cycle counts tab', () => {
  it('offers ＋ and the start hint by core countStartAllowed, not stock:adjust', () => {
    expect(tab).toMatch(
      /const canStartCount = countStartAllowed\(\{\s*role,\s*permissions: perms,\s*cycleCountsEnabled: enabledModules\.has\('cycle_counts'\),\s*\}\);/,
    );
    expect(tab).toContain('const { role } = useRole();');
    expect(tab).not.toContain("showWriteCta(perms, 'stock:adjust')");
    expect(tab).toMatch(/\{canStartCount \? \(\s*<IconChip\s+icon=\{Plus\}/);
    expect(tab).toMatch(
      /: canStartCount\s*\? startHint\s*: 'Counts a manager starts appear here\.'/,
    );
  });
});

describe('the select bar', () => {
  it('draws Review only for someone who can start a count', () => {
    expect(bar).toContain(
      'const offers = countSelectOffers({ role, permissions, enabledModules });',
    );
    expect(bar).toMatch(
      /\{offers\.review \? \(\s*<Pressable[\s\S]*?Review\s*<\/Mono>\s*<\/Pressable>\s*\) : null\}/,
    );
    // The Review button is never drawn outside that gate.
    expect(bar.match(/router\.push\('\/cycle-count\/new'\)/g)).toHaveLength(1);
  });

  it('keeps the Group and Ungroup rules, from the same offers', () => {
    expect(bar).toContain('const canGroup = offers.group;');
    expect(bar).toMatch(
      /const canUngroup = phoneUngroupOffer\(picks, \{\s*editItems: offers\.group,\s*unlinkFamilies: offers\.unlinkFamilies,\s*\}\);/,
    );
  });
});

describe.each([
  ['Items', items, 'Select items'],
  ['Books', books, 'Select books'],
])('the %s tab', (_name, code, label) => {
  it('offers Select only when the bar has something to offer', () => {
    expect(code).toMatch(
      /const selectOffers = countSelectOffers\(\{\s*role,\s*permissions,\s*enabledModules,?\s*\}\);/,
    );
    const chip = new RegExp(
      `\\{selectOffers\\.any \\? \\(\\s*<IconChip\\s+icon=\\{selectMode \\? Check : ListChecks\\}\\s+onPress=\\{\\(\\) => setSelectMode\\(\\(v\\) => !v\\)\\}\\s+accessibilityLabel=\\{selectMode \\? 'Done selecting' : '${label}'\\}`,
    );
    expect(code).toMatch(chip);
  });

  it('leaves select mode when the bar stops having anything to offer', () => {
    expect(code).toMatch(
      /React\.useEffect\(\(\) => \{\s*if \(!selectOffers\.any\) setSelectMode\(false\);\s*\}, \[selectOffers\.any\]\);/,
    );
  });
});

describe('New count', () => {
  it('says in plain words that only a manager can start a count, and keeps Start count off', () => {
    expect(newCount).toContain('const managerOnly = countStartManagerOnly({ role, permissions });');
    expect(newCount).toMatch(
      /\{managerOnly \? \([\s\S]*?\{COUNT_START_MANAGER_ONLY_COPY\}[\s\S]*?\) : null\}/,
    );
    expect(newCount).toContain('disabled={busy || picks.length === 0 || managerOnly}');
    expect(newCount).toContain('if (picks.length === 0 || busy || managerOnly) return;');
  });

  it('never shows the raw permission: a refusal goes through countStartFailureMessage', () => {
    expect(newCount).toContain(
      "Alert.alert('Could not start count', countStartFailureMessage(e));",
    );
    expect(newCount).not.toMatch(/e instanceof Error \? e\.message/);
  });

  // The screens' shared reservation (dynamic-type-layout.ts): the measured
  // footer plus clearance, never less than the 150 the list kept before.
  it('keeps the footer clear of the list when the notice makes it taller', () => {
    expect(newCount).toContain(
      'const [footerHeight, setFooterHeight] = React.useState<number | null>(null);',
    );
    expect(newCount).toContain('onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}');
    expect(newCount).toContain('paddingBottom: footerReservation(footerHeight, 150),');
  });
});
