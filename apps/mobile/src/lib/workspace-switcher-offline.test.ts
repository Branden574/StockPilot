import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { attrText, parseTsx, readSource, tagOf, walkJsx, type JsxNode } from './__fixtures__/jsx-touch-audit';

/**
 * AN ORGANIZATION SWITCH NEEDS A CONNECTION (review 2026-09-26).
 *
 * setActiveOrg (use-workspace.ts) clears this phone's offline copy of the old
 * organization (deleteOrgData: items, purchase orders, counts, bundles) and
 * then pulls the new one in full. Offline that pull cannot start, so a tap in
 * the drawer's switcher, even by mistake, left the phone with no offline copy
 * of either organization until it was back online. Since the failed-read fix
 * (D1) kept the switcher visible offline, that tap became easy to make.
 *
 * The sheet reads the live network state (expo-network, the rule sync.ts
 * isOnline() applies, as the Exceptions screens do) and does not switch
 * organization while offline; warehouses still switch (nothing is cleared).
 * No React Native renderer here: these read the element tree the sheet
 * declares (the jsx-touch-audit technique).
 */

const FILE = 'src/components/workspace-switcher.tsx';
const SOURCE = readSource(path.resolve(__dirname, '../..', FILE));
const sf = parseTsx(SOURCE, FILE);

function sheetFunction(): ts.FunctionDeclaration {
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'WorkspaceSwitcherSheet',
  );
  expect(fn).toBeDefined();
  return fn!;
}

function pressablesCalling(call: string): JsxNode[] {
  const out: JsxNode[] = [];
  walkJsx(sheetFunction(), (el) => {
    if (tagOf(el, sf) === 'Pressable' && (attrText(el, 'onPress', sf) ?? '').includes(call)) out.push(el);
  });
  return out;
}

describe('the workspace switcher: no organization switch offline', () => {
  it('reads the live network state with the shared rule', () => {
    const body = sheetFunction().getText(sf);
    expect(SOURCE).toContain("import { useNetworkState } from 'expo-network';");
    expect(SOURCE).toContain("import { isOfflineState } from '@/lib/exceptions-api';");
    expect(body).toContain('const offline = isOfflineState(useNetworkState());');
  });

  // Mutation caught: the old row, `onPress={() => void setActiveOrg(o.id)}`,
  // which switched (and cleared the offline copy) whatever the connection.
  it('an organization row is disabled offline, and its press does nothing then', () => {
    const rows = pressablesCalling('setActiveOrg(');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(attrText(row!, 'disabled', sf)).toBe('offline');
    expect(attrText(row!, 'onPress', sf)).toMatch(/if \(!offline\) void setActiveOrg\(o\.id\);/);
    expect(attrText(row!, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(row!, 'accessibilityState', sf)).toBe('{ selected, disabled: offline }');
  });

  it('says why, under ORGANIZATIONS, while offline', () => {
    const body = sheetFunction().getText(sf);
    expect(body).toMatch(/\{offline && orgs\.length > 1 \? \(\s*<Body[^>]*>\s*\{WORKSPACE_SWITCH_OFFLINE_COPY\}/);
    expect(body.indexOf('{WORKSPACE_SWITCH_OFFLINE_COPY}')).toBeGreaterThan(body.indexOf('<Eyebrow>ORGANIZATIONS</Eyebrow>'));
    expect(body.indexOf('{WORKSPACE_SWITCH_OFFLINE_COPY}')).toBeLessThan(body.indexOf('orgs.map('));
    expect(SOURCE).toMatch(/WORKSPACE_SWITCH_OFFLINE_COPY =\s*"Switching organization needs a connection\./);
  });

  it('warehouses still switch offline (a warehouse switch clears nothing)', () => {
    const rows = pressablesCalling('setActiveWarehouse(');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(attrText(row, 'disabled', sf)).toBeUndefined();
  });
});
