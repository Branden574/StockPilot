import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Wiring pins for the phone's exchange (returns RX-2). The mobile suite has
 * no React Native renderer, so this reads the files and pins what a screen
 * could otherwise lose silently:
 *
 *   - the workbench routes every replacement action (release, change, issue,
 *     cancel, get ready, open and hand over) and shows the REPLACEMENT side
 *     beside the returning card on the iPad;
 *   - every exchange action is ONLINE ONLY: the picker asks nothing offline
 *     and says so, the sheets' submit follows the live connection, and no
 *     outbox kind exists for one;
 *   - the order screen gives a replacement its banner, the return-first gate
 *     in place of the pick slip and Resume, the early release, no Add items,
 *     line edits or Cancel, and the create sheet's Exchange choice only while
 *     exchanges are on;
 *   - the orders list reads return_overview once per page for its chips.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the workbench', () => {
  const view = code(read('src/components/return-workbench-view.tsx'));

  it('routes every replacement action', () => {
    for (const [action, effect] of [
      ['release_early', "setSheet('release')"],
      ['cancel_replacement', "setSheet('cancel_replacement')"],
      ['change_replacement', "setSheet('change_replacement')"],
      ['issue_replacement', "setSheet('issue_replacement')"],
      // Desk check F9: the exchange ends for good after a replacement cancel.
      ['close_as_return_only', "setSheet('close_as_return_only')"],
      ['get_replacement_ready', 'void prepare()'],
    ] as const) {
      expect(view).toMatch(new RegExp(`case '${action}':\\s*${effect.replace(/[()]/g, '\\$&')};`));
    }
    expect(view).toMatch(/case 'open_replacement':\s*case 'hand_over':[\s\S]*?router\.push\(`\/order\/\$\{ex\.replacement\.orderId\}`/);
  });

  it('shows the REPLACEMENT side beside the returning card (stacked when compact), with a text label', () => {
    expect(view).toContain("pair: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }");
    expect(view).toContain('<Eyebrow>→ {RETURNS_COPY.replacement}</Eyebrow>');
    expect(view).toContain('replacementSideLines(x)');
    expect(view).toContain('replacementOrderLines(wb, wb.viewer.canReadDecisions)');
  });

  // Review fixes P4 and P21: after a declined or cancelled exchange VoiceOver
  // read every later step as "next" (the screen's own state words). The rail
  // is now core's words on screen and in its one VoiceOver label.
  it("prints the rail and reads it to VoiceOver in core's words (review fixes P4 and P21)", () => {
    expect(view).toContain('accessibilityLabel={exchangeRailAccessibilityLabel(ex.rail)}');
    expect(view).toContain('{exchangeRailText(ex.rail)}');
    expect(view).not.toContain("'next'");
    expect(view).not.toContain("' (now)'");
  });

  it('labels an exchange approval "Approve return & exchange"', () => {
    expect(view).toContain('actionLabel(actions.primary, { hasExchange })');
  });

  // RX-2 simulator finding SIM-1: VoiceOver reads the REPLACEMENT card's one
  // label, so the label carries the status the pill shows, and both come from
  // core's exchangeLineStatusLabel (the web pill's rule), never a local ternary.
  it("reads the REPLACEMENT card's status to VoiceOver, from the pill's own rule", () => {
    expect(view).toContain('accessibilityLabel={replacementCardLabel(name, x)}');
    expect(view).toContain('<Pill dot={false}>{exchangeLineStatusLabel(x.status)}</Pill>');
    expect(view).not.toContain("'Declined'");
    expect(code(read('src/lib/returns-view.ts'))).toContain('exchangeLineStatusLabel(x.status)');
  });
});

describe('online only', () => {
  const picker = code(read('src/components/replacement-picker-list.tsx'));
  const sheet = code(read('src/components/return-action-sheet.tsx'));
  const release = code(read('src/components/release-replacement-sheet.tsx'));

  it('the picker asks nothing offline and says it needs a connection', () => {
    expect(picker).toMatch(/if \(!online\) return;/);
    expect(picker).toContain('READINESS_NEEDS_CONNECTION_COPY');
    expect(picker).toContain('const off = disabled || !online;');
  });

  // RX-2 simulator finding SIM-3 (iPhone 17 at AX5): each row put the name
  // beside its availability and cut the name at two lines, so every row read
  // "Walk Exc…" and the size, the one thing that tells the rows apart, was
  // lost. Past the AX threshold (shouldStackRow) the row stacks, the name on
  // the full width and the availability under it, and the name is never cut
  // (the Dynamic Type policy: item names are never capped).
  it('stacks each row at the largest text sizes and never cuts the name', () => {
    expect(picker).toContain('const stacked = shouldStackRow(fontScale);');
    expect(picker).toMatch(/flexDirection: stacked \? 'column' : 'row'/);
    expect(picker).not.toMatch(/numberOfLines=/);
  });

  it('the sheets follow the live connection before anything else', () => {
    expect(sheet).toMatch(/const disabledReason = !online\s*\?\s*READINESS_NEEDS_CONNECTION_COPY/);
    expect(release).toMatch(/const disabledReason = !online\s*\?\s*READINESS_NEEDS_CONNECTION_COPY/);
  });

  it('the exchange calls are plain requests, never queued', () => {
    const client = code(read('src/lib/returns-api.ts'));
    for (const fn of ['changeReturnReplacement', 'cancelReturnReplacement', 'releaseReturnReplacement', 'prepareReturnReplacement']) {
      expect(client).toContain(`export function ${fn}(`);
    }
    expect(client).not.toMatch(/from '\.\/(queue|outbox|db|sync)'/);
    expect(code(read('src/lib/queue.ts'))).not.toMatch(/replacement|exchange/i);
  });

  // Desk check F7: the release names the replacement the screen shows and
  // the replacement cancel the revision it shows; the server answers
  // return_changed for anything newer.
  it('the release names the shown replacement and the cancel the shown revision', () => {
    const client = code(read('src/lib/returns-api.ts'));
    expect(client).toContain("return replacementCall(id, '/release', { orderId, reason });");
    expect(client).toContain('body: { expectedRevision: number; reason: string },');
    expect(sheet).toContain('const shownOrderId = shown?.live ? shown.orderId : null;');
    expect(sheet).toContain('releaseReturnReplacement(id, shownOrderId, reasonText)');
    expect(sheet).toContain('cancelReturnReplacement(id, { expectedRevision: wb.revision, reason: reasonText })');
  });

  // When the sheet shows no live replacement (its read failed, or it changed)
  // the release sends nothing and frees the sheet: never stuck on "Saving…",
  // which also blocks Close, the backdrop and the escape. No refusal path in
  // the sheet returns while still busy.
  it('a release with no live replacement shown frees the sheet, and no refusal returns while busy', () => {
    expect(sheet).toMatch(/if \(!shownOrderId\) \{\s*setError\(RETURN_ERROR_WORDS\.returnChanged\);\s*setBusy\(false\);\s*return;\s*\}/);
    expect(sheet.match(/setError\([^;]*\);\s*return;/g) ?? []).toEqual([]);
  });

  // Desk check F6: a refused delivery site asks where the replacement goes
  // (the warehouse's sites, or pickup) and sends the same request again.
  it('a refused delivery site asks where the replacement goes and sends the choice', () => {
    expect(sheet).toContain("step.reason === 'replacement_site_not_available'");
    // Re-pinned on purpose by simulator finding SIM-5 (below): the refusal now
    // opens the question through askSite.
    expect(sheet).toContain("if (returnErrorReason(e) === 'replacement_site_not_available') askSite(describeReturnError(e));");
    expect(sheet).toContain('const siteOptions = replacementSiteOptions(ex.deliverySites ?? []);');
    expect(sheet).toContain('replacement: { whenShort, ...(siteValue ?? {}) }');
    expect(sheet).toContain('...(siteValue ? { replacement: siteValue } : {}),');
    expect(sheet).toMatch(/sitePrompt && !siteValue\s*\?\s*RETURNS_COPY\.chooseSite/);
  });

  // RX-2 simulator finding SIM-5 (iPhone 17 at AX5): after a refused site the
  // sheet pinned the refusal under "Choose where the replacement goes.", two
  // lines asking the same thing; with the title they left the body no height,
  // so the sites could not be reached and the button sat partly off screen.
  // The question in the body says why; the refusal is announced, not pinned.
  it('a refused delivery site is asked in the body and announced, never pinned as a second line', () => {
    expect(sheet).toMatch(
      /function askSite\(words: string\) \{\s*setSitePrompt\(true\);\s*setError\(null\);\s*AccessibilityInfo\.announceForAccessibility\(words\);\s*\}/,
    );
    expect(sheet).toContain('askSite(stepOutcomeMessage(step, res.workbench, itemIsHere));');
    expect(sheet.match(/setSitePrompt\(true\)/g)).toHaveLength(1);
  });

  // Review fix P1: an approver with Manage returns but without order approval
  // saw no exchange choices and was refused "Choose what happens to every
  // returned line." (no decision was sent). The review now shows for every
  // returns manager, its rows are core's (approve and change off, their
  // labels ending with the reason; the decline open and chosen first), and
  // the approval always sends the decisions the review holds.
  it('shows the exchange review to every returns manager and always sends its decisions (review fix P1)', () => {
    expect(sheet).not.toContain('canDecideExchange');
    expect(sheet).toContain('exchangeReviewOptions(x, wb.viewer)');
    expect(sheet).toContain('const v = exchangeReviewStateFor(wb, reviews, x.id);');
    expect(sheet).toContain("const exchangeProblems = mode === 'approve' ? exchangeReviewProblems(wb, reviews, adds) : [];");
    expect(sheet).toContain("const exchange = mode === 'approve' ? exchangeApprovalDecisions(wb, reviews, adds) : [];");
    // An added replacement needs order approval: never offered without it.
    expect(sheet).toContain('if (!ex.createEnabled || l.applied || !wb.viewer.canApproveOrders) return null;');
  });

  // Review fix P2: Cancel return, Cancel replacement, Change replacement and
  // Issue a new replacement say what happens to the replacement, from core
  // (exchangeSheetConsequences over exchangeActionConsequences), first in the
  // body; the picked and in-transit warnings are core's keys, announced as
  // alerts, never the sheet's own checks of the replacement's class.
  it('the four replacement sheets say what happens to it, from core (review fix P2)', () => {
    expect(sheet).toContain('const consequences = exchangeSheetConsequences(mode, wb);');
    expect(sheet).toMatch(/\{consequences\.map\(\(t\) => \(\s*<Body\s+key=\{t\.key\}/);
    expect(sheet).toContain("accessibilityRole={t.key === 'effect' ? 'text' : 'alert'}");
    expect(sheet).not.toContain("ex.replacement?.class === 'drawn'");
    expect(sheet).not.toContain("ex.replacement?.status === 'in_transit'");
    // First in the body, before the destinations, the review and the reason.
    const body = sheet.slice(sheet.indexOf('<ScrollView'));
    expect(body.indexOf('{consequences.map(')).toBeLessThan(body.indexOf('{needsDestinations'));
  });

  // Desk check F9: "Close as return only" sends the revision the sheet shows
  // and a reason, through its own plain request (never queued).
  it('Close as return only sends the shown revision and a reason', () => {
    const client = code(read('src/lib/returns-api.ts'));
    expect(client).toContain('export function declineReturnReplacement(');
    expect(client).toContain("return replacementCall(id, '/decline', body);");
    expect(sheet).toContain('declineReturnReplacement(id, { expectedRevision: wb.revision, reason: reasonText })');
    expect(sheet).toMatch(/mode === 'close_as_return_only' \|\|/);
  });
});

// RX-2 simulator finding SIM-2 (iPhone 17 at AX5): the order screen's release
// sheet ran off the top of the screen. It now has the exception sheets' shape
// (pinned in exception-sheets-keyboard-wiring.test.ts); here, what is
// particular to it: the presets scroll with the reason, the title and the
// button stay on screen, and its content remounts per opening (one keyboard
// hook and a fresh reason each time).
describe("the order screen's release sheet", () => {
  const src = code(read('src/components/release-replacement-sheet.tsx'));

  it('scrolls the presets and the reason in the body; the title and the button stay on screen', () => {
    const open = src.indexOf('<ScrollView');
    const close = src.indexOf('</ScrollView>');
    expect(open).toBeGreaterThan(-1);
    const body = src.slice(open, close);
    expect(body).toContain('RETURNS_COPY.releasePresetInPerson');
    expect(body).toContain('RETURNS_COPY.releasePresetDeliverySwap');
    expect(body).toContain('<TextInput');
    expect(src.indexOf('accessibilityRole="header"')).toBeLessThan(open);
    expect(close).toBeLessThan(src.indexOf('<Button'));
  });

  it('remounts its content per opening', () => {
    expect(src).toMatch(/<ReleaseSheetContent\s+key=\{String\(visible\)\}/);
  });
});

describe('the order screen', () => {
  const screen = code(read('app/order/[id].tsx'));

  it('a replacement gets its banner, the gate in place of the pick slip, and the early release', () => {
    expect(screen).toContain('orderReplacementLines(');
    // Desk check F3: the pick slip and Resume are also blocked once the RMA
    // was cancelled or denied (replacementPickBlocked, the web panel's rule).
    expect(screen).toContain('managerActions.generatePickSlip && !replacementPickBlocked(order.replacement)');
    expect(screen).toContain('waitingForReturnLine(order.replacement.returnNumber)');
    expect(screen).toContain('<ReleaseReplacementSheet');
    // Desk check F7: the release names this order (the one the screen shows).
    expect(screen).toContain('releaseReturnReplacement(order.replacement.returnId, order.id, reason)');
    expect(screen).toContain('{replacementPickBlocked(order.replacement) ? null : stockGates.resume');
  });

  it('a replacement has no Add items, line edits or Cancel order (they live in its RMA)', () => {
    expect(screen).toContain('const canAddItems = canAddOrderItems(lineGate) && !isReplacementOrder;');
    expect(screen).toContain('const canEditItems = canEditOrderLines(lineGate) && !isReplacementOrder;');
    // Main's L93 moved Cancel into one offer for every open status (core's
    // orderCancelOffer); a replacement gets none, as on the web.
    expect(screen).toContain('const cancelOffer = isReplacementOrder ? null : phoneOrderCancel({');
    expect(screen).toContain('changeInRmaLabel(order.replacement)');
  });

  it("the create sheet offers Exchange only while exchanges are on, and the picker asks by order", () => {
    expect(screen).toContain('{exchangesEnabled && d.quantity > 0 ? (');
    expect(screen).toContain('getOrderExchangeCandidates(id, l.orderRequestLineId, q)');
  });

  // Desk check F9: the kill switch is read when the create sheet opens (one
  // light read), and the whole order is read only for a replacement's
  // banner, never for every completed order the screen opens.
  it('reads the exchange switch when the create sheet opens, and the order route only for a replacement', () => {
    // The answer is kept with the key of the sheet that asked: a late answer
    // for an earlier opening never shows, and no ref is read in a handler
    // passed down during render (React Compiler's refs rule).
    expect(screen).toMatch(
      /function openReturnSheet\(\) \{\s*const sheetKey = mintReturnKey\(\);\s*void getExchangeSwitch\(\)\.then\(\(on\) => setExchangeSwitch\(\{ sheetKey, on \}\)\);/,
    );
    expect(screen).toContain('setReturnKey(sheetKey);');
    expect(screen).toContain(
      'const exchangesEnabled = exchangeSwitch !== null && exchangeSwitch.sheetKey === returnKey && exchangeSwitch.on;',
    );
    expect(screen).not.toContain('exchangeSwitchRead');
    expect(screen).toMatch(/if \(replacementForReturnId\) \{\s*try \{\s*const extras = await api</);
    expect(screen).not.toMatch(/replacementForReturnId \|\| shouldLoadOrderReturns/);
    expect(screen).not.toContain('order?.exchangesEnabled');
    const client = code(read('src/lib/returns-api.ts'));
    expect(client).toContain("const res = await api<{ exchangesEnabled?: boolean }>('/api/v1/returns/exchange-switch');");
  });

  it('the original order names each exchange from one batched read', () => {
    expect(screen).toContain(".from('return_overview')");
    expect(screen).toContain('exchangeLinesByReturn(ovRows,');
    expect(screen).toContain('(r.exchangeLines ?? []).map(');
  });
});

describe('the orders list', () => {
  it('reads return_overview once per page, only for replacement rows', () => {
    const list = code(read('src/screens/orders.tsx'));
    expect(list.match(/\.from\('return_overview'\)/g)?.length).toBe(1);
    expect(list).toContain('if (replacementReturnIds.length > 0) {');
    expect(list).toContain('orderExchangeChip(');
  });

  // RX-2 simulator finding SIM-4 (iPhone 17 at AX5): the status pill and the
  // Exchange chip beside it took the whole card header, and the order number
  // and requester vanished (SO-000036 showed only its two pills). Past the AX
  // threshold (shouldStackRow) the header stacks: the order number and the
  // requester on the full width, the pills under them.
  it('stacks the card header at the largest text sizes, so the chip never hides the order number', () => {
    const list = code(read('src/screens/orders.tsx'));
    expect(list).toContain('const stacked = shouldStackRow(fontScale);');
    expect(list).toContain('<View style={stacked ? undefined : { flex: 1, minWidth: 0 }}>');
    expect(list).toContain("<View style={{ alignItems: stacked ? 'flex-start' : 'flex-end', gap: 6 }}>");
  });
});
