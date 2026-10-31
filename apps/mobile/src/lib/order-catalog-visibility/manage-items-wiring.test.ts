import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOUCHABLE_TAG, attrText, parseTsx, tagOf, walkJsx } from '../__fixtures__/jsx-touch-audit';

/**
 * MANAGE ORDER ITEMS ON THE PHONE: WIRING PINS (ordering visibility, 0413;
 * design 3.7, 8.1, 8.6, 8.7). The screen and the two entries import native
 * modules, so vitest cannot render them; every decision lives in a tested
 * module beside this file (api, selection, write, view, words) and these pins
 * keep the screens wired to them. Each names the mutation it catches.
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}
const flat = (s: string) => s.replace(/\s+/g, ' ');

const SCREEN = 'app/order/manage-items.tsx';
const screenRaw = read(SCREEN);
const screen = codeOnly(screenRaw);
const orders = codeOnly(read('src/screens/orders.tsx'));
const catalog = codeOnly(read('src/components/order-storefront/catalog-screen.tsx'));
const layout = codeOnly(read('app/_layout.tsx'));

describe('a real native screen, registered beside the order routes', () => {
  it('is not a WebView and opens no browser (brief 12: native management is not a WebView substitute)', () => {
    expect(screen).not.toMatch(/react-native-webview|WebView|openBrowserAsync|Linking\.openURL|expo-web-browser/);
  });

  it('is a static card route beside order/[id], so /order/manage-items never reaches the order screen', () => {
    expect(existsSync(path.join(ROOT, SCREEN))).toBe(true);
    const at = layout.indexOf('<Stack.Screen name="order/[id]"');
    const mine = layout.indexOf(`<Stack.Screen name="order/manage-items" options={{ presentation: 'card' }} />`);
    expect(at).toBeGreaterThan(-1);
    expect(mine).toBeGreaterThan(at);
  });
});

describe('reads and writes go only through the tested calls', () => {
  it('the list, the family and the write use orderCatalogManageApi (mutation: a direct inventory read or an RPC)', () => {
    expect(screen).toContain('await orderCatalogManageApi.list(callScope, query, ctrl.signal)');
    expect(screen).toContain('await orderCatalogManageApi.family(callScope, groupId)');
    expect(screen).toContain('await sendVisibility(orderCatalogManageApi, callScope, pending)');
    expect(screen).not.toMatch(/from\('inventory_items'\)|\.rpc\(|set_order_catalog_visibility|order_catalog_visible/);
    // The one direct read is the category filter's list, under the person's own access.
    expect((screen.match(/supabase\s*\.from\(/g) ?? []).length).toBe(1);
    expect(flat(screen)).toContain(".from('categories') .select('id, name') .eq('organization_id', scope.orgId)");
  });

  it('a change is never queued: no outbox, no queue (mutation: enqueue a write offline)', () => {
    expect(screen).not.toMatch(/@\/lib\/queue|enqueue|outbox|@\/lib\/sync'/);
  });

  it('one request at a time, never offline, never past the cap, never locked; the body is keyed for its retries', () => {
    expect(flat(screen)).toContain('if (savingRef.current || blockedFor(draft.ids.length) !== null) return;');
    expect(flat(screen)).toContain(
      'const pending = keyedVisibilityBody( orderCatalogSelection.forScope(scope).pending, visibilityDraft(draft.ids, draft.visible), );',
    );
    expect(screen).toContain('const blockedFor = (count: number) => visibilityWriteBlockedBy({ offline, count, locked });');
  });

  it('a send happens only on a tap: the confirm button and Try again (mutation: send from an effect)', () => {
    const sends = screen.match(/\bvoid send\(/g) ?? [];
    expect(sends).toHaveLength(2);
    expect(flat(screen)).toContain('onPress={() => void send(confirm)}');
    expect(flat(screen)).toContain('if (status.retry) void send(status.retry);');
    const hooks = /\b(?:React\.)?(useEffect|useLayoutEffect|useFocusEffect|useMemo)\(/g;
    for (let m = hooks.exec(screen); m; m = hooks.exec(screen)) {
      const body = screen.slice(m.index, m.index + 700);
      // The hook's own callback ends at its dependency list.
      const end = body.search(/\},\s*\[/);
      expect((end > 0 ? body.slice(0, end) : body), body.slice(0, 80)).not.toMatch(/\bsend\(/);
    }
  });

  it('nothing is asked offline (mutation: read with no connection and show an empty list)', () => {
    expect(flat(screen)).toMatch(/const load = React\.useCallback\(async \(\) => \{ if \(offline\) return;/);
    expect(screen).toContain('const view = manageListView(stored, key, offline, query);');
  });
});

describe('THE SCOPE: one account, organization and account epoch (design 8.6)', () => {
  it('the body is keyed by the scope, so a workspace switch starts it over (mutation: drop the key)', () => {
    expect(screen).toContain('<ManageItemsBody key={scopeKey} scope={scope} scopeKey={scopeKey} />');
    expect(flat(screen)).toContain('() => (userId && activeOrgId ? { userId, orgId: activeOrgId, epoch } : null)');
    expect(screen).toContain('const epoch = accountEpoch();');
  });

  it('binds the selection on mount and on every focus; reads it only for its own scope', () => {
    expect((screen.match(/if \(scope\) orderCatalogSelection\.bindScope\(scope\);/g) ?? []).length).toBe(2);
    expect(screen).toContain('const selection = store.scopeKey === scopeKey ? store : EMPTY_SELECTION;');
  });

  it('an answer that lands after the body unmounted says and changes nothing', () => {
    expect(flat(screen)).toContain('savingRef.current = false; if (!mounted.current) return;');
    expect(screen).toContain("if (failure.reason === 'other_organization') return;");
  });
});

describe('a final refusal locks the screen; a revocation reaches an open screen (design 3.7)', () => {
  it('a final refusal locks every control and reads the capability again (mutation: keep the controls on)', () => {
    expect(flat(screen)).toContain('setLocked(message); void fetchEffectivePermissions();');
    expect(screen).toContain('if (failure.final) lockScreen(failure.message);');
    expect(screen).toContain('const controlsOff = locked !== null || saving;');
  });

  it('a change of the capability in the effective set reads the list again', () => {
    expect(screen).toContain(
      'const holdsKey = permissions === undefined ? null : permissions.has(ORDER_CATALOG_VISIBILITY_PERMISSION);',
    );
    expect(flat(screen)).toMatch(/void loadRef\.current\(\); \}, \[holdsKey\]\);/);
  });

  it('reads on every focus and when the app returns to the foreground', () => {
    expect(flat(screen)).toContain('useFocusEffect( React.useCallback(() => { void load(); }, [load]), );');
    expect(flat(screen)).toContain("if (next === 'active') void loadRef.current();");
  });

  it('a successful read lifts the lock (StockPilot allowed it again)', () => {
    expect(flat(screen)).toContain('setStored({ key, answer, failure: null }); setLocked(null);');
  });
});

describe('outcomes, said in place', () => {
  it('a saved change: exactly what the answer says, the selection updated, a bulk selection cleared, the list read again', () => {
    const f = flat(screen);
    expect(f).toContain('orderCatalogSelection.markVisible(scope, [...saved.changed, ...saved.unchanged], saved.visible);');
    expect(f).toContain("if (draft.source === 'bulk') orderCatalogSelection.clear(scope);");
    expect(f).toContain('rowsAfterWrite(prev.answer.rows, saved)');
    expect(f).toContain("say({ tone: 'ok', message: savedOutcome(saved), retry: null });");
    expect(f).toContain('if (saved.changed.length > 0) refreshOpenStorefront(scope);');
  });

  it('items unavailable deselects exactly the ids named; Try again only where it helps', () => {
    const f = flat(screen);
    expect(f).toContain("if (failure.reason === 'items_unavailable') orderCatalogSelection.remove(scope, failure.itemIds);");
    expect(f).toContain("say({ tone: 'warn', message: failure.message, retry: offerRetry(failure) ? draft : null });");
    expect(f).toContain('if (!failure.retrySame) orderCatalogSelection.setPending(scope, null);');
  });

  it('the outcome region is an alert and is announced (the phone has no toast)', () => {
    expect(screen).toMatch(/<View accessibilityRole="alert" style=\{\[styles\.status/);
    expect(screen).toContain('if (next.message) AccessibilityInfo.announceForAccessibility(next.message);');
  });

  it('an open storefront of the same account and workspace reads its catalog again after a change', () => {
    expect(flat(screen)).toContain('if (shown && shown.userId === scope.userId && shown.orgId === scope.orgId) void session.refresh();');
  });
});

describe('the confirmation, in core’s words', () => {
  it('Hide and Show confirm with core’s titles and the owner’s sentence; the sheet cannot close while saving', () => {
    const f = flat(screen);
    expect(f).toContain('? orderItemsShowConfirmTitle(confirm.ids.length) : orderItemsHideConfirmTitle(confirm.ids.length)');
    expect(f).toContain('{confirm?.visible ? ORDER_ITEMS_SHOW_CONFIRM_BODY_COPY : ORDER_ITEMS_HIDE_CONFIRM_BODY_COPY}');
    expect(f).toContain('busy={saving}');
    expect(f).toContain('disabled={blockedFor(confirm.ids.length) !== null} hint={blockedFor(confirm.ids.length) ?? undefined}');
  });

  it('bulk actions send exactly the selected ids; a row sends its own id', () => {
    const f = flat(screen);
    expect(f).toContain("setConfirm({ ids: selection.records.map((r) => r.id), visible, source: 'bulk', name: null })");
    expect(f).toContain("setConfirm({ ids: [row.id], visible: !row.visible, source: 'row', name: row.name })");
  });
});

describe('the rows, the review and the family disclosure', () => {
  const sf = parseTsx(screenRaw, SCREEN);

  it('a row is its checkbox, named for its record; its actions are siblings, never inside it', () => {
    let hosts = 0;
    walkJsx(sf, (el, ancestors) => {
      const tag = tagOf(el, sf);
      if (tag === 'SmallAction') {
        expect(ancestors.some((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toBe(false);
      }
      if (TOUCHABLE_TAG.test(tag) && attrText(el, 'accessibilityLabel', sf) === 'manageRowSpokenLabel(row)') {
        hosts += 1;
        expect(attrText(el, 'accessibilityRole', sf)).toBe('checkbox');
        expect(attrText(el, 'accessibilityState', sf)).toBe('{ checked: selected, disabled }');
      }
    });
    expect(hosts).toBe(1);
    expect(flat(screen)).toContain('accessibilityLabel={orderItemsRowActionLabel(row.visible, row.name)}');
  });

  it('the page checkbox covers the current page’s rows only', () => {
    expect(screen).toContain('const pageState = pageSelectState(rows, selection.ids);');
    expect(screen).toContain('const refusal = orderCatalogSelection.add(scope, rows.map(recordFromRow));');
  });

  it('the review sheet lists every selected record, off-page ones included', () => {
    expect(screen).toContain('selection.records.map((r) => (');
    expect(screen).toContain('visible={selection.reviewOpen}');
  });

  it('Select family lists every readable member ticked, and Add takes exactly the ticked ones', () => {
    const f = flat(screen);
    expect(f).toContain('checked: new Set(got.rows.map((r) => r.id.toLowerCase())),');
    expect(f).toContain('const picked = family.answer.rows.filter((r) => family.checked.has(r.id.toLowerCase())).map(recordFromRow);');
    expect(f).toContain('const refusal = orderCatalogSelection.add(scope, picked);');
  });

  it('25 a page over the full dataset, with the web’s range words', () => {
    expect(screen).toContain('orderItemsRangeCopy(paging.rangeStart, paging.rangeEnd, paging.total)');
    expect(flat(screen)).toContain('onPageChange={(page) => setQuery((q) => ({ ...q, page }))}');
  });
});

describe('the two entries (design 8.1)', () => {
  it('the Orders list: the strict tested gate, not orders:request, opening the screen (mutation: gate on canPlace)', () => {
    expect(flat(orders)).toContain(
      "const canManageItems = showManageOrderItems({ permissions, ordersModuleEnabled: enabledModules.has('orders'), });",
    );
    expect(flat(orders)).toContain(
      '{canManageItems ? ( <View style={{ marginRight: -3 }}> <IconChip icon={ListChecks} onPress={manageOrderItems} accessibilityLabel={ORDER_ITEMS_MANAGE_BUTTON_COPY} minTap />',
    );
    expect(orders).toContain("const manageOrderItems = () => router.push('/order/manage-items' as Href);");
  });

  it('the storefront top bar: only when the fresh answer says exactly true, on its home', () => {
    expect(flat(catalog)).toContain(
      "target === null && snap?.setup.status === 'ready' && snap.setup.answer.viewer.canManageOrderItems === true;",
    );
    expect(flat(catalog)).toContain("onPress={() => router.push('/order/manage-items' as Href)}");
    expect(flat(catalog)).toContain('label={ORDER_ITEMS_MANAGE_BUTTON_COPY}');
  });
});
