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

/** Every `onPress={...}`, `onAccessibilityTap`, `onLongPress` handler, as written. */
function handlers(code: string): Set<string> {
  const out = new Set<string>();
  const text = flat(code);
  const re = /\b(onPress|onLongPress|onAccessibilityTap|onAccessibilityAction)=\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
      i += 1;
    }
    // Whitespace and trailing commas are layout, not code.
    const body = text
      .slice(start, i - 1)
      .replace(/\s+/g, '')
      .replace(/,([}\])])/g, '$1');
    out.add(`${m[1]}=${body}`);
  }
  return out;
}

/** Every literal VoiceOver name and every pushed route. */
function names(code: string): Set<string> {
  const text = flat(code);
  const out = new Set<string>();
  for (const m of text.matchAll(/accessibilityLabel="([^"]+)"/g)) out.add(`label:${m[1]}`);
  for (const m of text.matchAll(/router\.(?:push|replace)\(\s*'([^']+)'/g))
    out.add(`route:${m[1]}`);
  for (const m of text.matchAll(/pathname: '([^']+)'/g)) out.add(`route:${m[1]}`);
  return out;
}

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
