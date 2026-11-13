import { describe, expect, it } from 'vitest';

import {
  classicFlat,
  classicHash,
  flatNorm,
  printClassic,
  projectionLeaks,
} from './__fixtures__/classic-projection';

/**
 * The classic projection (lib/__fixtures__/classic-projection.ts) is the
 * proof every Liquid Glass pin rests on, so it is tested on its own: each
 * glass form folds back to exactly the Classic it was written over, and a
 * real Classic change, however small, never folds away.
 */

const same = (base: string, glass: string) =>
  expect(classicHash(glass, 'probe.tsx'), printClassic(glass, 'probe.tsx')).toBe(
    classicHash(base, 'probe.tsx'),
  );
const differs = (base: string, changed: string) =>
  expect(classicHash(changed, 'probe.tsx')).not.toBe(classicHash(base, 'probe.tsx'));

const BASE = `
import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { useTheme } from '@/lib/use-theme';

export default function Screen({ items }: { items: string[] }) {
  const { c } = useTheme();
  const total = React.useMemo(() => items.length, [items]);
  if (total === 0) {
    return <Text style={styles.empty}>Nothing yet</Text>;
  }
  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <Text style={styles.title}>Items</Text>
      <Card padding={16}>
        {items.map((i) => (
          <Text key={i}>{i}</Text>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  title: { fontSize: 20, padding: 16 },
  empty: { padding: 24 },
});
`;

const GLASS = `
// Liquid Glass: a scene behind, a large title, the card on the glass fill.
import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { SceneBackground } from '@/components/ui/glass';
import { useGlass } from '@/components/ui/glass/use-glass';
import { useTheme } from '@/lib/use-theme';

export default function Screen({ items }: { items: string[] }) {
  const { c } = useTheme();
  const lg = useGlass();
  const total = React.useMemo(() => items.length, [items]);
  if (total === 0) {
    return <Text style={[styles.empty, lg && GLASS.empty]}>Nothing yet</Text>;
  }
  return (
    <View
      style={[styles.root, { backgroundColor: lg ? 'transparent' : c.paper }]}
      pointerEvents={lg ? 'box-none' : undefined}
    >
      {lg ? <SceneBackground /> : null}
      {lg && <GlassBadge />}
      <Text style={[styles.title, lg && GLASS.title]}>Items</Text>
      <Card padding={lg ? 18 : 16} {...(lg ? { hero: true } : null)}>
        {items.map((i) => (
          <Text key={i}>{i}</Text>
        ))}
      </Card>
    </View>
  );
}

function GlassBadge() {
  return <Text style={GLASS.badge}>New</Text>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  title: { fontSize: 20, padding: 16 },
  empty: { padding: 24 },
});

const GLASS = StyleSheet.create({
  title: { fontSize: 34, fontWeight: '700' },
  empty: { padding: 18 },
  badge: { fontSize: 12 },
});
`;

describe('classic projection', () => {
  it('a file folds to itself and has no leaks', () => {
    same(BASE, BASE);
    expect(projectionLeaks(BASE, 'probe.tsx')).toEqual([]);
  });

  it('every glass form folds back to the Classic it was written over', () => {
    same(BASE, GLASS);
    expect(projectionLeaks(GLASS, 'probe.tsx')).toEqual([]);
  });

  it('formatting, comments and import order never count', () => {
    const reformatted = BASE.replace(
      "import * as React from 'react';\nimport { StyleSheet, Text, View } from 'react-native';",
      "import { View, Text, StyleSheet } from 'react-native';\n// a comment\nimport * as React from 'react';",
    )
      .replace('root: { flex: 1 },', 'root: {\n    flex: 1,\n  },')
      .replace(
        '<Text style={styles.title}>Items</Text>',
        '<Text\n        style={styles.title}\n      >\n        Items\n      </Text>',
      );
    same(BASE, reformatted);
  });

  it('a Classic style value changed is caught, glass branches or not', () => {
    differs(
      BASE,
      BASE.replace('title: { fontSize: 20, padding: 16 }', 'title: { fontSize: 20, padding: 18 }'),
    );
    differs(
      BASE,
      GLASS.replace('title: { fontSize: 20, padding: 16 }', 'title: { fontSize: 20, padding: 18 }'),
    );
    differs(BASE, GLASS.replace('padding={lg ? 18 : 16}', 'padding={lg ? 18 : 15}'));
  });

  it('a Classic element moved, added or removed is caught', () => {
    differs(
      BASE,
      BASE.replace(
        '      <Text style={styles.title}>Items</Text>\n      <Card padding={16}>',
        '      <Card padding={16}>\n      <Text style={styles.title}>Items</Text>',
      ),
    );
    differs(BASE, BASE.replace('<Text style={styles.title}>Items</Text>', ''));
    differs(
      BASE,
      BASE.replace(
        '<Text style={styles.title}>Items</Text>',
        '<Text style={styles.title}>Items</Text><View />',
      ),
    );
  });

  it('a Classic string, prop or operator changed is caught', () => {
    differs(BASE, BASE.replace('Nothing yet', 'Nothing here'));
    differs(BASE, BASE.replace('<Card padding={16}>', '<Card padding={16} hero>'));
    differs(BASE, BASE.replace('total === 0', 'total !== 0'));
    differs(BASE, BASE.replace('items.length', '-items.length'));
    differs(BASE, BASE.replace('const { c } = useTheme();', 'let { c } = useTheme();'));
  });

  it('a glass branch put where Classic runs is caught (the classic side is what stays)', () => {
    // lg in the classic branch of a conditional is folded away: still Classic.
    same(
      BASE,
      GLASS.replace('{lg ? <SceneBackground /> : null}', '{!lg ? null : <SceneBackground />}'),
    );
    // Swapping the branches puts glass in Classic.
    differs(BASE, GLASS.replace('padding={lg ? 18 : 16}', 'padding={lg ? 16 : 18}'));
  });

  it('reports every lg the projection cannot fold', () => {
    const leaky = GLASS.replace(
      '{lg && <GlassBadge />}',
      '{lg && <GlassBadge />}<Text>{String(lg)}</Text>',
    );
    expect(projectionLeaks(leaky, 'probe.tsx').length).toBe(1);
    const passed = GLASS.replace('<GlassBadge />', '<GlassBadge look={lg} />');
    // Inside a folded branch it is gone with the branch.
    expect(projectionLeaks(passed, 'probe.tsx')).toEqual([]);
    const stray = GLASS.replace('const total =', 'const look = lg;\n  const total =');
    expect(projectionLeaks(stray, 'probe.tsx')).toEqual(['lg inside VariableDeclaration']);
  });

  it('a property that is only named lg (space.lg, { lg: 16 }) is not the look; the look read off is', () => {
    const named = 'export const a = <View style={{ padding: space.lg, ...{ lg: 16 } }} />;';
    expect(projectionLeaks(named, 'probe.tsx')).toEqual([]);
    // The look itself, read outside a branch, is still reported, however it is reached.
    const read = 'const lg = useGlass();\nexport const a = <View style={{ color: lg.c.ink }} />;';
    expect(projectionLeaks(read, 'probe.tsx')).toEqual(['lg inside PropertyAccessExpression']);
    const short = 'const lg = useGlass();\nexport const a = <View style={{ lg }} />;';
    expect(projectionLeaks(short, 'probe.tsx')).toEqual(['lg inside ShorthandPropertyAssignment']);
  });

  it('a lone glass style entry collapses the array back to the classic style', () => {
    same(
      'export const a = <View style={styles.x} />;',
      'export const a = <View style={[styles.x, lg && GLASS.x]} />;',
    );
    // A style array Classic already had keeps its other entries in order.
    same(
      'export const a = <View style={[styles.x, { flex: 1 }]} />;',
      'export const a = <View style={[styles.x, lg && GLASS.x, { flex: 1 }]} />;',
    );
    differs(
      'export const a = <View style={[styles.x, { flex: 1 }]} />;',
      'export const a = <View style={[{ flex: 1 }, lg && GLASS.x, styles.x]} />;',
    );
    // An array Classic wrote with one entry is not the same as that entry.
    differs(
      'export const a = <View style={[styles.x]} />;',
      'export const a = <View style={[styles.x, lg && GLASS.x]} />;',
    );
  });

  it('if statements on lg keep the classic arm', () => {
    same(
      'export function f() { return 1; }',
      'export function f() { if (lg) { return 2; } return 1; }',
    );
    same(
      'export function f() { return 1; }',
      'export function f() { if (lg) { return 2; } else { return 1; } }',
    );
    differs(
      'export function f() { return 1; }',
      'export function f() { if (lg) { return 2; } return 3; }',
    );
  });

  it('a hook may list lg among its dependencies; the classic list is what stays', () => {
    same(
      'export function useX(items) { return React.useMemo(() => items.length, [items]); }',
      'export function useX(items) { const lg = useGlass(); return React.useMemo(() => (lg ? 0 : items.length), [items, lg]); }',
    );
    differs(
      'export function useX(items) { return React.useMemo(() => items.length, [items]); }',
      'export function useX(items) { const lg = useGlass(); return React.useMemo(() => (lg ? 0 : items.length), [lg]); }',
    );
  });

  it('a file-local helper Classic still uses is never pruned', () => {
    differs(
      'export function f() { return g(); }\nfunction g() { return 1; }',
      'export function f() { return g(); }\nfunction g() { return 2; }',
    );
  });

  it('an element or a string in braces is that child, and a braced string prop is the quoted prop', () => {
    const base =
      'export const A = () => <View><Eyebrow>{date}</Eyebrow><Mono label="STOCK">FILTERS</Mono></View>;';
    same(
      base,
      "export const A = () => <View>{lg ? null : <Eyebrow>{date}</Eyebrow>}<Mono label={lg ? 'Stock' : 'STOCK'}>{lg ? 'Filters' : 'FILTERS'}</Mono></View>;",
    );
    // The classic words still count: a changed string or prop is caught.
    differs(
      base,
      "export const A = () => <View><Eyebrow>{date}</Eyebrow><Mono label={lg ? 'Stock' : 'STOK'}>{lg ? 'Filters' : 'FILTERS'}</Mono></View>;",
    );
    differs(
      base,
      "export const A = () => <View><Eyebrow>{date}</Eyebrow><Mono label=\"STOCK\">{lg ? 'Filters' : 'FILTER'}</Mono></View>;",
    );
    // Entities are decoded in JSX text and quoted props, never in a string:
    // the two spellings render differently and must not fold together.
    differs('export const A = () => <T>&amp;</T>;', "export const A = () => <T>{'&amp;'}</T>;");
    differs(
      'export const A = () => <T title="&amp;" />;',
      "export const A = () => <T title={'&amp;'} />;",
    );
    // An empty string child stays a child.
    differs('export const A = () => <T></T>;', "export const A = () => <T>{''}</T>;");
  });
});

describe('classicFlat: a source pin reads Classic in one spelling', () => {
  const file = 'pin.tsx';
  const glass = `
import * as React from 'react';
import { Text } from 'react-native';
import { useGlass } from '@/components/ui/glass/use-glass';
export function A({ fg }: { fg: string }) {
  const lg = useGlass();
  return (
    <Text
      style={[
        styles.label,
        lg && glassLabel(lg),
        { color: fg },
      ]}
    >
      Deny
    </Text>
  );
}
`;

  it('reads the Classic text whatever the formatting, with the glass entries folded away', () => {
    expect(classicFlat(glass, file)).toContain(
      flatNorm('<Text style={[styles.label, { color: fg }]}>Deny</Text>'),
    );
    expect(classicFlat(glass, file)).not.toContain('glassLabel');
  });

  it('still tells different Classic code apart', () => {
    expect(classicFlat(glass, file)).not.toContain(
      flatNorm('<Text style={[styles.label, { color: ink }]}>Deny</Text>'),
    );
    expect(classicFlat(glass, file)).not.toContain(
      flatNorm('<Text style={[{ color: fg }, styles.label]}>Deny</Text>'),
    );
    expect(flatNorm('a ,b')).toBe(flatNorm('a, b'));
    expect(flatNorm('[a, b,\n]')).toBe('[a,b]');
    expect(flatNorm('x - 1')).not.toBe(flatNorm('x + 1'));
  });
});
