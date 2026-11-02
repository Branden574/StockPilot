import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the bill-to line on the phone's PO screen (B56). The screen
 * imports native modules, so vitest cannot render it; the read and the line
 * live in lib/po-bill-to.ts (tested there), and these pins keep the screen
 * wired to them:
 *
 *   - the PO read takes charter_id as a plain column, never a charters embed:
 *     an embed that fails fails the whole PO read and shows "Could not load
 *     this PO", which blocks receiving; the separate read only loses a line;
 *   - the charter read starts once the header is known, runs beside the size
 *     runs and the history, and is awaited only on the success path, so the
 *     error and not-found paths stay as they were;
 *   - the line is drawn only for a PO found, under "Supplier · Status".
 */

const ROOT = path.resolve(__dirname, '../..');
/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const flat = (rel: string) =>
  codeOnly(readFileSync(path.join(ROOT, rel), 'utf8')).replace(/\s+/g, ' ');

const screen = flat('app/po/[id].tsx');
const lib = () => flat('src/lib/po-bill-to.ts');

/** The text between `start` and the next `end` after it. */
function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a, start).toBeGreaterThan(-1);
  const b = src.indexOf(end, a + start.length);
  expect(b, end).toBeGreaterThan(a);
  return src.slice(a, b + end.length);
}

const load = () =>
  between(
    screen,
    'const load = React.useCallback(async () => {',
    '}, [id, orgId, loadRunGroups, loadReceiptHistory]);',
  );

describe("the PO screen's bill-to line", () => {
  // Mutation caught: the charter embedded in the PO read.
  it('reads charter_id as a plain column of the PO, never a charters embed', () => {
    const select = between(load(), ".from('purchase_orders') .select(", ')');
    expect(select).toContain('id, po_number, status, charter_id,');
    expect(screen).not.toContain('charters!');
    expect(screen).not.toMatch(/charter:\s*charters/);
  });

  it('imports its read and its line from lib/po-bill-to', () => {
    expect(screen).toMatch(
      /import \{[^}]*\bpoBillToLine\b[^}]*\breadPoBillToCharter\b[^}]*\} from '@\/lib\/po-bill-to';/,
    );
    expect(screen).toContain('charter_id: string | null;');
  });

  it('starts the read once the header is set, and sets the line only on the success path', () => {
    const body = load();
    const setHeader = body.indexOf('setHeader({ id: r.id as string,');
    const start = body.indexOf(
      'const billToRead = readPoBillToCharter(supabase, orgId, charterId);',
    );
    expect(setHeader).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(setHeader);
    expect(body).toContain('const charterId = (r.charter_id as string | null) ?? null;');
    expect(body).toContain('charter_id: charterId, });');
    // Exactly one setBillTo in the whole screen: right before the last
    // setLoading(false) of load(), after the history. The error and the
    // not-found blocks are left as they were.
    expect(screen.match(/setBillTo\(/g)).toHaveLength(1);
    expect(body).toContain(
      'await loadReceiptHistory(); setBillTo(await billToRead); setLoading(false);',
    );
    expect(body.indexOf('setBillTo(')).toBeGreaterThan(start);
    const notFound = between(body, 'if (!po) {', 'return; }');
    expect(notFound).not.toContain('setBillTo');
    const failed = between(body, 'if (poErr || linesErr) {', 'return; }');
    expect(failed).not.toContain('setBillTo');
  });

  it('builds the line from the header id, so it never names another PO', () => {
    expect(screen).toContain(
      "const [billTo, setBillTo] = React.useState<BillToCharterRead>({ state: 'none' });",
    );
    expect(screen).toContain(
      'const billToLine = poBillToLine(header?.charter_id ?? null, billTo);',
    );
  });

  // Mutation caught: the line moved out of the found branch, or off the header.
  it('draws the line under "Supplier · Status", only for a PO found', () => {
    const found = screen.slice(screen.indexOf(') : !header ? ('));
    expect(found).toContain(
      "{header?.supplier_name ?? 'No supplier'} · {poStatusLabel(header?.status)} </Text> {billToLine ? <Text style={styles.subtitle}>{billToLine}</Text> : null} </View>",
    );
    expect(screen.match(/\{billToLine \?/g)).toHaveLength(1);
  });

  it('keeps the read module pure: no screen state, no app client', () => {
    const code = lib();
    expect(code).not.toContain('setLoadError');
    expect(code).not.toMatch(/from '\.\/supabase'/);
    expect(code).not.toMatch(/from '@\/lib\/supabase'/);
    expect(code).not.toContain('react-native');
  });
});
