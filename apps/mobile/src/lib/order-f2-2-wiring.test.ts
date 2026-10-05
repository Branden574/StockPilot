import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { parseTsx } from './__fixtures__/jsx-touch-audit';

/**
 * F2-2 CALL-SITE PINS (the SO-000100 slice). The order screen, the digital
 * pick and the two line sheets import native modules, so vitest cannot render
 * them; every decision lives in a tested module (lib/pick-completion.ts,
 * lib/order-departure.ts, lib/order-hold.ts, components/edit-order-line.ts,
 * and core), and these pins keep the screens wired to them. Each names the
 * mutation it catches: deleting the confirm call, or going around it.
 *
 *   - the digital pick's Complete opens core's completion confirm;
 *   - staging (pickup and delivery), Mark in transit, Collect signature and
 *     Physical signature each go through the departure confirm, and so does
 *     a packing slip scanned on the Scan tab (it opens the signature pad);
 *   - "Hold available stock" on the readiness card, and the hold said after
 *     an add or a raise;
 *   - a short line's fixes in the line sheet.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(MOBILE_ROOT, file), 'utf8');

const SCREEN_FILE = 'app/order/[id].tsx';
const screen = read(SCREEN_FILE);
const digitalPick = read('src/components/digital-pick.tsx');
const summary = read('src/components/order-readiness-summary.tsx');
const editSheet = read('src/components/edit-order-line-sheet.tsx');
const addSheet = read('src/components/add-order-items-sheet.tsx');
const SCAN_FILE = 'app/(drawer)/(tabs)/scan.tsx';
const scanTab = read(SCAN_FILE);

/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** A node's text with its comments dropped, whitespace collapsed and
 *  trailing commas removed (a reformat cannot break a pin). */
function flat(node: ts.Node, sf: ts.SourceFile): string {
  return codeOnly(node.getText(sf))
    .replace(/\s+/g, ' ')
    .replace(/,(\s*[)}\]])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

/** Every call of `name(...)` in a file. */
function callsOf(
  src: string,
  file: string,
  name: string,
): { call: ts.CallExpression; sf: ts.SourceFile }[] {
  const sf = parseTsx(src, file);
  const out: { call: ts.CallExpression; sf: ts.SourceFile }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      out.push({ call: n, sf });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The onPress (third argument) of the screen's actionBtn with this label. */
function actionPress(label: string): string {
  const hits = callsOf(screen, SCREEN_FILE, 'actionBtn').filter(({ call }) => {
    const first = call.arguments[0];
    return first !== undefined && ts.isStringLiteral(first) && first.text === label;
  });
  expect(hits, `actionBtn('${label}')`).toHaveLength(1);
  const { call, sf } = hits[0]!;
  return flat(call.arguments[2]!, sf);
}

/** The body of a function declared in a file (`function name(` or `async function name(`). */
function functionBody(src: string, file: string, name: string): string {
  const sf = parseTsx(src, file);
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) found = flat(n.body, sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(found, `function ${name}`).not.toBeNull();
  return found!;
}

describe('the digital pick asks before it completes (SO-000100)', () => {
  const body = () => functionBody(digitalPick, 'digital-pick.tsx', 'onCompleteClick');

  // Mutation caught: deleting the confirm (Complete went straight through, as
  // it did on SO-000100), or showing it only when something is short.
  it('Complete opens core’s completion confirm over what the picker entered, and the screen’s readiness', () => {
    const b = body();
    expect(b).toMatch(/const confirm = digitalPickCompletionConfirm\(lines\.map\(\(l\) => \{/);
    expect(b).toContain("picking: clampFor(l, qty[l.id] ?? '0')");
    expect(b).toMatch(/\}\), readiness\);/);
    expect(b).toContain(
      'if (confirm) { Alert.alert(confirm.title, completionConfirmMessage(confirm), completionConfirmButtons(confirm, { onReview: reviewLine, onComplete: () => void complete() }));',
    );
    // The confirm returns; only a null confirm completes at once.
    expect(b).toMatch(/return; \} void complete\(\); \}$/);
  });

  // Mutation caught: a phone copy of the decision drifting from the web's.
  it('the decision is core’s one definition (the web digital pick’s), never a phone copy', () => {
    expect(codeOnly(digitalPick)).toMatch(
      /import \{[^}]*\bdigitalPickCompletionConfirm,[^}]*\} from '@stockpilot\/core';/,
    );
    for (const file of [
      'src/lib/pick-completion.ts',
      'src/components/digital-pick.tsx',
      SCREEN_FILE,
    ]) {
      expect(codeOnly(read(file)), file).not.toMatch(/function digitalPickCompletionConfirm\b/);
    }
  });

  it('nothing else completes: the Complete button runs onCompleteClick, and complete() is called only there', () => {
    const code = codeOnly(digitalPick);
    expect(code).toMatch(/<Pressable\s+onPress=\{onCompleteClick\}/);
    expect(code.match(/void complete\(\)/g)).toHaveLength(2);
    expect(body().match(/void complete\(\)/g)).toHaveLength(2);
    expect(code).not.toContain('Ship short and backorder the rest?');
  });

  // The web digital pick's behaviour (its Review focuses the pick quantity,
  // pick-line-<id>): the confirm's line comes from what the picker TYPED, so
  // Review takes them to that count. Mutation caught (review 2026-09-28):
  // opening the order-line editor instead, which on a line readiness calls
  // ready offers no fix and steers a manager who mistyped a count into
  // changing the customer's order.
  it('Review short lines focuses the short line\'s pick quantity, as on the web, never the order-line editor', () => {
    expect(functionBody(digitalPick, 'digital-pick.tsx', 'reviewLine')).toBe(
      '{ if (lineId) inputs.current[lineId]?.focus(); }',
    );
    expect(codeOnly(digitalPick)).toMatch(
      /ref=\{\(el\) => \{\s*inputs\.current\[line\.id\] = el;\s*\}\}/,
    );
    expect(codeOnly(digitalPick)).not.toMatch(/onReviewLine/);
  });

  // Mutation caught: not handing readiness over (the confirm would always say
  // stock couldn't be checked), or handing the pick the line opener again.
  it('the screen hands the pick its readiness, and no line opener', () => {
    const code = codeOnly(screen);
    expect(code).toMatch(/<DigitalPick[\s\S]*?readiness=\{order\.readiness\}[\s\S]*?\/>/);
    const pick = code.match(/<DigitalPick[\s\S]*?\/>/)![0];
    expect(pick).not.toMatch(/onReviewLine|openShortLine/);
  });
});

describe('the departure confirm guards every step that takes the order further from the shelf', () => {
  // Mutation caught (each): calling act / the signature flow directly again.
  it.each([
    [
      'Mark staged for pickup',
      "() => confirmDeparture('stage', () => void act({ action: 'stage', target: 'staged_for_pickup' }, 'stage'))",
    ],
    [
      'Mark staged for delivery',
      "() => confirmDeparture('stage', () => void act({ action: 'stage', target: 'staged_for_delivery' }, 'stage'))",
    ],
    [
      'Mark in transit',
      "() => confirmDeparture('in_transit', () => void act({ action: 'mark_in_transit' }, 'transit'))",
    ],
    ['Collect signature', "() => confirmDeparture('signature', collectSignature)"],
    ['Physical signature', "() => confirmDeparture('signature', promptPhysicalSignature)"],
  ])('%s', (label, press) => {
    expect(actionPress(label)).toBe(press);
  });

  it('nothing reaches those steps another way', () => {
    const code = codeOnly(screen);
    expect(code.match(/action: 'stage', target:/g)).toHaveLength(2);
    expect(code.match(/\{ action: 'mark_in_transit' \}/g)).toHaveLength(1);
    expect(code.match(/action: 'confirm_physical_signature'/g)).toHaveLength(1);
    // The signature pad opens only from collectSignature, and the paper
    // signature only from promptPhysicalSignature.
    expect(code.match(/setSignatureModalVisible\(true\)/g)).toHaveLength(1);
    // Two prompts: the paper signature's, and Cancel's reason (L93), each in
    // its own function.
    expect(code.match(/Alert\.prompt\(/g)).toHaveLength(2);
    expect(functionBody(screen, SCREEN_FILE, 'promptPhysicalSignature')).toContain('Alert.prompt(');
    expect(functionBody(screen, SCREEN_FILE, 'promptCancel')).toContain('Alert.prompt(');
    expect(functionBody(screen, SCREEN_FILE, 'promptCancel')).not.toContain('confirm_physical_signature');
    expect(functionBody(screen, SCREEN_FILE, 'promptPhysicalSignature')).toContain(
      "{ action: 'confirm_physical_signature', signerName: signer }",
    );
    expect(code.match(/\bcollectSignature\b/g)).toHaveLength(2); // declared + guarded
    expect(code.match(/\bpromptPhysicalSignature\b/g)).toHaveLength(2);
  });

  // Mutation caught: going ahead without asking when the risk is there, or
  // asking when there is none.
  it('asks with core’s risk, goes ahead at once when nothing is short, and Fix the order opens the line', () => {
    expect(functionBody(screen, SCREEN_FILE, 'confirmDeparture')).toBe(
      '{ const risk = order ? orderDepartureRisk(order, action) : null; if (!risk) { proceed(); return; } Alert.alert(risk.title, risk.message, departureConfirmButtons(risk, { onFix: openShortLine, onProceed: proceed })); }',
    );
  });

  it('the line opener opens only a line the viewer may change, online, on screen', () => {
    expect(functionBody(screen, SCREEN_FILE, 'openShortLine')).toBe(
      '{ if (!lineId || !canEditItems || offline || !order) return false; if (!order.lines.some((l) => l.orderRequestLineId === lineId)) return false; setEditLineId(lineId); return true; }',
    );
  });

  it('out for delivery, the card says the lines are final (core’s note), in both of its forms', () => {
    const code = codeOnly(screen);
    expect(code).toContain(
      'const shortLinesFinalNote = order ? orderShortLinesFinalNote(order.lines, order.status) : null;',
    );
    expect(code.match(/\{shortLinesFinalNote \? \(/g)).toHaveLength(2);
    expect(code.match(/\{shortLinesFinalNote\}/g)).toHaveLength(2);
  });
});

// Review 2026-09-28: the Scan tab's packing-slip QR opened the signature pad
// (a hand-over) with no departure confirm. Mutation caught (each): opening
// the pad straight from the scan again, or asking without core's risk.
describe('the Scan tab asks before a scanned packing slip is signed', () => {
  // Migration 0389: the order is read through POST
  // /api/v1/orders/signature-lookup in the scan tab's organization (the order
  // row holds the token's sha256, so a direct member read finds nothing).
  it("the slip's order is read and core's risk asked before the pad opens; Fix the order opens the order", () => {
    const code = codeOnly(scanTab);
    expect(code).toMatch(
      /const signToken = parseSignToken\(data\);\s*if \(signToken\) \{\s*const scanned = await readSignatureOrder\(\s*\(path, body\) => api\(path, \{ method: 'POST', body, orgId \}\),\s*signToken,?\s*\);\s*const risk = scanSignatureDeparture\(scanned\);\s*setBusy\(false\);\s*if \(!risk\) \{\s*openSignaturePad\(signToken\);\s*return;\s*\}\s*Alert\.alert\(risk\.title, risk\.message, departureConfirmButtons\(risk, \{/,
    );
    expect(code).toMatch(/onProceed: \(\) => openSignaturePad\(signToken\),/);
    expect(code).toMatch(
      /onFix: \(lineId\) => \{\s*reset\(\);\s*if \(lineId && scanned\) router\.push\(`\/order\/\$\{scanned\.orderId\}` as Href\);\s*\},/,
    );
  });

  it('the pad opens only through openSignaturePad', () => {
    const code = codeOnly(scanTab);
    expect(functionBody(scanTab, SCAN_FILE, 'openSignaturePad')).toBe(
      '{ setSignatureToken(token); setSignatureModalVisible(true); }',
    );
    expect(code.match(/setSignatureModalVisible\(true\)/g)).toHaveLength(1);
    expect(code.match(/openSignaturePad\(signToken\)/g)).toHaveLength(2);
  });
});

describe('Hold available stock, and the hold after an add or a raise', () => {
  // Mutation caught: offering the button to everyone, or with the phone's
  // own rule instead of core's (the web strip's).
  it('the readiness card offers it by core’s rule, to approvers', () => {
    const code = codeOnly(screen);
    expect(code).toMatch(
      /const offerHold =\s*readinessShown &&\s*shouldOfferHoldStock\(\{\s*assessment: order\?\.readiness\?\.state === 'ok' \? order\.readiness\.assessment : null,\s*canApproveOrders: rpApprove,\s*\}\);/,
    );
    expect(code).toMatch(
      /hold=\{\s*offerHold\s*\? \{\s*busy: acting === 'hold',\s*disabled: acting !== null,\s*onPress: \(\) => void holdStock\(\),\s*\}\s*: null\s*\}/,
    );
  });

  it('pressing it holds, says what was held (or why not), then reads the order again', () => {
    expect(functionBody(screen, SCREEN_FILE, 'holdStock')).toBe(
      "{ if (!id || acting !== null) return; setActing('hold'); try { const result = await holdOrderStock(id); Alert.alert(HOLD_AVAILABLE_STOCK_LABEL, describeHoldResult(result)); } catch (e) { Alert.alert(HOLD_REFUSED_TITLE, describeHoldError(e)); } finally { setActing(null); } await load(); }",
    );
  });

  it('the card’s button is core’s label, 44 pt, and disabled offline or while anything runs', () => {
    const s = codeOnly(summary);
    expect(s).toMatch(
      /\{hold \? \(\s*<Button\s+size="sm"\s+variant="outline"\s+disabled=\{offline \|\| checking \|\| hold\.disabled\}\s+onPress=\{hold\.onPress\}/,
    );
    expect(s).toContain("{hold.busy ? 'Holding...' : HOLD_AVAILABLE_STOCK_LABEL}");
    expect(s).toMatch(
      /accessibilityHint="Holds the stock that is free now for this order's lines"/,
    );
  });

  // Mutation caught: dropping the hold from the confirmation (a failed hold
  // after an add would go unsaid, pattern #28).
  it('an add and a raise say what their hold did, in core’s words', () => {
    const code = codeOnly(screen);
    expect(code).toContain(
      "Alert.alert('Items added', withHoldNotice(addedSummary(res), holdTopUpNotice(res.hold, 'added')));",
    );
    expect(code).toMatch(
      /'Quantity updated',\s*withHoldNotice\(lineQuantitySummary\(line, res\), holdTopUpNotice\(res\.hold, 'raised'\)\),/,
    );
  });

  // Mutation caught: the sheets dropping `hold` from the route's answer.
  it('both line sheets pass the route’s hold through, read defensively', () => {
    expect(codeOnly(addSheet)).toContain('hold: parseHoldOutcome(res.hold),');
    expect(codeOnly(editSheet)).toContain('hold: parseHoldOutcome(res.hold),');
  });
});

describe('a short line’s fixes in the line sheet (decision D18)', () => {
  it('the screen gives the sheet the fixes of the line it is editing (readiness for the full panel only)', () => {
    const code = codeOnly(screen);
    expect(code).toContain('shortFix={editLineShortFix}');
    expect(code).toMatch(
      /return orderLineShortFix\(\{\s*status: order\.status,\s*line: editLine,[\s\S]*?readinessLine: showLineReadiness \? \(readinessByLine\?\.get\(lineId\)\?\.line \?\? null\) : null,\s*\}\);/,
    );
  });

  // Mutation caught: a fix button that does something else (a lower that
  // bypasses the floors, or a remove that skips its confirmation).
  it('Lower is the Save write with its floors checked; Remove asks first; the sheet’s own Remove steps aside', () => {
    const s = codeOnly(editSheet);
    expect(s).toContain("onPress={a.kind === 'lower' ? () => lowerTo(a.quantity) : confirmRemove}");
    expect(functionBody(editSheet, 'edit-order-line-sheet.tsx', 'lowerTo')).toBe(
      '{ if (!line || !line.orderRequestLineId || busy !== null) return; const check = validateLineQuantity(line, quantity); if (!check.ok) { setError(check.reason); return; } void commitSave(line, quantity); }',
    );
    expect(s).toContain('const showRemove = !(shortFix?.replacesRemove ?? false);');
    expect(s).toMatch(
      /\{showRemove \? \(\s*<View style=\{\{ gap: 6 \}\}>\s*<Pressable\s+onPress=\{confirmRemove\}/,
    );
  });

  it('each fix is a named button with the item, and its label is capped chrome', () => {
    const s = codeOnly(editSheet);
    expect(s).toContain('accessibilityLabel={`${a.label}, ${line.name}`}');
    expect(s).toContain('maxFontSizeMultiplier={ACTION_CAP}');
    expect(s).toContain('const ACTION_CAP = capTo(13, TYPE_CEILING.control);');
    expect(s).toContain('<Eyebrow color={ACCENT.warn}>{shortFix.label}</Eyebrow>');
  });
});
