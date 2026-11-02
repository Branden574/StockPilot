/**
 * RECURRENCE GUARD: no screen says StockPilot sends a purchase order to a
 * supplier (B105).
 *
 * Recurring POs and Automatic reordering offered "Auto-send to supplier" and
 * "Auto-send the PO to the supplier", and the template list and the phone's
 * pill called the mode "Auto-send". But the mode only marks the purchase
 * order as ordered (updateStatus 'ordered', the change the draft page's Mark
 * as ordered button makes), and nothing in StockPilot sends a purchase order
 * to a supplier: the ordered event reaches only the accounting connectors. A
 * member who relied on the words believed the supplier had the order, while
 * the supplier never heard of it. The mode is now "Mark as ordered
 * automatically" ("Auto-order" in the lists).
 *
 * This guard reads every string literal, template literal and piece of JSX
 * text (test/copy-in-source.ts, the reader the other copy guards share) in
 * the web app (apps/web/src), the phone (apps/mobile/src and apps/mobile/app)
 * and the shared core (packages/core/src), tests, mocks and fixtures left
 * out, for the mode's old name and for a purchase order said to be sent to a
 * supplier by anyone but the reader. The reader sending it ("Send them the
 * purchase order yourself.", "every PO PDF you send to suppliers") and the
 * disclaimer ("Nothing is sent to the supplier.") are allowed.
 *
 * IF THIS FAILS: say what happens. The purchase order is marked as ordered,
 * and the person sends it to the supplier. A What's New entry that quotes the
 * old words on purpose (one that says they changed, or a published one) is
 * skipped by its id in QUOTES_OLD_WORDING.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { copyInSource } from '@/test/copy-in-source';

const REPO = path.resolve(__dirname, '../../../../..');
/** The trees whose copy people read: the web app, the phone and core. */
const SCANNED = ['apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages/core/src'];

/** How the copy said a purchase order goes to a supplier. */
const SENT_TO_SUPPLIER: readonly { name: string; re: RegExp }[] = [
  // The mode's old name, which says StockPilot sends the purchase order.
  { name: '"Auto-send"', re: /\bauto-?sen(?:d|ds|t|ding)\b/i },
  // Said of the purchase order, as done for the reader: "is sent to the
  // supplier", "will be emailed to your vendor". "Nothing is sent to the
  // supplier." is the disclaimer, and "are not sent" never matches.
  {
    name: '"is sent to the supplier"',
    re: /(?<!\b(?:nothing|never|not)\s)\b(?:is|are|was|were|be|been|being|gets?|got)\s+(?:sent|emailed|submitted)\s+to\s+(?:the\s+|your\s+|a\s+|each\s+|its\s+|their\s+)?(?:suppliers?|vendors?)\b/i,
  },
  // Said as something StockPilot does: "sends it to the supplier".
  {
    name: '"sends it to the supplier"',
    re: /\b(?:sends|emails|submits)\s+(?:it|them|the\s+(?:po|purchase\s+orders?)|pos?|purchase\s+orders?)\s+to\s+(?:the\s+|your\s+|a\s+|each\s+|its\s+|their\s+)?(?:suppliers?|vendors?)\b/i,
  },
  // A label or a status: "Send to supplier", "Sent to supplier".
  {
    name: '"Sent to supplier" as a label',
    re: /^\s*sen[dt]\s+(?:it\s+|them\s+)?to\s+(?:the\s+|your\s+|a\s+)?(?:suppliers?|vendors?)\b/i,
  },
];

/**
 * The What's New entries that quote the old words on purpose, by id. A
 * published entry is kept as it was published: recurring-run-says-why
 * (small-fixes-8-2026-10, 2026-10-31) names "a template set to Auto-send",
 * the mode's name then. Only the entry's object in the registry is skipped.
 */
const REGISTRY = 'apps/web/src/lib/releases/registry.ts';
const QUOTES_OLD_WORDING = new Set(['recurring-run-says-why']);

const rel = (file: string) => path.relative(REPO, file).split(path.sep).join('/');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__mocks__' || name === '__fixtures__') continue;
      out.push(...sourceFiles(full));
    } else if (
      /\.tsx?$/.test(name) &&
      !/\.(?:test|spec)\.tsx?$/.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** The `id` of an object literal, when it is a plain string. */
function objectId(node: ts.ObjectLiteralExpression): string | null {
  for (const p of node.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === 'id' &&
      ts.isStringLiteral(p.initializer)
    ) {
      return p.initializer.text;
    }
  }
  return null;
}

/** Every piece of copy in a file that says a purchase order goes to a supplier. */
function sentToSupplierIn(relPath: string, text: string): string[] {
  const copy = copyInSource(
    relPath,
    text,
    relPath === REGISTRY
      ? {
          skipObject: (node) => {
            const id = objectId(node);
            return Boolean(id && QUOTES_OLD_WORDING.has(id));
          },
        }
      : {},
  );
  const hits: { line: number; text: string; name: string; start: number; end: number }[] = [];
  for (const { line, text: words, start, end } of copy) {
    for (const { name, re } of SENT_TO_SUPPLIER) {
      if (re.test(words)) hits.push({ line, text: words, name, start, end });
    }
  }
  // A JSX element's text holds its children's: report the innermost, the
  // hit no other hit of the same phrase sits inside.
  const innermost = hits.filter(
    (h) => !hits.some((o) => o !== h && o.name === h.name && o.start >= h.start && o.end <= h.end),
  );
  return [
    ...new Set(innermost.map((h) => `${relPath}:${h.line} ${h.name}: ${h.text.slice(0, 160)}`)),
  ];
}

describe('no screen says StockPilot sends a purchase order to a supplier', () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(path.join(REPO, dir)));

  it('reads the web app, the phone and core, and the entries it skips are still there', () => {
    const paths = files.map(rel);
    expect(paths).toEqual(
      expect.arrayContaining([
        'apps/web/src/components/po/recurring-templates-panel.tsx',
        'apps/web/src/components/settings/auto-reorder-panel.tsx',
        'apps/web/src/server/services/recurring-pos.ts',
        'apps/web/src/app/api/cron/auto-reorder/route.ts',
        'apps/mobile/app/(drawer)/recurring-pos.tsx',
        'packages/core/src/orders/shortfall-po.ts',
        REGISTRY,
      ]),
    );
    expect(paths.some((p) => /\.test\.tsx?$/.test(p))).toBe(false);
    const registry = readFileSync(path.join(REPO, REGISTRY), 'utf8');
    for (const id of QUOTES_OLD_WORDING) expect(registry).toContain(`id: '${id}'`);
  });

  it('no string literal, template literal or JSX text says a purchase order is sent to a supplier', () => {
    const found = files.flatMap((f) => sentToSupplierIn(rel(f), readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  }, 60_000);

  it('would catch the words the modes used, and lets the reader send it', () => {
    const caught = (text: string) =>
      sentToSupplierIn(
        'apps/web/src/components/po/some-panel.tsx',
        `export const A = ${JSON.stringify(text)};`,
      );
    for (const text of [
      'Auto-send to supplier',
      'Auto-send the PO to the supplier',
      'Auto-send',
      'POs above this cap are drafted for review instead of auto-sent.',
      'Opt-in auto-send requires a $ cap.',
      'The purchase order is sent to the supplier.',
      'It will be emailed to your vendor.',
      'StockPilot sends the PO to the supplier.',
      'Sent to supplier',
    ]) {
      expect(caught(text), text).not.toEqual([]);
    }
    for (const text of [
      'Mark as ordered automatically',
      'Auto-order',
      'Nothing is sent to the supplier. Send them the purchase order yourself.',
      'Drafts are not sent to suppliers or emailed.',
      'Printed at the bottom of every PO PDF you send to suppliers.',
      'Draft a PO with line items, send it to a supplier, then receive against it.',
      'The invite email could not be sent.',
    ]) {
      expect(caught(text), text).toEqual([]);
    }
    // JSX text is read the way a person sees it, and a comment is not copy.
    const jsx = [
      'export const B = () => (',
      '  <p>',
      '    Auto-send{" "}',
      '    to supplier',
      '  </p>',
      ');',
      '// Auto-send to supplier: a comment',
    ].join('\n');
    expect(sentToSupplierIn('apps/web/src/components/po/probe.tsx', jsx)).toEqual([
      'apps/web/src/components/po/probe.tsx:2 "Auto-send": Auto-send to supplier',
    ]);
  });
});
