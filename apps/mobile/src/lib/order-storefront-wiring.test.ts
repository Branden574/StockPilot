import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOUCHABLE_TAG, attrText, parseTsx, tagOf, walkJsx, type JsxNode } from './__fixtures__/jsx-touch-audit';

/**
 * PHONE ORDERING PO-4 CALL-SITE PINS. The storefront's screens and components
 * import native modules, so vitest cannot render them; every decision they
 * make lives in a tested module (src/lib/order-storefront, orders-list.ts,
 * order-focus.ts), and these pins keep the screens wired to those modules.
 * Each names the mutation it catches.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\s*\}/g, '{}');
}
const flat = (s: string) => s.replace(/\s+/g, ' ');
function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const SCREENS = {
  index: 'app/order/new/index.tsx',
  browse: 'app/order/new/browse.tsx',
  checkout: 'app/order/new/checkout.tsx',
  placed: 'app/order/new/placed.tsx',
};
const COMPONENTS = 'src/components/order-storefront';
const CATALOG = `${COMPONENTS}/catalog-screen.tsx`;
const ITEM_ROW = `${COMPONENTS}/item-row.tsx`;
const CONTROLS = `${COMPONENTS}/controls.tsx`;
const SHEETS = `${COMPONENTS}/sheets.tsx`;
const SHEET_FRAME = `${COMPONENTS}/storefront-sheet.tsx`;
const PANEL = `${COMPONENTS}/unconfirmed-panel.tsx`;

const catalog = codeOnly(read(CATALOG));
const checkout = codeOnly(read(SCREENS.checkout));
const placed = codeOnly(read(SCREENS.placed));
const itemRow = codeOnly(read(ITEM_ROW));
const controls = codeOnly(read(CONTROLS));
const sheets = codeOnly(read(SHEETS));

function listFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__fixtures__') continue;
      listFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const PRODUCT_FILES = [...listFiles(path.join(ROOT, 'src')), ...listFiles(path.join(ROOT, 'app'))];
const STOREFRONT_FILES = [
  ...listFiles(path.join(ROOT, COMPONENTS)),
  ...listFiles(path.join(ROOT, 'app/order/new')),
  path.join(ROOT, 'src/components/needed-by-picker.tsx'),
];

describe('the routes and the way in', () => {
  it('four static routes beside order/[id], registered in the root stack; the success screen cannot be swiped back to a spent checkout', () => {
    const layout = codeOnly(read('app/_layout.tsx'));
    const at = layout.indexOf('<Stack.Screen name="order/[id]"');
    expect(at).toBeGreaterThan(-1);
    for (const name of ['order/new/index', 'order/new/browse', 'order/new/checkout']) {
      expect(layout).toContain(`<Stack.Screen name="${name}" options={{ presentation: 'card' }} />`);
      expect(layout.indexOf(`name="${name}"`)).toBeGreaterThan(at);
    }
    expect(layout).toContain(`<Stack.Screen name="order/new/placed" options={{ presentation: 'card', gestureEnabled: false }} />`);
  });

  it('home and browse are the one catalog screen; browse reads its target through the tested parser', () => {
    expect(codeOnly(read(SCREENS.index))).toContain('<CatalogScreen target={null} />');
    const browse = codeOnly(read(SCREENS.browse));
    expect(browse).toMatch(/browseTargetFromParams\(\{ category: params\.category, section: params\.section \}\)/);
    expect(browse).toContain('<CatalogScreen target={target} />');
  });

  it('every storefront screen opens the session for the signed-in account and workspace, and shows nothing of another', () => {
    for (const src of [catalog, checkout, placed]) {
      expect(src).toContain('useStorefrontScope();');
      expect(src).toContain('const snap = useStorefront();');
    }
    const runtime = codeOnly(read('src/lib/order-storefront/runtime.ts'));
    expect(flat(runtime)).toContain(
      'if (!user || !activeOrgId || !snap.scope) return null; if (snap.scope.userId !== user.id || snap.scope.orgId !== activeOrgId) return null;',
    );
    expect(flat(runtime)).toMatch(/if \(!userId \|\| !activeOrgId\) \{ session\.close\(\); return; \} void session\.open\(\{ userId, orgId: activeOrgId, activeWarehouseId \}\);/);
  });

  it('reads run on their own on foreground, reconnect and focus; a send or a withdraw only on a tap', () => {
    const runtime = codeOnly(read('src/lib/order-storefront/runtime.ts'));
    expect(runtime).toMatch(/AppState\.addEventListener\('change', \(next\) => \{\s*if \(next === 'active'\) void session\.focus\(\);/);
    expect(runtime).toMatch(/if \(wasOffline\.current && !offline\) void session\.focus\(\);/);
    expect(catalog).toMatch(/useFocusEffect\(\s*React\.useCallback\(\(\) => \{\s*void session\.focus\(\);/);
    // No effect, focus or memo callback ever sends, resends or withdraws.
    const hooks = /\b(?:React\.)?(useEffect|useLayoutEffect|useFocusEffect|useCallback|useMemo)\(/g;
    for (const [file, src] of [
      [CATALOG, catalog],
      [SCREENS.checkout, checkout],
      [SCREENS.placed, placed],
      ['src/lib/order-storefront/runtime.ts', runtime],
    ] as const) {
      for (let m = hooks.exec(src); m; m = hooks.exec(src)) {
        const body = src.slice(m.index, m.index + 600);
        const callEnd = body.indexOf('}, [');
        const hookBody = callEnd > 0 ? body.slice(0, callEnd) : body;
        expect(hookBody, `${file}: ${hookBody.slice(0, 80)}`).not.toMatch(/\.submit\(|\.checkAndFinish\(|\.dontSend\(|withdraw\(/);
      }
    }
    expect(count(checkout, 'session.submit(')).toBe(1);
    expect(checkout).toMatch(/onPress=\{\(\) => \{\s*notesDraft\.flush\(\);\s*void session\.submit\(offline\);\s*\}\}/);
  });

  it('the deep link: a rewrite rule above the other orders rules, and the static cold-start shim', () => {
    const rewrite = codeOnly(read('src/lib/web-path-rewrite.ts'));
    const rule = rewrite.indexOf("to: () => '/order/new'");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(rewrite.indexOf('`/order/${m[1]}`'));
    expect(codeOnly(read('app/dashboard/orders/new.tsx'))).toContain("<Redirect href={'/order/new' as Href} />");
  });
});

describe('the Orders list (D4, D5, D6) and the order screen', () => {
  const orders = codeOnly(read('src/screens/orders.tsx'));

  it('reads on every focus, not only on mount (mutation: back to a mount-only effect)', () => {
    expect(orders).toMatch(/useFocusEffect\(\s*React\.useCallback\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\),?\s*\);/);
    expect(orders).not.toMatch(/React\.useEffect\(\(\) => \{\s*void load\(\);/);
  });

  it('a failed read is said, with Load again, never "No orders yet." (mutation: ignore the error)', () => {
    expect(orders).toMatch(/const \[\{ data, error \}, unsettled\] = await Promise\.all\(/);
    expect(orders).toMatch(/if \(error\) \{\s*setFailed\(true\);/);
    expect(orders).toContain('const empty = ordersListEmpty(failed && rows.length === 0);');
    expect(orders).toContain('emptyTitle={empty.title}');
    expect(orders).toContain('<SmallAction label={ORDERS_LIST_RETRY_COPY} onPress={() => void refresh()} />');
  });

  it('every status’s pill is core’s (mutation: a local table again)', () => {
    expect(orders).toContain('const meta = orderStatusPill(order.status);');
    expect(orders).not.toMatch(/STATUS_META/);
  });

  it('+ and the empty state’s Place an order, by the tested gate, share the trailing slot with the tour', () => {
    expect(flat(orders)).toMatch(/const canPlace = showPlaceOrder\(\{ role: role \?\? null, permissions, ordersModuleEnabled: enabledModules\.has\('orders'\),? \}\);/);
    expect(orders).toMatch(/<MobileTour tour=\{MOBILE_ORDERS_TOUR\} \/>\s*\{canPlace \? \(/);
    expect(orders).toMatch(/<IconChip icon=\{Plus\} onPress=\{placeAnOrder\} accessibilityLabel=\{STOREFRONT_TITLE_COPY\} minTap \/>/);
    expect(orders).toMatch(/\) : canPlace \? \(\s*<SmallAction label=\{STOREFRONT_TITLE_COPY\} variant="primary" onPress=\{placeAnOrder\} \/>/);
    expect(orders).toContain("const placeAnOrder = () => router.push('/order/new' as Href);");
  });

  it('a banner when an order request sent from this phone is not confirmed', () => {
    expect(orders).toContain('userId ? unsettledSendsOnDevice(userId, orgId) : Promise.resolve(0)');
    expect(orders).toMatch(/unconfirmed > 0 \? \(\s*<Card padding=\{12\}>/);
    expect(orders).toContain('{ORDERS_LIST_UNCONFIRMED_COPY}');
  });

  it('the order screen scrolls to its actions SECTION for focus=approve, once, by the tested helper', () => {
    const order = codeOnly(read('app/order/[id].tsx'));
    expect(order).toContain('const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>();');
    expect(order).toMatch(/if \(focusDone\.current \|\| orderScreenFocus\(focus\) !== 'actions'\) return;/);
    expect(order).toContain('const y = focusScrollY(e.nativeEvent.layout.y);');
    expect(order).toMatch(/<ScrollView\s+ref=\{scrollRef\}/);
    expect(order).toMatch(/\{hasPipelineActions \? \(\s*<View style=\{\{ gap: 8 \}\} onLayout=\{onActionsLayout\}>/);
  });

  it('the Orders tour names the + it spotlights', () => {
    const tour = read('src/lib/onboarding.ts');
    expect(tour).toContain("targetId: 'orders-place-order'");
    expect(orders).toContain("const placeTargetRef = useTourTarget('orders-place-order');");
  });
});

describe('the list: build #23’s settings, never FlashList, never a ScrollView .map over the catalog', () => {
  it('one FlatList with the validated settings and a module-scope key extractor', () => {
    expect(catalog).toMatch(
      /<FlatList\s+data=\{rows\}\s+keyExtractor=\{storefrontRowKey\}\s+renderItem=\{renderRow\}\s+ListHeaderComponent=\{header\}\s+initialNumToRender=\{12\}\s+maxToRenderPerBatch=\{8\}\s+windowSize=\{9\}\s+removeClippedSubviews=\{Platform\.OS === 'android'\}\s+keyboardDismissMode="on-drag"\s+keyboardShouldPersistTaps="handled"/,
    );
    expect(count(catalog, '<FlatList')).toBe(1);
    for (const file of STOREFRONT_FILES) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/FlashList|@shopify\/flash-list/);
    }
    expect(catalog).not.toMatch(/(rows|items|prepared\.items)\.map\(/);
  });

  it('rows are memoized and take stable id-taking callbacks and a scalar quantity', () => {
    expect(itemRow).toContain('export const ItemRow = React.memo(function ItemRow(');
    expect(itemRow).toMatch(/onAdd: \(itemId: string\) => void;/);
    expect(catalog).toMatch(/quantity=\{qtyMap\.get\(row\.item\.id\) \?\? 0\}/);
    for (const cb of ['onAdd', 'onInc', 'onDec', 'onQuantity', 'onOpen', 'onPhotoError', 'onKit', 'onKitDetails']) {
      expect(catalog, cb).toMatch(new RegExp(`const ${cb} = React\\.useCallback\\(`));
    }
  });

  it('photos through CachedImage with the item id as recycling key; a failed image asks the session once', () => {
    expect(itemRow).toMatch(/<CachedImage uri=\{photoUrl\} style=\{styles\.photoImage\} recyclingKey=\{item\.id\} onError=\{onPhotoError\} \/>/);
    expect(sheets).toMatch(/<CachedImage\s+uri=\{photoUrl\}\s+recyclingKey=\{item\.id\}/);
    expect(catalog).toContain('const onPhotoError = React.useCallback(() => session.photoFailed(), [session]);');
  });

  it('the search is pinned above the list (never in the list header, which would remount and drop keystrokes) and never focused on open', () => {
    const search = catalog.indexOf('placeholder={STOREFRONT_SEARCH_PLACEHOLDER_COPY}');
    expect(search).toBeGreaterThan(-1);
    expect(catalog.indexOf('const searchBar = (')).toBeLessThan(search);
    expect(catalog).toMatch(/\{title\}\s*<\/Display>\s*\{searchBar\}/);
    const searchInput = catalog.slice(catalog.lastIndexOf('<TextInput', search), search + 200);
    expect(searchInput).not.toMatch(/autoFocus/);
    // Uncontrolled (no value=): a busy JS thread never drops a keystroke; the
    // rows follow a deferred copy of what is typed.
    expect(searchInput).not.toMatch(/\bvalue=/);
    expect(searchInput).toContain('ref={searchRef}');
    expect(catalog).toContain('const deferredSearch = React.useDeferredValue(filter.search);');
    expect(catalog).toContain("return matchingRows(view, target ?? { kind: 'all' }, shownFilter);");
  });
});

describe('accessibility and Dynamic Type', () => {
  it('nothing in the storefront shrinks text below the size the person chose', () => {
    for (const file of STOREFRONT_FILES) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/adjustsFontSizeToFit|allowFontScaling=\{false\}/);
    }
  });

  it('item names are content: never capped, never cut to one line', () => {
    const name = itemRow.slice(itemRow.indexOf('{item.name}') - 160, itemRow.indexOf('{item.name}'));
    expect(name).not.toMatch(/maxFontSizeMultiplier|numberOfLines/);
  });

  it('steppers, small actions, radios and setup rows are 44 pt frames', () => {
    for (const style of ['small', 'stepButton', 'count', 'radio', 'segment', 'setup']) {
      expect(controls, style).toMatch(new RegExp(`${style}: \\{[^}]*minHeight: MIN_TAP`));
    }
    expect(controls).toMatch(/stepButton: \{\s*minWidth: MIN_TAP,\s*minHeight: MIN_TAP,/);
  });

  it('every stepper button names its item; + says why it stops', () => {
    expect(itemRow).toContain('decLabel={decreaseLabel(item.name, quantity)}');
    expect(itemRow).toContain('incLabel={increaseLabel(item.name)}');
    expect(itemRow).toContain('countLabel={quantityButtonLabel(item.name, quantity)}');
    expect(itemRow).toContain('incHint={increaseBlockedHint(quantity >= available)}');
    expect(itemRow).toContain('atMax={quantity >= available}');
  });

  it('a row is one element with its name, availability, rank, earmark, quantity in the cart and mark', () => {
    expect(itemRow).toContain('accessibilityLabel={itemRowLabel(item, quantity, earmark, { rank, notOrderable })}');
  });

  it('Pickup or Delivery is a radio group to VoiceOver; choices in sheets are radios', () => {
    expect(controls).toContain('accessibilityRole="radiogroup"');
    expect(count(controls, 'accessibilityRole="radio"')).toBe(2);
    expect(controls).toContain('accessibilityState={{ checked, disabled }}');
  });

  it('refusals and the unconfirmed panel are said in place and announced', () => {
    const panel = codeOnly(read(PANEL));
    expect(panel).toMatch(/<Body size=\{13\.5\} color=\{c\.ink\} accessibilityRole="alert">\s*\{message\}/);
    // The title is joined to the sentence by the tested announcer, which
    // speaks only on the screen in focus (PO-4 review).
    expect(panel).toContain('const said = panelAnnouncer.next(message, focused);');
  });

  it('how a send ended is said on checkout, home and browse, and the turned-off or refused screen, by the tested helper, and announced where shown (F3)', () => {
    const state = codeOnly(read(`${COMPONENTS}/storefront-state.tsx`));
    expect(checkout).toContain('const outcome = snap ? storefrontOutcome(snap, { itemName, warehouseName: warehouse?.name ?? null }) : null;');
    expect(catalog).toContain('const outcome = snap ? storefrontOutcome(snap, { itemName: outcomeItemName, warehouseName: outcomeWarehouse }) : null;');
    for (const src of [checkout, catalog, state]) {
      expect(src).toMatch(/\{outcome \? \(\s*<Body size=\{1[34](\.5)?\} color=\{outcome\.tone === 'calm' \? c\.ink : ACCENT\.crit\} accessibilityRole="alert">\s*\{outcome\.text\}/);
    }
    for (const src of [checkout, catalog]) {
      expect(src).toContain('if (outcomeText && focused) AccessibilityInfo.announceForAccessibility(outcomeText);');
      expect(src).not.toMatch(/snap\.refusal \?|refusalText/);
    }
    expect(catalog).toMatch(/<StorefrontState[\s\S]*?outcome=\{outcome\}[\s\S]*?\/>/);
  });

  it('what a screen said is dismissed when the person leaves it, so it never comes back on reopen (F4)', () => {
    expect(flat(checkout)).toContain('useFocusEffect( React.useCallback(() => { void session.openCheckout(); return () => session.dismissOutcome(); }, [session]), );');
    expect(flat(catalog)).toContain('useFocusEffect( React.useCallback(() => { void session.focus(); return () => session.dismissOutcome(); }, [session]), );');
  });

  it('every touchable in the storefront is a named button, radio or link, in no other touchable', () => {
    for (const file of STOREFRONT_FILES) {
      const src = readFileSync(file, 'utf8');
      const sf = parseTsx(src, file);
      const found: { el: JsxNode; ancestors: JsxNode[] }[] = [];
      walkJsx(sf, (el, ancestors) => {
        if (TOUCHABLE_TAG.test(tagOf(el, sf))) found.push({ el, ancestors: [...ancestors] });
      });
      for (const p of found) {
        const role = attrText(p.el, 'accessibilityRole', sf);
        expect(role, `${path.relative(ROOT, file)} <${tagOf(p.el, sf)}>`).toMatch(/^"?(button|radio)"?$/);
        expect(attrText(p.el, 'accessibilityLabel', sf), path.relative(ROOT, file)).toBeDefined();
        expect(p.ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toEqual([]);
      }
    }
  });

  it('every sheet is the shared frame (sibling backdrop, the keyboard, 640 pt at most)', () => {
    const frame = codeOnly(read(SHEET_FRAME));
    expect(frame).toContain('accessibilityViewIsModal');
    expect(frame).toContain('onAccessibilityEscape={requestClose}');
    expect(frame).toMatch(/<KeyboardAvoidingView behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);
    expect(frame).toContain('const sheetWidth = storefrontLayout({ width, fontScale }).sheetWidth;');
    expect(frame).toContain('maxHeight: layout.sheetMaxHeight');
    for (const file of STOREFRONT_FILES) {
      const src = readFileSync(file, 'utf8');
      if (file.endsWith('storefront-sheet.tsx')) continue;
      expect(src, file).not.toMatch(/<Modal\b/);
    }
  });
});

describe('the cart, the lock and the send', () => {
  it('every change goes through the session (which refuses it while locked)', () => {
    for (const src of [catalog, checkout]) {
      expect(src).not.toMatch(/cartReducer\(/);
    }
    expect(checkout).toMatch(/onPress=\{\(\) => \{\s*notesDraft\.flush\(\);\s*void session\.submit\(offline\);\s*\}\}\s+disabled=\{blockedBy !== null \|\| firstSendOut\}/);
    expect(checkout).toContain('const blockedBy = session.submitBlockedBy(offline);');
    expect(checkout).toContain('accessibilityHint={blockedBy ?? undefined}');
  });

  it('Submit is gone while the cart is locked; the panel takes its place', () => {
    expect(checkout).toMatch(/\{locked \? null : \(\s*<Pressable\s+onPress=\{\(\) => \{\s*notesDraft\.flush\(\);\s*void session\.submit\(offline\);\s*\}\}/);
    expect(checkout).toMatch(/<UnconfirmedPanel\s+state=\{snap\.submission\.state\}/);
    expect(catalog).toMatch(/<UnconfirmedPanel\s+state=\{snap\.submission\.state\}/);
  });

  it('offline: Submit says it needs a connection (the session’s rule), and the panel’s sends are off', () => {
    const panel = codeOnly(read(PANEL));
    expect(panel).toContain('const sendHint = offline ? ORDER_NEEDS_CONNECTION_COPY : undefined;');
    expect(count(panel, 'disabled={waiting || offline}')).toBe(2);
  });

  it('a placed order replaces checkout with the success screen; the success screen leaves to Orders', () => {
    expect(checkout).toMatch(/if \(!placedId \|\| !focused\) return;[\s\S]*?router\.replace\('\/order\/new\/placed' as Href\);/);
    expect(flat(placed)).toContain('const leaveToOrders = () => { session.finishPlaced(); if (router.canDismiss()) router.dismissAll(); router.navigate(\'/orders\' as Href); };');
    expect(placed).toContain("router.dismissTo('/order/new' as Href);");
  });

  it('switching to Pickup clears the site (the web storefront’s rule)', () => {
    expect(flat(checkout)).toContain("patch: method === 'pickup' ? { fulfillmentType: 'pickup', charterId: null } : { fulfillmentType: 'delivery' },");
  });

  it('For follows the server’s canOrderOnBehalf (orders:approve) through the tested view; a kept cart for someone else says so and a tap sets Myself (F2)', () => {
    expect(checkout).toContain('const forRow = forRowView({ canOrderOnBehalf: ready.viewer.canOrderOnBehalf, onBehalfOf: cart.onBehalfOf, lockHint });');
    expect(checkout).toMatch(/\{forRow\.shown \? \(\s*<SetupRow\s+label=\{STOREFRONT_FOR_COPY\}\s+value=\{requesterRowValue\(cart\.onBehalfOf\)\}\s+detail=\{forRow\.detail\}\s+disabled=\{locked\}\s+hint=\{forRow\.hint\}/);
    expect(flat(checkout)).toContain("if (forRow.tap === 'choose') { setSheet({ kind: 'for' }); return; } if (session.dispatch({ type: 'set-setup', patch: { onBehalfOf: null } }) === null) { AccessibilityInfo.announceForAccessibility(STOREFRONT_FOR_NOW_MYSELF_COPY); }");
    expect(checkout).not.toMatch(/ready\.viewer\.canOrderOnBehalf \?/);
  });

  it('the needed-by picker is the one F2-4 uses, in the organization’s zone, with the server’s now', () => {
    expect(sheets).toMatch(/<NeededByPicker\s+view=\{view\}\s+draft=\{draft\}/);
    expect(codeOnly(read('src/components/revise-needed-by-sheet.tsx'))).toMatch(/<NeededByPicker\s+view=\{view\}\s+draft=\{draft\}/);
    expect(sheets).toContain('const clock = React.useCallback(() => Date.now() + serverSkewMs, [serverSkewMs]);');
    expect(checkout).toContain('const zone = storefrontNeededByZone(ready.orgTimezone);');
    expect(checkout).toContain('serverSkewMs={snap.serverSkewMs}');
  });
});

describe('nothing about an order is queued, written directly, or sent as anyone else', () => {
  it('no enqueue( names an order, and the outbox kinds are unchanged', () => {
    for (const file of PRODUCT_FILES) {
      const src = codeOnly(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/\benqueue\(\s*([^,)]+)/g)) {
        expect(m[1], file).not.toMatch(/order/i);
      }
    }
    const queue = read('src/lib/queue.ts');
    const kinds = queue.slice(queue.indexOf('export type PendingActionKind ='), queue.indexOf("| 'size_count_event';") + 21);
    expect([...kinds.matchAll(/\| '([a-z_]+)'/g)].map((m) => m[1])).toEqual([
      'adjust_stock',
      'receive_po_line',
      'record_count',
      'create_book',
      'distribute_bundle',
      'upload_image',
      'size_count_event',
    ]);
  });

  it('no product code inserts an order request directly', () => {
    for (const file of PRODUCT_FILES) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/from\(\s*['"]order_requests['"]\s*\)\s*\.insert/);
      expect(src, file).not.toMatch(/from\(\s*['"]order_request_lines['"]\s*\)\s*\.insert/);
      expect(src, file).not.toMatch(/rpc\(\s*['"](create_order_request|place_order_request)['"]/);
    }
  });

  it('every order call names the organization and the account (orgId, asUserId), through the tested calls', () => {
    const api = codeOnly(read('src/lib/order-storefront/api.ts'));
    expect(api).toContain('const scoped = (scope: OrderCallScope) => ({ orgId: scope.orgId, asUserId: scope.userId });');
    // Six calls: four reads pass it, the two POSTs spread it.
    expect(count(api, 'scoped(scope)')).toBe(6);
    expect(count(api, '...scoped(scope)')).toBe(2);
    const services = codeOnly(read('src/lib/order-storefront/services.ts'));
    expect(services).toContain('export const orderStorefrontApi = createOrderStorefrontApi((path, opts) => api(path, opts));');
    // Only the services module calls api() for orders.
    for (const file of PRODUCT_FILES) {
      const src = codeOnly(readFileSync(file, 'utf8'));
      if (file.endsWith('order-storefront/services.ts')) continue;
      expect(src, file).not.toMatch(/api\(\s*['"`]\/api\/v1\/orders(?:['"`?]|\/submissions|\/storefront|\/catalog)/);
    }
  });
});

describe('the success screen’s email', () => {
  it('built from the submission and offered to every placer: never gated by the order screen’s requester-only rule', () => {
    expect(placed).not.toMatch(/canRequestDelivery/);
    // The routing comes with the context taken at placed (PO-4 review).
    expect(placed).toMatch(/successEmailInput\(\{ placed, context \}\)/);
    expect(placed).toContain('prepareDeliveryRequest(emailInput, { transport: deliveryComposeTransport(nativeOutlook) })');
  });

  it('opens a draft only on a tap (one open per tap), never from an effect, and never says sent', () => {
    expect(count(placed, 'openDeliveryRequestDraft(')).toBe(1);
    expect(count(placed, 'runEmailOpen()') - count(placed, 'function runEmailOpen()')).toBe(2);
    expect(placed).toMatch(/onPress=\{handleEmailPress\}/);
    const hooks = /\b(?:React\.)?(useEffect|useLayoutEffect|useFocusEffect|useCallback|useMemo)\(/g;
    for (let m = hooks.exec(placed); m; m = hooks.exec(placed)) {
      const body = placed.slice(m.index, m.index + 500);
      expect(body.slice(0, body.indexOf('}, [') > 0 ? body.indexOf('}, [') : 500)).not.toMatch(/runEmailOpen|handleEmailPress|openDeliveryRequestDraft/);
    }
    expect(read(SCREENS.placed)).not.toMatch(/email (was )?sent|sent the email/i);
  });

  it('Review and approve follows the server’s approve gate (the effective orders:approve, never a viewer)', () => {
    // The server's canApproveOrders, as it was when the order was placed
    // (successContextFrom reads answer.viewer.canApproveOrders; PO-4 review).
    expect(placed).toContain('const canApprove = context?.canApproveOrders ?? false;');
    expect(placed).toContain('label={canApprove ? SUCCESS_REVIEW_AND_APPROVE_COPY : SUCCESS_VIEW_ORDER_COPY}');
    expect(placed).toContain('onPress={() => router.push(successOrderHref(order.id, canApprove) as Href)}');
  });
});

describe('signing out and signing back in', () => {
  it('the sign-out counts, settles, asks about and holds unconfirmed order requests', () => {
    const auth = codeOnly(read('src/lib/auth-context.tsx'));
    expect(auth).toContain('orderSubmissions: userId ? signOutOrderSubmissions(userId) : undefined,');
    expect(auth).toContain('const prompt = unsyncedPrompt(count, opts.canDiscard, opts.unconfirmedOrders ?? 0);');
  });

  it('the root checks this account’s held keys at sign-in (reads only)', () => {
    const layout = codeOnly(read('app/_layout.tsx'));
    expect(layout).toContain('useHeldOrderSubmissions(session?.user?.id ?? null, seeOrders);');
  });

  it('at sign-in: a dropped marker is said once, Don’t send it always says what happened, and no answer is offered again (F5)', () => {
    const runtime = flat(codeOnly(read('src/lib/order-storefront/runtime.ts')));
    expect(runtime).toContain('memberOrgIds: async () => (await loadOrgs(userId))?.map((o) => o.id) ?? null,');
    // The dropped sentence is the tested report's (heldCheckReport, PO-4 review).
    expect(runtime).toContain('for (const sentence of report.sentences) Alert.alert(sentence);');
    expect(runtime).toContain("void withdrawHeldSubmission(deps, hold) .catch((): HoldCheck => ({ outcome: 'unknown' })) .then((check) => { if (!current()) return; if (check.outcome === 'unknown') offered.current.delete(id); Alert.alert(heldWithdrawSentence(check)); }),");
  });
});

describe('the storefront’s words are core’s', () => {
  it('no storefront screen writes a sentence core already owns', () => {
    for (const file of STOREFRONT_FILES) {
      const src = codeOnly(readFileSync(file, 'utf8'));
      for (const sentence of [
        'Submit order request',
        'Check and finish',
        "Don't send it",
        'See my orders',
        'Place another order',
        'Review and approve',
        'Needs a connection.',
        'Your order request is not confirmed',
      ]) {
        const literal = new RegExp(`['"\`>]${sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`<]`);
        expect(src, `${path.relative(ROOT, file)}: ${sentence}`).not.toMatch(literal);
      }
    }
  });
});

describe('words that claim nothing untrue (desk check F6)', () => {
  const cartPanel = codeOnly(read(`${COMPONENTS}/cart-panel.tsx`));

  it('a cart line is drawn from the tested view: no mark until a catalog answer leaves it out, and never the mark as its title', () => {
    expect(cartPanel).toContain('const view = cartLineView(line, item, unorderable);');
    expect(cartPanel).toContain('const unorderable = notOrderable.has(line.itemId);');
    expect(cartPanel).toMatch(/<Body size=\{14\.5\} color=\{c\.ink\}>\s*\{view\.title\}\s*<\/Body>/);
    expect(cartPanel).toMatch(/\{view\.stepper \? \(\s*<Stepper/);
    expect(cartPanel).not.toContain('item ? item.name : STOREFRONT_LINE_NOT_ORDERABLE_COPY');
    expect(cartPanel).not.toContain('cartLineNote(');
  });

  it('the Orders tour does not tell someone with no + to tap +', () => {
    const tour = read('src/lib/onboarding.ts');
    expect(tour).not.toContain("body: 'Tap + to place an order request");
    expect(tour).toContain("body: 'If you can place orders, tap + to place an order request from your phone:");
  });

  it('the pickup hint and the success line take the warehouse name as it is (core leaves an empty one out)', () => {
    expect(checkout).toContain("{storefrontPickupHintCopy(warehouse?.name ?? '')}");
    expect(placed).toContain('{successReference(placed, warehouseName)}');
  });
});

describe('VoiceOver hears why, what and how much (desk check F7)', () => {
  const cartPanel = codeOnly(read(`${COMPONENTS}/cart-panel.tsx`));
  const kitRow = codeOnly(read(`${COMPONENTS}/kit-row.tsx`));

  it('the stepper carries the lock’s hint on all three of its buttons (F7.1)', () => {
    expect(count(controls, 'accessibilityHint={lockHint}')).toBe(2);
    expect(controls).toContain('accessibilityHint={lockHint ?? incHint}');
  });

  it('every dimmed Add, Add kit, stepper, Remove and Clear all says why (F7.1)', () => {
    expect(itemRow).toContain('hint={addBlockedHint({ locked, notOrderable })}');
    expect(itemRow).toContain('lockHint={changeLockedHint(locked)}');
    // The kit's Add kit takes the kit's own hint (simulator walk D2), which
    // gives the lock's words first.
    expect(kitRow).toContain('hint={kitAddBlockedHint({ locked, out, full: maxInCart < 1 })}');
    expect(kitRow).toContain('lockHint={changeLockedHint(locked)}');
    expect(cartPanel).toMatch(/label=\{CART_CLEAR_ALL_COPY\} variant="ghost" disabled=\{locked\} hint=\{changeLockedHint\(locked\)\}/);
    expect(cartPanel).toContain('hint={addBlockedHint({ locked, notOrderable: false })}');
    expect(cartPanel).toContain('lockHint={changeLockedHint(locked)}');
    expect(cartPanel).toMatch(/accessibilityLabel=\{view\.removeLabel\}\s+variant="ghost"\s+disabled=\{locked\}\s+hint=\{changeLockedHint\(locked\)\}/);
    expect(catalog).toContain('lockHint={changeLockedHint(locked)}');
    expect(catalog).toContain('hint={addBlockedHint({ locked, notOrderable: snap.notOrderable.has(sheetItem.id) })}');
    expect(catalog).toMatch(/label=\{KIT_ADD_COPY\}\s+variant="primary"\s+hint=\{kitAddBlockedHint\(\{ locked, /);
  });

  it('the row’s one label carries the rank and the can’t-be-ordered mark (F7.2)', () => {
    expect(itemRow).toContain('accessibilityLabel={itemRowLabel(item, quantity, earmark, { rank, notOrderable })}');
  });

  it('Remove never reads a uuid (F7.3)', () => {
    expect(cartPanel).not.toContain('`${STOREFRONT_REMOVE_COPY} ${name}`');
    expect(cartPanel).not.toContain('item?.name ?? line.itemId');
  });

  it('checkout announces each stepper change and Remove from what the cart is now (F7.4)', () => {
    expect(flat(checkout)).toContain("const changeLine = (action: Extract<CartAction, { type: 'inc' | 'dec' | 'remove' }>) => { if (session.dispatch(action) !== null) return; const said = lineChangeAnnouncement(session.getSnapshot(), action.itemId); if (said) AccessibilityInfo.announceForAccessibility(said); };");
    expect(checkout).toContain("onInc={(itemId) => changeLine({ type: 'inc', itemId })}");
    expect(checkout).toContain("onDec={(itemId) => changeLine({ type: 'dec', itemId })}");
    expect(checkout).toContain("onRemove={(itemId) => changeLine({ type: 'remove', itemId })}");
    expect(catalog).toMatch(/onRemove=\{\(itemId\) => \{\s*if \(session\.dispatch\(\{ type: 'remove', itemId \}\) !== null\) return;\s*const said = lineChangeAnnouncement\(session\.getSnapshot\(\), itemId\);\s*if \(said\) say\(said\);\s*\}\}/);
  });
});

describe('a keystroke in the notes never redraws every storefront screen (desk check F8.1)', () => {
  it('the notes field keeps what is typed and hands it to the tested draft; the store is never written per keystroke', () => {
    expect(checkout).toContain('const [notesDraft] = React.useState(() => createNotesDraft({ session }));');
    expect(checkout).toContain('React.useEffect(() => () => notesDraft.dispose(), [notesDraft]);');
    expect(checkout).toMatch(/<NotesField\s+key=\{`\$\{snap\.scope\?\.orgId \?\? ''\}:\$\{snap\.warehouseId \?\? ''\}`\}\s+initial=\{cart\.notes\}\s+locked=\{locked\}\s+lockHint=\{lockHint\}\s+draft=\{notesDraft\}/);
    // The keystroke also says the counter at 1,800 and at the limit (PO-4
    // review); it still only reaches the field and the draft.
    expect(checkout).toMatch(/<TextInput\s+defaultValue=\{initial\}\s+onChangeText=\{\(value\) => \{[^}]*?if \(said\) AccessibilityInfo\.announceForAccessibility\(said\);\s*setText\(value\);\s*draft\.change\(value\);\s*\}\}\s+onFocus=\{keyboard\.onNoteFocus\}\s+onBlur=\{\(\) => \{\s*draft\.flush\(\);\s*keyboard\.onNoteBlur\(\);\s*\}\}/);
    const keystroke = checkout.slice(checkout.indexOf('onChangeText={(value) => {'), checkout.indexOf('onFocus={keyboard.onNoteFocus}'));
    expect(keystroke).not.toMatch(/session\.|dispatch\(/);
    expect(checkout).not.toContain('value={cart.notes}');
    expect(checkout).not.toContain("type: 'set-notes'");
    expect(checkout).toContain('const counter = showNotesCounter(text) ? checkoutNotesCounterCopy(');
  });
});

describe('the success screen never comes back for an order already seen (desk check F10)', () => {
  it('the success screen marks the order shown; a storefront in focus follows the tested rule', () => {
    expect(flat(placed)).toContain('React.useEffect(() => { if (placedId) session.placedShown(); }, [placedId, session]);');
    expect(flat(catalog)).toContain("if (!placedId || !focused) return; const next = placedOnStorefrontFocus(session.getSnapshot().placed); if (next === 'show') router.push('/order/new/placed' as Href); else if (next === 'finish') session.finishPlaced();");
    expect(catalog).not.toContain("if (placedId && focused) router.push('/order/new/placed' as Href);");
  });
});

describe('the someone-new form refuses first what the server would refuse (desk check F11)', () => {
  it('Use this person follows the tested check and says why', () => {
    expect(sheets).toContain('const check = someoneNewCheck(name, email);');
    expect(sheets).toMatch(/label=\{CHECKOUT_USE_PERSON_COPY\}\s+variant="primary"\s+disabled=\{!check\.canUse\}\s+hint=\{check\.message \?\? undefined\}/);
    expect(sheets).toMatch(/\{check\.message \? \(\s*<Body size=\{13\} color=\{ACCENT\.crit\}>\s*\{check\.message\}/);
    expect(sheets).not.toContain("disabled={name.trim() === '' || email.trim() === ''}");
  });
});

// iPhone 17 simulator walk, 2026-10-05 (desk check F8.3 confirmed): tapping
// Manager notes in checkout brought the keyboard up over the field, so the
// person could not see what they typed. Checkout's body now keeps the note in
// view through the keyboard hook the exception and needed-by sheets use
// (lib/use-sheet-keyboard.ts, lib/sheet-field-reveal.ts). Mutations caught:
// the hook not wired to the body, the note not reporting focus, blur or where
// it sits, the column offset from the top of the content.
describe('checkout keeps Manager notes in view above the keyboard (simulator walk D3)', () => {
  const sf = parseTsx(read(SCREENS.checkout), SCREENS.checkout);
  const all: { el: JsxNode; ancestors: JsxNode[] }[] = [];
  walkJsx(sf, (el, ancestors) => all.push({ el, ancestors: [...ancestors] }));
  const a = (el: JsxNode, name: string) => attrText(el, name, sf);
  const body = all.find((n) => tagOf(n.el, sf) === 'ScrollView');

  it('the body scrolls through the keyboard hook', () => {
    expect(checkout).toContain('const [attachBody, kb] = useSheetKeyboard();');
    expect(body).toBeDefined();
    expect(a(body!.el, 'ref')).toBe('attachBody');
    expect(a(body!.el, 'onScroll')).toBe('kb.onBodyScroll');
    expect(a(body!.el, 'scrollEventThrottle')).toBe('16');
    expect(a(body!.el, 'onLayout')).toBe('kb.onBodyLayout');
    expect(a(body!.el, 'onContentSizeChange')).toBe('kb.onBodyContentSizeChange');
    expect(a(body!.el, 'keyboardDismissMode')).toBe('on-drag');
    expect(a(body!.el, 'keyboardShouldPersistTaps')).toBe('handled');
  });

  it('the reading column starts at the top of the content, so the note block reports its place in the body', () => {
    const container = a(body!.el, 'contentContainerStyle') ?? '';
    expect(container).not.toMatch(/padding(Vertical|Top)/);
    const column = all.find((n) => n.ancestors.at(-1) === body!.el);
    expect(column && tagOf(column.el, sf)).toBe('View');
    expect(a(column!.el, 'style') ?? '').toContain('paddingTop: 8');
  });

  it('the note reports focus, blur and where it sits; its block sits directly in the column; blur still commits the typing', () => {
    const notes = all.find((n) => tagOf(n.el, sf) === 'NotesField');
    expect(notes).toBeDefined();
    expect(a(notes!.el, 'keyboard')).toBe('kb');
    const fn = checkout.slice(checkout.indexOf('function NotesField('));
    expect(fn).toContain('onLayout={keyboard.onNoteBlockLayout}');
    expect(fn).toContain('onFocus={keyboard.onNoteFocus}');
    expect(fn).toContain('onLayout={keyboard.onNoteLayout}');
    expect(flat(fn)).toMatch(/onBlur=\{\(\) => \{ draft\.flush\(\); keyboard\.onNoteBlur\(\); \}\}/);
  });
});

describe('the kit row follows the tested stacking rule (simulator walk D1)', () => {
  it('stacks by kitRowStacked over the catalog row width, never by the font scale alone', () => {
    const kitRow = codeOnly(read(`${COMPONENTS}/kit-row.tsx`));
    expect(kitRow).toMatch(/const stacked = kitRowStacked\(\{\s*fontScale,\s*rowWidth:/);
    expect(kitRow).not.toContain('itemRowStacked(');
  });
});

describe('a dimmed Add kit says why (simulator walk D2)', () => {
  it('the kit row and the kit details sheet take the tested hint, with full = no kit fits beside the cart', () => {
    const kitRow = codeOnly(read(`${COMPONENTS}/kit-row.tsx`));
    expect(flat(kitRow)).toContain('hint={kitAddBlockedHint({ locked, out, full: maxInCart < 1 })}');
    expect(flat(catalog)).toMatch(/hint=\{kitAddBlockedHint\(\{ locked, out: kitAvailability\(sheetKit, snap\.itemMap\)\.kits < 1, full: /);
  });
});

// iPhone 17 simulator walk, 2026-10-05, after D3: with 1,850 characters in
// Manager notes the field grew under the keyboard, so the caret and the
// counter were hidden while typing (typing did not move the body: the reveal
// never scrolls on typing, by design). The field now has a fixed height and
// scrolls inside itself, where iOS keeps the caret in view, and the counter's
// line is kept from the start so the revealed block never grows under the
// keyboard. Mutations caught: the field growing again, the counter line
// appearing only at 1,800.
describe('long Manager notes keep the caret and the counter in view (simulator walk D5)', () => {
  const fn = checkout.slice(checkout.indexOf('function NotesField('));
  it('the field is a fixed height from the tested layout module and scrolls inside itself', () => {
    expect(checkout).toMatch(/notes: \{\s*height: NOTES_FIELD_HEIGHT,/);
    expect(checkout).not.toMatch(/notes: \{\s*minHeight/);
    expect(fn).not.toContain('scrollEnabled={false}');
  });
  it('the counter’s line is always there (blank and hidden from VoiceOver until 1,800)', () => {
    expect(flat(fn)).toContain('{counter ?? ' + "' '" + '}');
    expect(flat(fn)).toContain("importantForAccessibility={counter ? 'auto' : 'no-hide-descendants'}");
    expect(flat(fn)).toContain('accessibilityElementsHidden={counter === null}');
    expect(flat(fn)).not.toMatch(/showNotesCounter\(text\) \? \(/);
  });
});

// iPhone 17 simulator walk, 2026-10-05: with the keyboard up after typing
// someone new's email, "Order for them" sat at the bottom of the sheet's
// scrolling body, cut off by its edge, and a tap on the part showing did
// nothing (the iOS landmine: a control half hidden ignores taps). The action
// and its reason now sit in the sheet's footer, which stays above the
// keyboard. Mutation caught: the action back inside the body.
describe('For’s Order for them stays above the keyboard (simulator walk D6)', () => {
  it('the someone-new action and its reason are the sheet’s footer', () => {
    const fn = sheets.slice(sheets.indexOf('export function RequesterSheet('));
    const body = fn.slice(0, fn.indexOf('\nexport function ') > 0 ? fn.indexOf('\nexport function ') : undefined);
    const open = flat(body.slice(body.indexOf('<StorefrontSheet'), body.indexOf('<RadioRow')));
    expect(open).toMatch(/<StorefrontSheet visible title=\{STOREFRONT_FOR_COPY\} onClose=\{onClose\} footer=\{/);
    expect(open).toContain('label={CHECKOUT_USE_PERSON_COPY}');
    expect(open).toContain('{check.message ? (');
    const inBody = flat(body.slice(body.indexOf('<RadioRow')));
    expect(inBody).not.toContain('label={CHECKOUT_USE_PERSON_COPY}');
  });
});

// iPhone 17 simulator walk at AX5, 2026-10-05: a stacked item row kept its
// photo beside the name, so the name had about 280 pt and "Headphones" broke
// mid-word ("Headphone" / "s"). Past the row threshold the photo now sits
// above the name, which gets the row's full width. Mutation caught: the
// photo beside the name again.
describe('a stacked item row gives the name the full width (simulator walk D7)', () => {
  it('past the row threshold the photo goes above the name', () => {
    expect(itemRow).toContain('style={({ pressed }) => [styles.main, stacked && styles.mainStacked, { opacity: pressed ? 0.8 : 1 }]}');
    expect(flat(itemRow)).toMatch(/mainStacked: \{ flexDirection: 'column'/);
    expect(itemRow).toContain('<View style={stacked ? styles.textStacked : styles.text}>');
  });
});

// PO-4 review (MEDIUM, both lenses): checkout returned a Back chip and a
// spinner whenever the answer was not 'ready', so a refused or turned-off
// answer read again on checkout open (R1) hid the refusal and the unconfirmed
// panel behind a spinner that never ended. Mutations caught: the bare spinner
// back for every non-ready answer, the state drawn without the outcome or the
// panel, the panel not bound to the session's Check and finish and Don't send it.
describe('checkout says why when the storefront is not usable, never a spinner that does not end (PO-4 review)', () => {
  it('draws by the tested stage: the spinner only while loading', () => {
    expect(checkout).toContain('const stage = checkoutStage(snap);');
    expect(checkout).toMatch(/if \(stage === 'unavailable' && snap\) \{\s*return \(\s*<StorefrontState/);
    expect(checkout).not.toMatch(/if \(!snap \|\| !ready \|\| !snap\.cart\) \{\s*return \(\s*<View style=\{\{ flex: 1, backgroundColor: c\.paper \}\}>\s*<SafeAreaView edges=\{\['top'\]\}>/);
  });

  it('the turned-off or refused state carries the outcome and the unconfirmed panel bound to the session', () => {
    const at = checkout.indexOf("if (stage === 'unavailable' && snap) {");
    const state = checkout.slice(at, checkout.indexOf('/>\n    );', at) + 4);
    expect(state).toContain('outcome={outcome}');
    expect(state).toMatch(/panel=\{\s*<UnconfirmedPanel\s+state=\{snap\.submission\.state\}/);
    expect(state).toContain('onCheckAndFinish={() => void session.checkAndFinish()}');
    expect(state).toContain('onDontSend={() => void session.dontSend()}');
    expect(state).toContain('onRefresh={() => void refresh()}');
  });
});

// PO-4 review: the success screen drew from the answer shown now. Mutations
// caught: Review and approve, the warehouse's name or the email read from the
// live answer again.
describe('the success screen draws from what was true when it was placed (PO-4 review)', () => {
  it('one context, taken at placed (the live answer only when none was taken), feeds the approve gate, the reference line and the email', () => {
    expect(placed).toContain('const context = React.useMemo(() => (placed ? successContextFor(placed, live) : null), [placed, live]);');
    expect(placed).toContain("const warehouseName = context?.warehouseName ?? '';");
    expect(placed).toContain('const canApprove = context?.canApproveOrders ?? false;');
    expect(placed).toMatch(/successEmailInput\(\{ placed, context \}\)/);
    expect(placed).not.toMatch(/ready\?\.viewer\.canApproveOrders|ready\.deliveryRecipients/);
  });
});

// PO-4 review: the sign-in check's alerts came after a sign-out that happened
// while its reads were out. Mutations caught: the cleanup not ending the run,
// the epoch not compared, an alert before the check, the report bypassed.
describe('the sign-in check says nothing once its account has gone (PO-4 review)', () => {
  const runtime = flat(codeOnly(read('src/lib/order-storefront/runtime.ts')));
  it('each run is bound to the effect and the account epoch it started in, and is silent once either moved', () => {
    expect(runtime).toContain('let cancelled = false;');
    expect(runtime).toContain('const startEpoch = accountEpoch(); const current = () => !cancelled && accountEpoch() === startEpoch;');
    expect(runtime).toContain('const result = await checkHeldSubmissions({ ...deps, current }); if (!current()) return; const report = heldCheckReport(result, offered.current);');
    expect(runtime).toMatch(/return \(\) => \{ cancelled = true; sub\.remove\(\); \};/);
    expect(runtime).not.toContain('for (const label of result.placed)');
  });
});

// PO-4 review: an eviction removed every account's workspace keys, a live
// order key of another account (left by a revoked session) with them, with no
// marker. Mutations caught: the hold step dropped, run after the removal, or
// allowed to stop the eviction.
describe('the eviction holds every account’s live order request before it removes the workspace keys (PO-4 review)', () => {
  it('the account gate’s clearAccountStorage holds them first, and a failure there never stops it', () => {
    const gate = flat(codeOnly(read('src/lib/use-account-gate.ts')));
    expect(gate).toContain('try { await holdDeviceOrderSends(); } catch (e) {');
    expect(gate.indexOf('await holdDeviceOrderSends();')).toBeGreaterThan(gate.indexOf('endAccountEpoch();'));
    expect(gate.indexOf('await holdDeviceOrderSends();')).toBeLessThan(gate.indexOf('const keys = accountScopedStorageKeys(await AsyncStorage.getAllKeys());'));
    const services = flat(codeOnly(read('src/lib/order-storefront/services.ts')));
    expect(services).toContain('export function holdDeviceOrderSends(): Promise<void> { return holdEveryDeviceSend(orderStore); }');
  });
});

// PO-4 review (VoiceOver, code reading; the simulator has no VoiceOver): the
// submitted announcement was spoken in the same effect as the screen change,
// which cuts it off, and the success screen reached from the catalog said
// nothing; the stock notice, the For line after a re-read and the notes
// counter were never announced; every stacked panel spoke. Mutations caught:
// each announcement removed or ungated by focus.
describe('VoiceOver hears what changed, on the screen in view, once (PO-4 review)', () => {
  const panel = codeOnly(read(PANEL));
  it('the success screen announces the order itself, queued after the screen change, on every way in', () => {
    expect(flat(placed)).toContain(
      'const timer = setTimeout(() => { AccessibilityInfo.announceForAccessibilityWithOptions(submittedAnnouncement(order), { queue: true }); }, SCREEN_ANNOUNCE_DELAY_MS); return () => clearTimeout(timer); }, [placedId, session]);',
    );
    expect(checkout).not.toContain('submittedAnnouncement(');
  });

  it('the stock notice is announced on checkout and the catalog while each is in view', () => {
    for (const src of [checkout, catalog]) {
      expect(src).toContain('if (noticeText && focused) AccessibilityInfo.announceForAccessibility(noticeText);');
    }
  });

  it('checkout announces the For line when a read of the answer brings it', () => {
    expect(checkout).toContain('if (forDetail && focused) AccessibilityInfo.announceForAccessibility(forDetail);');
  });

  it('the unconfirmed panel speaks through the shared announcer, only on the screen in focus', () => {
    expect(panel).toContain('const focused = useIsFocused();');
    expect(panel).toContain('const said = panelAnnouncer.next(message, focused);');
    expect(panel).toContain('if (said) AccessibilityInfo.announceForAccessibility(said);');
    expect(panel).not.toContain('lastSpoken');
  });

  it('Manager notes’ counter is announced in words at 1,800 and at the limit, and reads as words', () => {
    const fn = checkout.slice(checkout.indexOf('function NotesField('));
    expect(flat(fn)).toContain('const said = notesCounterAnnouncement(before, value.length, ORDER_NOTES_MAX); if (said) AccessibilityInfo.announceForAccessibility(said);');
    expect(fn).toContain('accessibilityLabel={counter ? checkoutNotesCounterSpokenCopy(Array.from(text).length, ORDER_NOTES_MAX) : undefined}');
  });
});
