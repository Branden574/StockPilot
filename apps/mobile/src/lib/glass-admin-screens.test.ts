import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { printClassic } from './__fixtures__/classic-projection';

/**
 * THE ADMIN, SETTINGS AND HELP SCREENS IN LIQUID GLASS (stage 4, native-admin
 * lane) keep every action, name and route Classic has, and add none.
 *
 * Classic itself is proved unchanged by the classic-projection pins
 * (appearance/glass-classic-pins.test.ts): each screen folded to Classic is
 * its file before Liquid Glass. This proves the other direction for the glass
 * branches: comparing the whole file (Classic and glass) with its Classic
 * projection, the glass code introduces no touch handler, VoiceOver name,
 * role or route that Classic does not already have (plan 8.5: glass exposes
 * no action classic lacks), and each list screen draws its rows through the
 * same row component in both looks.
 */
const ROOT = path.resolve(__dirname, '../..');

const SCREENS = [
  'app/(drawer)/admin/audit.tsx',
  'app/(drawer)/admin/bins.tsx',
  'app/(drawer)/admin/charters.tsx',
  'app/(drawer)/admin/index.tsx',
  'app/(drawer)/admin/uom-conversions.tsx',
  'app/(drawer)/admin/users.tsx',
  'app/(drawer)/admin/vendor-mappings.tsx',
  'app/(drawer)/admin/warehouses.tsx',
  'app/(drawer)/ai.tsx',
  'app/(drawer)/notifications.tsx',
  'app/(drawer)/settings.tsx',
  'app/(drawer)/settings/appearance.tsx',
  'app/(drawer)/settings/change-email.tsx',
  'app/(drawer)/settings/customize-tabs.tsx',
  'app/(drawer)/settings/integrations.tsx',
  'app/(drawer)/settings/rejected-work.tsx',
  'app/(drawer)/support.tsx',
  'app/(drawer)/team.tsx',
  'app/(drawer)/zendesk.tsx',
  'app/ai/chat.tsx',
  'app/zendesk/web.tsx',
] as const;

/**
 * Glass-only names, each paired with the Classic element it duplicates on the
 * same screen (the native twin of apps/web/tests/e2e/appearance/
 * glass-only-allowlist.json). None today: every glass branch in this lane
 * reuses Classic's handlers and names.
 */
const GLASS_ONLY: Readonly<Record<string, readonly string[]>> = {};

const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

/** One printing for both sides (the TypeScript printer, comments dropped), so only code is compared. */
const printer = ts.createPrinter({ removeComments: true });
const printed = (code: string, file: string) =>
  printer.printFile(
    ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  );
const flat = (s: string) => s.replace(/\s+/g, ' ');

const HANDLER_PROPS = new Set([
  'onPress',
  'onLongPress',
  'onAccessibilityTap',
  'onAccessibilityAction',
]);
const ROUTE_PROPS = new Set(['pathname', 'href']);

/** Whitespace and trailing commas are layout, not code. */
const squash = (s: string) => s.replace(/\s+/g, '').replace(/,([}\])])/g, '$1');

/**
 * Every touch handler, VoiceOver name and route in a file, wherever it is
 * written: a JSX attribute (`onPress={...}`, `accessibilityLabel="..."` or
 * `accessibilityLabel={`...`}`), an object property handed to a part
 * (`action={{ onPress: ..., accessibilityLabel: ... }}`) or a shorthand one
 * (`{ onPress }`), and `router.push` / `router.replace` / `pathname` /
 * `href`. A literal name is keyed by its words, anything else by its code,
 * so a JSX attribute and an object property with the same value are the
 * same entry.
 */
function inventory(code: string, file: string): { handlers: Set<string>; names: Set<string> } {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handlerSet = new Set<string>();
  const nameSet = new Set<string>();
  const valueOf = (e: ts.Expression): string => {
    let x = e;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
    return squash(x.getText(sf));
  };
  const record = (prop: string, value: string) => {
    if (HANDLER_PROPS.has(prop)) handlerSet.add(`${prop}=${value}`);
    else if (prop === 'accessibilityLabel') nameSet.add(`label:${value}`);
    else if (ROUTE_PROPS.has(prop)) nameSet.add(`route:${value}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const init = node.initializer;
      const value = !init
        ? 'true'
        : ts.isStringLiteral(init)
          ? init.text
          : ts.isJsxExpression(init) && init.expression
            ? valueOf(init.expression)
            : '';
      record(node.name.getText(sf), value);
    } else if (ts.isPropertyAssignment(node)) {
      if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        record(node.name.text, valueOf(node.initializer));
    } else if (ts.isShorthandPropertyAssignment(node)) {
      record(node.name.text, node.name.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['push', 'replace', 'navigate'].includes(node.expression.name.text) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'router' &&
      node.arguments[0] &&
      !ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      nameSet.add(`route:${valueOf(node.arguments[0])}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { handlers: handlerSet, names: nameSet };
}

/** Every touch handler, as written, in any position. */
const handlers = (code: string, file = 'x.tsx') => inventory(code, file).handlers;

/** Every VoiceOver name (literal or computed) and every pushed route, in any position. */
const names = (code: string, file = 'x.tsx') => inventory(code, file).names;

/** What the file adds over its Classic projection: handlers and names glass alone has. */
function glassOnly(raw: string, file: string): { handlers: string[]; names: string[] } {
  const src = printed(raw, file);
  const classic = printed(printClassic(raw, file), file);
  const ch = handlers(classic, file);
  const cn = names(classic, file);
  return {
    handlers: [...handlers(src, file)].filter((h) => !ch.has(h)),
    names: [...names(src, file)].filter((n) => !cn.has(n)),
  };
}

describe('the parity inventory sees an action in every form it can be written in', () => {
  const FILE = 'sample.tsx';
  const sample = (glass: string, classic = '<View />') => `
import { useGlass } from '@/components/ui/glass/use-glass';
export function Sample({ row }: { row: { id: string } }) {
  const lg = useGlass();
  return lg ? ${glass} : ${classic};
}`;

  it('an action handed to a lane part as object properties (GlassSyncRecord action)', () => {
    const out = glassOnly(
      sample(
        "<GlassSyncRecord action={{ label: 'Retry', accessibilityLabel: 'Retry', onPress: () => retryRow(row) }} />",
      ),
      FILE,
    );
    expect(out.handlers).toEqual(['onPress=()=>retryRow(row)']);
    expect(out.names).toEqual(['label:Retry']);
  });

  it('a shorthand handler and a templated name', () => {
    const out = glassOnly(
      sample('<Pressable onPress={onRetry} accessibilityLabel={`Retry ${row.id}`} />'),
      FILE,
    );
    expect(out.handlers).toEqual(['onPress=onRetry']);
    expect(out.names).toEqual(['label:`Retry${row.id}`']);
    expect(glassOnly(sample('<Part action={{ onPress }} />'), FILE).handlers).toEqual([
      'onPress=onPress',
    ]);
  });

  it('a route pushed by a template or written as href', () => {
    const out = glassOnly(
      sample('<Link href="/settings/x" onPress={() => router.push(`/a/${row.id}`)} />'),
      FILE,
    );
    expect(out.names.sort()).toEqual(['route:/settings/x', 'route:`/a/${row.id}`']);
  });

  it('the same handler and name written as a JSX attribute in Classic and as a property in glass are one entry', () => {
    const out = glassOnly(
      sample(
        '<Part action={{ accessibilityLabel: `Discard ${row.id}`, onPress: () => confirmDiscard(row) }} />',
        '<Pressable onPress={() => confirmDiscard(row)} accessibilityLabel={`Discard ${row.id}`} />',
      ),
      FILE,
    );
    expect(out).toEqual({ handlers: [], names: [] });
  });
});

describe('the lane’s glass parts only forward the handlers and names their callers hand them', () => {
  // admin.tsx is drawn only in Liquid Glass, so it has no Classic projection
  // to compare with; its handlers and names are pinned instead, and the
  // values its callers pass are compared on each screen above.
  const file = 'src/components/ui/glass/screens/admin.tsx';
  const code = printed(read(file), file);

  it('the one handler is the record action’s own', () => {
    expect([...handlers(code, file)]).toEqual(['onPress=action.onPress']);
  });

  it('the names are the record action’s own and the section head’s title with its count', () => {
    expect([...names(code, file)].sort()).toEqual(
      ['label:`${title},${count}`', 'label:action.accessibilityLabel'].sort(),
    );
  });
});

describe.each(SCREENS)('%s in Liquid Glass', (file) => {
  const raw = read(file);
  const src = printed(raw, file);
  const classic = printed(printClassic(raw, file), file);

  it('reads the look once per component as const lg = useGlass()', () => {
    expect(raw).toContain("import { useGlass } from '@/components/ui/glass/use-glass';");
    expect(raw).toMatch(/const lg = useGlass\(\);/);
  });

  it('adds no touch handler Classic does not have', () => {
    const glassOnly = [...handlers(src)].filter((h) => !handlers(classic).has(h));
    expect(glassOnly).toEqual([]);
  });

  it('adds no VoiceOver name or route Classic does not have', () => {
    const allowed = new Set(GLASS_ONLY[file] ?? []);
    const glassOnly = [...names(src)].filter((n) => !names(classic).has(n) && !allowed.has(n));
    expect(glassOnly).toEqual([]);
  });

  it('keeps every name, route and handler Classic has (nothing is moved into a Classic-only branch)', () => {
    // The classic projection is a subset of the file by construction; this
    // guards the reverse slip, a Classic element rewritten so that only its
    // glass twin carries the handler.
    for (const h of handlers(classic)) expect(handlers(src)).toContain(h);
    for (const n of names(classic)) expect(names(src)).toContain(n);
  });
});

describe('the list screens draw each row once, through the same row component, in both looks', () => {
  const LISTS: [string, string][] = [
    ['app/(drawer)/admin/audit.tsx', 'AuditCard'],
    ['app/(drawer)/admin/bins.tsx', 'BinCard'],
    ['app/(drawer)/admin/charters.tsx', 'CharterCard'],
    ['app/(drawer)/admin/uom-conversions.tsx', 'ConversionCard'],
    ['app/(drawer)/admin/users.tsx', 'UserCard'],
    ['app/(drawer)/admin/vendor-mappings.tsx', 'MappingCard'],
    ['app/(drawer)/admin/warehouses.tsx', 'WarehouseCard'],
    ['app/(drawer)/notifications.tsx', 'NotifRow'],
    ['app/(drawer)/team.tsx', 'MemberCard'],
  ];

  it.each(LISTS)('%s: the glass rows join into one grouped surface around %s', (file, row) => {
    const code = flat(read(file));
    // Glass: the row inside the joined group row, counted over the list it is in.
    expect(code).toMatch(
      new RegExp(
        `lg \\? \\((\\w+), i\\) => \\( <GlassJoinedRow lg=\\{lg\\} index=\\{i\\} count=\\{rows\\.length\\}> <${row}\\b`,
      ),
    );
    // Classic: the row alone, as before.
    expect(code).toMatch(new RegExp(`: \\((\\w+)\\) => (\\( )?<${row}\\b`));
  });

  it.each(LISTS.filter(([, row]) => row !== 'NotifRow'))(
    '%s: the row’s own card is bare inside the joined row',
    (file) => {
      expect(flat(read(file))).toMatch(
        /<Card padding=\{\d+\} style=\{lg \? GLASS_BARE_CARD : undefined\}>/,
      );
    },
  );
});

describe('the notification detail is a centred glass dialog', () => {
  const code = flat(read('app/(drawer)/notifications.tsx'));

  it('tints the page with the glass scrim and draws the card on the overlay glass at the dialog radius', () => {
    expect(code).toContain('lg && glassScrim(lg),');
    expect(code).toMatch(
      /<Card padding=\{18\} style=\{lg \? GLASS_DIALOG_CARD : undefined\}> \{lg \? <GlassSheetBackdrop radius=\{GLASS_DIALOG_RADIUS\} \/> : null\}/,
    );
  });

  it('keeps Close on the scrim and on the card', () => {
    expect(code.match(/accessibilityLabel="Close"/g)?.length).toBe(2);
  });
});

describe('Unsent work follows iOS-Sync for the parts that exist', () => {
  const code = flat(read('app/(drawer)/settings/rejected-work.tsx'));

  it('names each section as the board does, with its count', () => {
    expect(code).toContain('title="Queued by another account" count={held.length}');
    expect(code).toMatch(/title="Not confirmed" count=\{unconfirmedRows\.length\} tone="warn"/);
    expect(code).toMatch(/title="Never sent" count=\{neverSentRows\.length\} tone="danger"/);
  });

  it('keeps Discard for work held for another account, with its words and its confirmation', () => {
    expect(code).toContain("label: 'Discard',");
    expect(code).toContain(
      'accessibilityLabel: `Discard ${pendingActionLabel(row.kind)} queued by another account`',
    );
    expect(code).toContain('onPress: () => confirmDiscard(row),');
  });

  it('builds no per-row Remove and no combined Sync status (both [Proposed] on the board)', () => {
    expect(code).not.toMatch(/label: 'Remove'/);
    expect(code).not.toMatch(/Retry now|Reconnect/);
  });

  it('keeps Clear this list and the retention line', () => {
    expect(code).toContain('Clear this list');
    expect(code).toContain('These records are kept for ${REJECTED_RETENTION_DAYS} days');
  });
});

describe('the Unsent work parts match iOS-Sync’s values (sp.css:707, 715, 716, 719, 1049)', () => {
  const admin = flat(read('src/components/ui/glass/screens/admin.tsx'));
  const unsent = flat(read('app/(drawer)/settings/rejected-work.tsx'));

  it('the tinted count pill has the .ios-pill’s 12 at the sides, at the board’s 24 height', () => {
    expect(admin).toContain(
      "syncPill: { minHeight: 24, borderRadius: 12, paddingHorizontal: 12, justifyContent: 'center' },",
    );
  });

  it('Discard is the gray .ios-btn: 22 at the sides, its words in ink', () => {
    expect(admin).toMatch(
      /recordButton: \{ minHeight: 44, borderRadius: 22, paddingHorizontal: 22,/,
    );
    expect(admin).toContain(
      'style={[lg.font.displaySemi, styles.recordButtonText, { color: lg.c.ink }]}',
    );
    expect(admin).not.toContain('recordButtonText, { color: lg.c.critText }');
  });

  it('the retention line is the board’s centred .ios-sub (GlassSubline: 13/18, ink-2)', () => {
    expect(unsent).toContain(
      '<GlassSubline style={GLASS_RETENTION_LINE}> {`These records are kept for ${REJECTED_RETENTION_DAYS} days, then removed automatically.`} </GlassSubline>',
    );
    expect(unsent).toContain(
      "const GLASS_RETENTION_LINE = { marginTop: 18, marginHorizontal: 4, textAlign: 'center' } as const;",
    );
    expect(unsent).not.toContain('glassRowSub');
  });

  it('a section head is one VoiceOver element, the heading with its count, as Classic’s eyebrow reads', () => {
    expect(admin).toContain(
      '<View style={styles.syncHead} accessible accessibilityRole="header" accessibilityLabel={`${title}, ${count}`} >',
    );
  });
});

describe('a grouped card whose rows fill on press clips them to its corners', () => {
  it('GLASS_PAGE.group is the .ios-group’s overflow hidden', () => {
    expect(flat(read('src/components/ui/glass/screens/admin.tsx'))).toContain(
      "group: { overflow: 'hidden' },",
    );
  });

  it.each([
    ['app/(drawer)/settings.tsx', 1],
    ['app/(drawer)/settings/customize-tabs.tsx', 1],
  ] as const)('%s: the section card clips its rows in glass', (file, n) => {
    const code = flat(read(file));
    expect(
      code.match(
        /<Card padding=\{0\} style=\{lg \? GLASS_PAGE\.group : undefined\}> \{children\} <\/Card>/g,
      )?.length,
    ).toBe(n);
    expect(code).toContain("? { backgroundColor: pressed ? lg.ios.fill : 'transparent' }");
  });

  it('app/(drawer)/settings/appearance.tsx: the Design and Theme cards clip their choices in glass', () => {
    const code = flat(read('app/(drawer)/settings/appearance.tsx'));
    expect(
      code.match(
        /<Card padding=\{0\} style=\{lg \? \[GLASS_PAGE\.group, \{ marginTop: 8 \}\] : \{ marginTop: 10 \}\}>/g,
      )?.length,
    ).toBe(2);
  });
});

describe('Dynamic Type caps take the glass size as their base (theme.ts GLASS_TYPE note)', () => {
  const primitives = flat(read('src/components/ui/glass/primitive-styles.ts'));

  it('integrations: the detail label is capped from glassEyebrow’s 12', () => {
    expect(primitives).toMatch(
      /export const glassEyebrow = cached\(\(lg\): TextStyle => \(\{ \.\.\.lg\.font\.displaySemi, fontSize: 12,/,
    );
    const code = flat(read('app/(drawer)/settings/integrations.tsx'));
    expect(code).toContain('maxFontSizeMultiplier={capTo(lg ? 12 : 9.5, TYPE_CEILING.chrome)}');
    expect(code).toContain(
      'style={lg ? [glassEyebrow(lg), { flexShrink: 1 }] : { flexShrink: 1 }}',
    );
  });

  it('support: the category chips are capped from glassChipLabel’s 15', () => {
    expect(primitives).toMatch(
      /export function glassChipLabel\(lg: GlassLook, active: boolean\): TextStyle \{ return \{ \.\.\.lg\.font\.displaySemi, fontSize: 15,/,
    );
    const code = flat(read('app/(drawer)/support.tsx'));
    expect(code).toContain('const GLASS_CHIP_CAP = capTo(15, TYPE_CEILING.control);');
    expect(code).toContain(
      'lg && glassChipLabel(lg, selected), ]} maxFontSizeMultiplier={lg ? GLASS_CHIP_CAP : CHIP_CAP}',
    );
  });

  it('AI chat: the 17pt glass nav title is capped as GlassNavTitle is', () => {
    const code = flat(read('app/ai/chat.tsx'));
    expect(code).toContain('const GLASS_CHAT_TITLE = { fontSize: 17,');
    expect(code).toContain(
      "accessibilityRole={lg ? 'header' : undefined} maxFontSizeMultiplier={lg ? capTo(17, TYPE_CEILING.chrome) : undefined}",
    );
  });
});

describe('the deep-link shims and the link rewrite are untouched by this lane', () => {
  it('no shim under app/dashboard and no +native-intent reads the look', () => {
    for (const f of [
      'app/dashboard/cycle-counts/[id].tsx',
      'app/dashboard/inventory/[id].tsx',
      'app/dashboard/orders/[id].tsx',
      'app/dashboard/orders/manage-items.tsx',
      'app/dashboard/orders/new.tsx',
      'app/dashboard/purchase-orders/[id].tsx',
      'app/dashboard/reports/book-order-totals.tsx',
      'app/dashboard/returns/[id].tsx',
      'app/+native-intent.ts',
    ]) {
      expect(read(f), f).not.toMatch(/useGlass|liquid-glass|components\/ui\/glass/);
    }
  });
});
