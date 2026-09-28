import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TOUCHABLE_TAG,
  attrText,
  parseTsx,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';

/**
 * WIRING PINS for the order screen's load, its readiness (F2-1) and its
 * stock-dependent actions. The screen imports native modules, so vitest
 * cannot render it; the decisions live in lib/order-readiness.ts (tested
 * there) and in core (readiness, readiness-copy, order-stock-gates), and
 * these pins keep the screen and the two readiness components wired to them.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const screen = readFileSync(path.resolve(__dirname, '../../app/order/[id].tsx'), 'utf8');
const summary = readFileSync(
  path.resolve(__dirname, '../components/order-readiness-summary.tsx'),
  'utf8',
);
const lineCard = readFileSync(
  path.resolve(__dirname, '../components/order-line-readiness.tsx'),
  'utf8',
);
const digitalPick = readFileSync(path.resolve(__dirname, '../components/digital-pick.tsx'), 'utf8');

/** Source with comments stripped, so a comment naming what the code avoids
 *  cannot trip a negative pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const LOAD_END =
  '}, [orgId, id, loadAttachments, offline, userId, role, rpApprove, rpItems, rpBuy]);';

/** The body of the screen's `load` callback. */
function loadBody(): string {
  const start = screen.indexOf('const load = React.useCallback(async () => {');
  expect(start).toBeGreaterThan(-1);
  const end = screen.indexOf(LOAD_END, start);
  expect(end).toBeGreaterThan(start);
  return screen.slice(start, end);
}

describe('order screen: a failed header or lines read is a load error, not an order', () => {
  it('binds both errors and stops before building an order from them', () => {
    const body = loadBody();
    expect(body).toContain(
      'const { data, error: headerError, status: headerStatus } = await supabase',
    );
    expect(body).toContain(
      'const { data: lineRows, error: linesError, status: linesStatus } = await supabase',
    );
    // EITHER error is a failure (the lines one is the one that used to show
    // "This order has no items yet." with every action still offered), and
    // its text is never empty (readErrorMessage): an empty gateway error body
    // would otherwise fall through to "Order not found.".
    expect(body).toMatch(
      /const readFailure = headerError\s*\? readErrorMessage\(headerError, headerStatus\)\s*: linesError\s*\? readErrorMessage\(linesError, linesStatus\)\s*: null;/,
    );
    const failure = body.indexOf('if (readFailure !== null) {');
    expect(failure).toBeGreaterThan(-1);
    // Nothing is awaited after the failure is noticed (no readiness, no
    // returns, no attachments): the branch sets the error and returns.
    const branch = body.slice(failure, body.indexOf('return;\n    }', failure));
    expect(branch).toContain('setOrder(null);');
    expect(branch).toContain('setLoadError(readFailure);');
    expect(branch).not.toContain('await ');
    expect(failure).toBeLessThan(body.indexOf("from('returns')"));
    expect(failure).toBeLessThan(body.indexOf('await readinessRead'));
  });

  it('every load that completes sets the error flag: cleared on success, so it never sticks', () => {
    // Cleared at the END of a successful load, not the start: clearing first
    // would flash "Order not found." over the error screen while a retry runs.
    const body = loadBody();
    expect(body).toMatch(
      /let shown: OrderHeader \| null = null;\s*setLoadError\(null\);\s*if \(!data\) setOrder\(null\);\s*if \(data\) \{/,
    );
  });

  it('renders the error with a guarded Try again instead of "Order not found."', () => {
    // `!== null`, not truthiness: the error screen shows for ANY failure.
    expect(screen).toMatch(/\) : !order && loadError !== null \? \(/);
    expect(screen).toContain('Could not load this <Em>order.</Em>');
    // The error branch comes BEFORE the not-found branch.
    expect(screen.indexOf('!order && loadError !== null ?')).toBeLessThan(
      screen.indexOf('Order not <Em>found.</Em>'),
    );
    expect(screen).toMatch(/async function retryLoad\(\) \{\s*if \(retrying\) return;/);
    const tries =
      screen.match(/onPress=\{\(\) => void retryLoad\(\)\}\s*disabled=\{retrying\}/g) ?? [];
    expect(tries.length).toBe(2); // the load error and the stock-check notice
    // Readiness's Check again / Try again runs the same guarded reload.
    expect(screen).toContain('checking={retrying}');
    expect(screen).toContain('onCheckAgain={() => void retryLoad()}');
  });

  it('reads the lines in (created_at, id) order, the order readiness numbers them in', () => {
    expect(loadBody()).toMatch(
      /\.eq\('order_request_id', id\)\s*\.order\('created_at', \{ ascending: true \}\)\s*\.order\('id', \{ ascending: true \}\);/,
    );
  });
});

describe('order screen: readiness is read alongside the order (F2-1)', () => {
  const body = () => codeOnly(loadBody());

  // Mutation caught: starting the read after the lines read (serial), or
  // awaiting it before the failure check.
  it('starts after the header (status and requester known) and before the lines read; awaited after the failure check', () => {
    const b = body();
    const header = b.indexOf("from('order_requests')");
    const start = b.indexOf(
      'Promise.all([readOrderReadiness(supabase, id), readOrgTimeZone(supabase, orgId)])',
    );
    const lines = b.indexOf("from('order_request_lines')");
    expect(header).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(header);
    expect(start).toBeLessThan(lines);
    expect(b.indexOf('await readinessRead')).toBeGreaterThan(
      b.indexOf('if (readFailure !== null) {'),
    );
  });

  it('reads only for the readiness audience or a manager, at a to_pick status', () => {
    const b = body();
    expect(b).toMatch(
      /shouldReadReadiness\(\{\s*status: \(headerForReadiness\.status as string \| null\) \?\? null,\s*audience: orderReadinessAudience\(\s*\{ canApproveOrders: rpApprove, canUpdateItems: rpItems, canManagePurchaseOrders: rpBuy \},\s*userId,\s*\(headerForReadiness\.requester_user_id as string \| null\) \?\? null,\s*\),\s*role,\s*\}\)/,
    );
    // The viewer's permissions are load's dependencies (three booleans that
    // change only with an override), never a ref read in a render-time path.
    expect(screen).toMatch(
      /const \{\s*canApproveOrders: rpApprove,\s*canUpdateItems: rpItems,\s*canManagePurchaseOrders: rpBuy,\s*\} = readinessPermissionsFor\(role, permissions\);/,
    );
    expect(codeOnly(loadBody())).not.toMatch(/Ref\.current/);
  });

  // Mutation caught: dropping reconcileReadiness (a status or line set that
  // moved between the reads would show one order's facts on another).
  it('checks the answer describes the order on screen', () => {
    expect(body()).toMatch(
      /reconcileReadiness\(readinessAnswer\[0\], \{\s*status: [^\n]*,\s*lineIds: rows\.map\(\(l\) => l\.id\),\s*\}\)/,
    );
    expect(body()).toMatch(/readiness,\s*receivedAt: new Date\(\)\.toISOString\(\),/);
  });

  it('takes the org zone from either read', () => {
    expect(body()).toContain('orgTimezone = orgTimezone ?? readinessAnswer?.[1] ?? null;');
  });

  it('reads again when the audience changes (an override landed after the first read)', () => {
    expect(LOAD_END).toContain('userId, role, rpApprove, rpItems, rpBuy');
  });
});

describe('order screen: Approve partial and Resume come from readiness through core', () => {
  it('no longer reads stock itself, and the old loader is gone', () => {
    const code = codeOnly(screen);
    expect(code).not.toContain('loadOrderStockCheck');
    expect(code).not.toContain('order-stock-check');
    expect(code).not.toContain(".in('id', itemIds)");
    expect(code).not.toContain(".from('stock_reservations')");
    expect(code).not.toContain('order.isShortStock');
    expect(code).not.toContain('order.hasFulfillableStock');
    expect(existsSync(path.resolve(__dirname, 'order-stock-check.ts'))).toBe(false);
  });

  it('gates both actions on core orderStockGates, disabled (not hidden, not zeroed) when the check failed', () => {
    expect(screen).toContain(
      'const stockCheck = orderStockCheckFor(st, order?.readiness ?? null);',
    );
    expect(screen).toContain("const stockGates = orderStockGates(st ?? '', stockCheck);");
    expect(screen).toMatch(/import \{[^}]*\borderStockGates,[^}]*\} from '@stockpilot\/core';/);
    expect(screen).toMatch(
      /stockGates\.approvePartial !== 'hidden'\s*\? actionBtn\(\s*'Approve partial',[\s\S]*?stockGates\.approvePartial === 'disabled',\s*stockGates\.notice,\s*\)/,
    );
    expect(screen).toMatch(
      /stockGates\.resume === 'waiting' \? \(\s*<Body[^>]*>\s*Resume unlocks when owed items are back in stock\./,
    );
    expect(screen).toMatch(
      /'Resume fulfillment',[\s\S]*?stockGates\.resume === 'disabled',\s*stockGates\.notice,\s*\)/,
    );
    // The notice renders in both branches.
    expect(screen.match(/\{stockNotice\}/g)?.length).toBe(2);
  });

  it('says under Approve when a strict Approve would be refused (core approveShortNotice)', () => {
    expect(screen).toContain('const approveNotice = approveShortNotice(stockCheck);');
    const approve = screen.indexOf("actionBtn('Approve', 'approve',");
    const notice = screen.indexOf('{approveNotice ? (');
    expect(approve).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(approve);
    expect(notice).toBeLessThan(screen.indexOf("'Approve partial',"));
  });

  it('a disabled action button really is disabled', () => {
    expect(screen).toContain('disabled={acting !== null || disabled}');
  });
});

describe('order screen: what readiness shows, and to whom', () => {
  it('the audience is core readinessAudience; closed and picked orders show nothing', () => {
    expect(screen).toMatch(
      /const readinessAudienceNow = orderReadinessAudience\(\s*\{ canApproveOrders: rpApprove, canUpdateItems: rpItems, canManagePurchaseOrders: rpBuy \},\s*userId,\s*order\?\.requesterUserId \?\? null,\s*\);/,
    );
    expect(screen).toMatch(
      /const readinessShown =\s*order !== null &&\s*order\.readiness !== null &&\s*readinessAudienceNow !== 'none' &&\s*orderReadinessPhase\(order\.status\) === 'to_pick';/,
    );
    expect(screen).toContain(
      "const showLineReadiness = readinessShown && readinessAudienceNow === 'full';",
    );
  });

  it('the roll-up sits above the lines; each line readiness sits under its row, never inside it', () => {
    const summaryAt = screen.indexOf('<OrderReadinessSummary');
    const itemsAt = screen.indexOf('`ITEMS · ${order.lines.length} LINE');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeLessThan(itemsAt);
    const sf = parseTsx(screen, 'app/order/[id].tsx');
    const found: { el: JsxNode; ancestors: string[] }[] = [];
    walkJsx(sf, (el, ancestors) => {
      if (tagOf(el, sf) === 'OrderLineReadiness') {
        found.push({ el, ancestors: ancestors.map((a) => tagOf(a, sf)) });
      }
    });
    expect(found).toHaveLength(1);
    // No touchable ancestor: a button would fold it into one VoiceOver element.
    expect(found[0]!.ancestors).toContain('Card');
    expect(found[0]!.ancestors.filter((t) => TOUCHABLE_TAG.test(t))).toEqual([]);
    // The spoken "Line N" is the line's place on screen.
    expect(attrText(found[0]!.el, 'position', sf)).toBe('i + 1');
  });
});

describe('order screen: offline (in memory only)', () => {
  it('reads the live network state; offline, load asks nothing and clears nothing', () => {
    expect(screen).toContain('const offline = isOfflineState(useNetworkState());');
    const b = codeOnly(loadBody());
    const offlineAt = b.indexOf('if (offline) {');
    expect(offlineAt).toBeGreaterThan(-1);
    expect(offlineAt).toBeLessThan(b.indexOf("from('order_requests')"));
    const branch = b.slice(offlineAt, b.indexOf('const { data, error: headerError'));
    expect(branch).not.toContain('await ');
    expect(branch).not.toContain('setOrder(');
    expect(branch).not.toContain('setLoading(');
    expect(branch).toMatch(/^if \(offline\) \{\s*return;\s*\}\s*$/);
    // Offline the spinner never hides the remembered order or the offline
    // sentence; online it shows only while nothing is on screen.
    expect(screen).toContain('{loading && !order && !offline ? (');
    // Reconnecting reloads: `offline` is one of load's dependencies.
    expect(screen).toContain(LOAD_END);
  });

  // Mutation caught: showing the recalled view online, or letting a failed
  // read's error (or "Order not found.") stand while offline.
  it('the offline view is derived: the order on screen, else the one remembered this session, else "needs a connection"', () => {
    expect(screen).toContain(
      'const [loadedOrder, setOrder] = React.useState<OrderHeader | null>(null);',
    );
    expect(screen).toMatch(
      /offline && loadedOrder === null\s*\? recalledOrderView<RememberedOrder>\(userId, orgId, id \?\? null\)\s*: null,/,
    );
    expect(screen).toContain('const order = loadedOrder ?? recalled?.view.order ?? null;');
    expect(screen).toContain(
      'const attachments = recalled ? recalled.view.attachments : loadedAttachments;',
    );
    expect(screen).toContain(
      'const shipment = recalled ? recalled.view.shipment : loadedShipment;',
    );
    expect(screen).toMatch(
      /const loadError =\s*offline && order === null \? ORDER_OFFLINE_NOTHING_LOADED_COPY : loadErrorState;/,
    );
  });

  it('remembers every completed load in memory (never SQLite, never the outbox)', () => {
    const b = codeOnly(loadBody());
    expect(b).toMatch(
      /if \(shown\) \{\s*rememberOrderView<RememberedOrder>\(userId, orgId, id, \{/,
    );
    const code = codeOnly(screen);
    expect(code).not.toMatch(/from '@\/lib\/db'/);
    expect(code).not.toMatch(/enqueue|outbox/i);
  });

  it('shows the banner with the time the order was loaded', () => {
    expect(screen).toMatch(
      /readinessOfflineCopy\(orderViewAsOf\(order\.readiness, order\.receivedAt\), \{\s*timeZone: order\.orgTimezone \?\? undefined,\s*\}\)/,
    );
  });

  it('every action is disabled offline, with the reason', () => {
    expect(screen).toContain(
      'const disabled = disabledByCaller || (offline && !WORKS_OFFLINE.has(busyKey));',
    );
    expect(screen).toContain("const WORKS_OFFLINE = new Set(['delivery-copy']);");
    expect(screen).toMatch(
      /const connectionNotice = offline \? \(\s*<Body[^>]*>\s*\{READINESS_NEEDS_CONNECTION_COPY\}/,
    );
    // Picking, manager actions, items, delivery request, returns, proof.
    expect(screen.match(/\{connectionNotice\}/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(screen).toContain('connectionNotice : null}');
    expect(screen).toContain(
      'const editable = canEditItems && l.orderRequestLineId !== null && !offline;',
    );
    expect(screen).toContain('disabled={uploading || offline}');
    expect(screen).toContain('offline={offline}');
    // The pick workspace is never unmounted for a dropped connection (the
    // typed quantities live only in it): its buttons are disabled instead.
    expect(digitalPick).toContain('disabled={!anyPicked || completing || offline}');
    expect(digitalPick).toContain('disabled={!dirty || savingLine === line.id || offline}');
    expect(digitalPick).toContain('{READINESS_NEEDS_CONNECTION_COPY}');
  });

  it("digital pick's owed is core's one definition", () => {
    expect(digitalPick).toMatch(
      /const owedBefore = lineOwedUnits\(\{\s*quantityRequested: l\.quantity_requested,\s*quantityFulfilled: l\.quantity_fulfilled,\s*\}\);/,
    );
  });
});

describe('the readiness components', () => {
  it('word everything through core, never a percentage or a promise', () => {
    const s = codeOnly(summary);
    const l = codeOnly(lineCard);
    expect(s).toContain('const opts = { timeZone: timeZone ?? undefined };');
    expect(s).toContain('describeReadinessRollup(result, opts)');
    // The requester's card is core's too, laid out as the web strip's:
    // the sentence, when it was checked, and Check again / Try again.
    expect(s).toContain('describeReadinessForRequester(result, opts)');
    expect(s).toMatch(/\{card\.checkedAt \? \(/);
    expect(s).toContain('{recheck(card.failed)}');
    // Under a failed headline, only core's reason (the web shows the same).
    expect(s).toContain('const detail = rollup.detail;');
    expect(s).not.toContain('result.message');
    expect(l).toContain('describeReadinessLine(line, item, opts)');
    expect(l).toContain('describeReadinessHold(line.hold)');
    expect(l).toContain('describeReadinessWhy(item, opts).parts');
    expect(l).toContain('readinessLineAccessibilityLabel({ ...line, position })');
    for (const src of [s, l]) {
      expect(src).not.toMatch(/%|verified|guarantee|will arrive|\bbook\b/i);
    }
  });

  it('a failed check is an alert with Try again, never an empty or green card', () => {
    const s = codeOnly(summary);
    expect(s).toContain("accessibilityRole={failed ? 'alert' : 'header'}");
    expect(s).toContain("accessibilityRole={card.failed ? 'alert' : 'text'}");
    expect(s).toContain("{checking ? 'Checking...' : failedNow ? 'Try again' : 'Check again'}");
    expect(s).toContain('{recheck(failed)}');
    expect(s).toContain('disabled={offline || checking}');
    expect(s).toContain('{READINESS_NEEDS_CONNECTION_COPY}');
  });

  it('the state is an icon and a label (never colour alone); chrome is capped, content is not', () => {
    const l = codeOnly(lineCard);
    expect(l).toContain('<ReadinessIcon icon={icon} size={13} color={color} />');
    expect(l).toContain('{label}');
    expect(l).toContain('const CHIP_CAP = capTo(CHIP_SIZE, TYPE_CEILING.chrome);');
    expect(l.match(/maxFontSizeMultiplier=\{CHIP_CAP\}/g)?.length).toBe(2);
    // The sentences are content: no cap on them.
    expect(l).toMatch(/<Body size=\{13\} color=\{c\.ink2\}>\s*\{sentence\}/);
  });

  it('the line row is announced as "Line N, <state>, <detail>" and says whether it is open', () => {
    const l = codeOnly(lineCard);
    expect(l).toContain('accessibilityLabel={label}');
    expect(l).toContain("accessibilityHint={open ? 'Hides why' : 'Shows why'}");
    expect(l).toContain('accessibilityState={{ expanded: open }}');
  });

  // The iOS minimum target (Human Interface Guidelines).
  it('every touchable is at least 44pt tall, with a role, and no hitSlop', () => {
    const minTap = /export const MIN_TAP = (\d+);/.exec(
      readFileSync(path.resolve(__dirname, '../components/item-verification-card.tsx'), 'utf8'),
    );
    expect(Number(minTap![1])).toBeGreaterThanOrEqual(44);
    for (const [file, src] of [
      ['src/components/order-line-readiness.tsx', lineCard],
      ['src/components/order-readiness-summary.tsx', summary],
    ] as const) {
      const sf = parseTsx(src, file);
      const touchables: JsxNode[] = [];
      walkJsx(sf, (el: JsxNode) => {
        const tag = tagOf(el, sf);
        if (TOUCHABLE_TAG.test(tag) || tag === 'Button') touchables.push(el);
      });
      expect(touchables.length, file).toBeGreaterThan(0);
      for (const t of touchables) {
        const style = attrText(t, 'style', sf) ?? '';
        expect(style, `${file} ${tagOf(t, sf)}`).toMatch(/minHeight: MIN_TAP/);
        expect(attrText(t, 'hitSlop', sf), `${file} hitSlop`).toBeUndefined();
        if (tagOf(t, sf) !== 'Button') {
          expect(attrText(t, 'accessibilityRole', sf), `${file} role`).toMatch(/^(button|link)$/);
        }
      }
    }
  });
});

describe('recurrence guard: the old stock checks do not come back', () => {
  /** Every non-test source file under the phone's two code trees. */
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === '__fixtures__' || name === '__mocks__') continue;
        out.push(...sources(full));
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  // Mutation caught: restoring lib/order-stock-check.ts, or computing the
  // flags inline on the order screen again.
  it('no phone source computes the stock flags or reads on hand for them itself', () => {
    const offenders: string[] = [];
    for (const file of [
      ...sources(path.join(MOBILE_ROOT, 'src')),
      ...sources(path.join(MOBILE_ROOT, 'app')),
    ]) {
      const src = codeOnly(readFileSync(file, 'utf8'));
      if (/computeOrderStockFlags|loadOrderStockCheck|readOnHand\b|order-stock-check/.test(src)) {
        offenders.push(path.relative(MOBILE_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
