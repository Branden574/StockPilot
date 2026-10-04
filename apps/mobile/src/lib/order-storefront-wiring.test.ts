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
    expect(checkout).toMatch(/onPress=\{\(\) => void session\.submit\(offline\)\}/);
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

  it('a row is one element with its name, availability, earmark and quantity in the cart', () => {
    expect(itemRow).toContain('accessibilityLabel={itemRowLabel(item, quantity, earmark)}');
  });

  it('Pickup or Delivery is a radio group to VoiceOver; choices in sheets are radios', () => {
    expect(controls).toContain('accessibilityRole="radiogroup"');
    expect(count(controls, 'accessibilityRole="radio"')).toBe(2);
    expect(controls).toContain('accessibilityState={{ checked, disabled }}');
  });

  it('refusals and the unconfirmed panel are said in place and announced', () => {
    const panel = codeOnly(read(PANEL));
    expect(panel).toMatch(/<Body size=\{13\.5\} color=\{c\.ink\} accessibilityRole="alert">\s*\{message\}/);
    expect(panel).toContain('AccessibilityInfo.announceForAccessibility(`${ORDER_UNCONFIRMED_TITLE_COPY}. ${message}`);');
    expect(checkout).toMatch(/accessibilityRole="alert">\s*\{refusalText\}/);
    expect(checkout).toContain('if (refusalText) AccessibilityInfo.announceForAccessibility(refusalText);');
    expect(catalog).toContain('if (refusal) AccessibilityInfo.announceForAccessibility(refusal);');
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
    expect(checkout).toMatch(/onPress=\{\(\) => void session\.submit\(offline\)\}\s+disabled=\{blockedBy !== null \|\| firstSendOut\}/);
    expect(checkout).toContain('const blockedBy = session.submitBlockedBy(offline);');
    expect(checkout).toContain('accessibilityHint={blockedBy ?? undefined}');
  });

  it('Submit is gone while the cart is locked; the panel takes its place', () => {
    expect(checkout).toMatch(/\{locked \? null : \(\s*<Pressable\s+onPress=\{\(\) => void session\.submit\(offline\)\}/);
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

  it('For is offered only to someone who may order on behalf (the server’s canOrderOnBehalf: orders:approve)', () => {
    expect(checkout).toMatch(/\{ready\.viewer\.canOrderOnBehalf \|\| cart\.onBehalfOf !== null \? \(\s*<SetupRow\s+label=\{STOREFRONT_FOR_COPY\}/);
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
    expect(placed).toMatch(/successEmailInput\(\{\s*placed,\s*recipients: ready\.deliveryRecipients,/);
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
    expect(placed).toContain('const canApprove = ready?.viewer.canApproveOrders ?? false;');
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
