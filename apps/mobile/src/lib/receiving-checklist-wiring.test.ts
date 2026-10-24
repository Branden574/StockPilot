import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { auditTouchSinks } from './__fixtures__/jsx-touch-audit';
import { rewriteWebPath } from './web-path-rewrite';

/**
 * THE RECEIVING CHECKLIST ON THE PHONE (F4-1): WIRING PINS.
 *
 * The screens cannot render under this node environment (vitest runs src/**
 * only; app/ imports native modules at load), so the load-bearing wiring is
 * pinned at source level. The logic is pure and tested beside it:
 * receive-gate.test.ts (who may post, the footer, the quantities),
 * receiving-checks-api.test.ts (the routes, read strictly; refusals in words)
 * and receiving-checks-view.test.ts (the chips and the Posted alert). Each
 * pin is a rule the plan or the owner set:
 *   1. the PO screen asks the gate only for a receivable PO (a draft asks
 *      nothing), posts only on a known yes, and keeps Scan, the fields and
 *      the size runs read only otherwise;
 *   2. the checklist status is read beside the PO and never holds or fails
 *      the screen; a failed read is said once, with Try again;
 *   3. the Posted alert offers Record checklist only through postedAlertPlan,
 *      and leaves through goBack() (nothing behind a linked screen);
 *   4. the run and editor screens talk only to the API, are online only,
 *      ask before leaving unsaved work, keep the save id for a resend, and
 *      carry a named 44pt Back;
 *   5. both screens are registered, reachable from a web link warm (the
 *      rewrite rows, above the PO-id row) and cold (the static shims), from
 *      the Receive tab for managers and from Procedures;
 *   6. every new control is a named role at 44pt, and no new file has emoji.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');

/** Source with comments stripped, so a note that names a rule cannot satisfy its pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

/** The body of a function declared in a file: from its signature to the next top-level `  async function` / `  function`. */
function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:async )?function |\n {2}return \(\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

const PO = 'app/po/[id].tsx';
const RUN = 'app/receiving-check/[id].tsx';
const EDITOR = 'app/receiving-checklist.tsx';

describe('the PO screen (1-3)', () => {
  const po = codeOnly(read(PO));

  // Mutation caught: the gate read on a draft (F2-5's review mode asks
  // nothing), or on every render offline. Re-pinned by the rebase onto the
  // small fixes slice 2 (was: !reviewOnly): nor for a reader without
  // stock:adjust, whose screen is read only before any gate answer.
  it('asks the gate only for a receivable PO on screen, online', () => {
    expect(po).toContain('const gateWanted = header !== null && !readOnly;');
    expect(po).toContain(
      'if (!gateWanted || !userId || !orgId || gateKey === null || offline) return;',
    );
    expect(po).toContain('fetchReceiveFacts(userId, orgId).then(');
    expect(po).toContain("import { useAuth } from '@/lib/auth-context';");
    expect(po).toMatch(
      /const gate = receiveGateOf\(gateView, enabledModules\.has\('receiving'\)\);/,
    );
  });

  // Mutation caught: the post path still reachable for someone who cannot post.
  it('posts only on a known yes, checked again inside postReceipt', () => {
    const body = fnBody(po, 'async function postReceipt() {');
    expect(body.indexOf('if (!canEditQuantities) return;')).toBeGreaterThan(-1);
    expect(body.indexOf('if (!canEditQuantities) return;')).toBeLessThan(
      body.indexOf('destination_warehouse_id'),
    );
  });

  // Mutation caught: one of the three quantity paths left editable (the
  // size runs' fields and All, the loose fields and All, Scan).
  it('keeps the size runs read only too', () => {
    expect(po).toContain('editable={canEditQuantities}');
    expect(po).toContain('{anyOutstanding && editable && (');
    expect(po).toMatch(/\) : !editable \? null : \(\s*<TextInput/);
  });

  it('reads the checklist status beside the PO, never holding or failing the screen', () => {
    const load = fnBody(po, 'const load = React.useCallback(async () => {');
    expect(load).toMatch(/void loadChecks\(\);/);
    expect(load).not.toMatch(/await loadChecks\(\)/);
    const loader = fnBody(po, 'const loadChecks = React.useCallback(async () => {');
    expect(loader).toContain("next = { kind: 'ready', checks: { ok: false } };");
    expect(loader).toContain('if (seq === checksSeqRef.current) setChecks(next);');
    // Back from a checklist, its chip is read again.
    expect(po).toMatch(
      /useFocusEffect\(\s*React\.useCallback\(\(\) => \{[\s\S]*?void loadChecks\(\);/,
    );
  });

  it('labels each card through core, and says a failed read once with Try again', () => {
    expect(po).toMatch(
      /const chip = receiptChip\(\{[\s\S]*?canRecord: gate\?\.canRecordChecklist === true,/,
    );
    expect(po).toContain('{historyChecksFailed(checks, receipts.length) ? (');
    // A receipt from a gap after the first checklist: Record without a chip
    // (core receiptChecklistAction, the web's rule; desk check F4).
    expect(po).toContain('{chip.text !== null ? (');
    expect(po).toContain("onPress={() => void retryPart('checks')}");
    expect(po).toContain('accessibilityLabel={`${chip.actionLabel}, ${r.receipt_number}`}');
  });

  // Mutation caught: Record offered on a guess, or the alert leaving through
  // router.back() (a PO opened from a link has nothing behind it).
  it('the Posted alert offers Record only through postedAlertPlan, and leaves through goBack', () => {
    expect(po).toMatch(/const plan = postedAlertPlan\(\{/);
    expect(po).toContain("{ text: C.done, style: 'cancel', onPress: goBack },");
    expect(po).toContain(
      '{ text: C.recordChecklist, onPress: () => void recordAfterPost(receiptId) },',
    );
    expect(po).toContain("Alert.alert(plan.title, plan.body, [{ text: 'OK', onPress: goBack }]);");
    expect(count(po, 'router.back()')).toBe(1);
    const record = fnBody(po, 'async function recordAfterPost(receiptId: string) {');
    expect(record).toContain('router.replace(receivingCheckPath(started.runId) as Href);');
    expect(record).toContain('startAfterPostFailureBody(e)');
  });

  it('the footer comes from receiveFooter, with Retry only when it could not check online', () => {
    expect(po).toMatch(/footer\.kind === 'unknown' && footer\.retry \? \(/);
    expect(po).toMatch(/setGateAnswer\(null\);\s*setGateNonce\(\(n\) => n \+ 1\);/);
  });

  // Re-pinned by the rebase onto the redesign (was: retryTap): the
  // redesigned screen's Retry beside the footer's words is its partRetry.
  it('the new controls are 44 pt', () => {
    for (const style of ['partRetry', 'checkAction', 'gateRow']) {
      expect(po).toMatch(new RegExp(`${style}: \\{[^}]*minHeight: 44,`));
    }
  });
});

describe('the run and editor screens (4)', () => {
  const run = codeOnly(read(RUN));
  const editor = codeOnly(read(EDITOR));

  it('talk only to the API', () => {
    for (const src of [run, editor]) {
      expect(src).not.toContain("from '@/lib/supabase'");
      expect(src).not.toMatch(/\.rpc\(/);
    }
    expect(run).toContain('getReceivingRun(id)');
    expect(run).toContain('saveReceivingRun(view.run.id, {');
    expect(editor).toContain('getChecklistEditor()');
    expect(editor).toContain('publishChecklist({');
    expect(editor).toContain('retireChecklist(versionId)');
  });

  // Mutation caught: no leave guard, or one on the header back only (the root
  // stack shows no header; the chip, the swipe and a replace all remove the screen).
  it('ask before leaving unsaved work, through usePreventRemove', () => {
    for (const src of [run, editor]) {
      expect(src).toContain("import { usePreventRemove } from 'expo-router/react-navigation';");
      expect(src).toContain('navigation.dispatch(data.action)');
    }
    expect(run).toContain('usePreventRemove(dirty && !readOnly, ({ data }) => {');
    expect(editor).toContain('usePreventRemove(editing, ({ data }) => {');
  });

  it('carry a named 44 pt Back that goes home when nothing is behind', () => {
    for (const src of [run, editor]) {
      expect(
        count(
          src,
          '<IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />',
        ),
      ).toBe(1);
      expect(src).toMatch(
        /if \(router\.canGoBack\(\)\) router\.back\(\);\s*else router\.replace\('\/' as Href\);/,
      );
    }
  });

  // Mutation caught: a fresh save or publish id on every send (a lost reply,
  // then a resend, would be refused as changed, or publish twice).
  it('keep the save and publish ids for a resend, clearing them only after it landed', () => {
    expect(run).toContain('pending.current = { payload, saveId: randomRequestUuid() };');
    expect(count(run, 'pending.current = null;')).toBe(1);
    expect(run.indexOf('pending.current = null;')).toBeLessThan(run.indexOf('onSaved(res);'));
    expect(editor).toContain(
      'pending.current = { payload, clientPublishId: randomRequestUuid() };',
    );
    expect(count(editor, 'pending.current = null;')).toBe(1);
  });

  it('are online only: Save, Complete, Publish and Turn off are disabled offline, with the reason', () => {
    expect(count(run, 'disabled={busy !== null || offline}')).toBe(2);
    expect(run).toMatch(
      /\{offline \? \(\s*<Body muted size=\{13\.5\} accessibilityRole="alert">\s*\{C\.offline\}/,
    );
    expect(editor).toContain('disabled={busy || offline}');
    expect(editor).toContain('{C.editorOffline}');
  });

  it('the run: radios with words and state, a number pad, keyboard avoidance, a confirmation to complete', () => {
    expect(run).toContain('accessibilityRole="radiogroup"');
    expect(run).toContain('accessibilityRole="radio"');
    expect(run).toContain('accessibilityState={{ checked, disabled: locked }}');
    expect(run).toContain('keyboardType="number-pad"');
    expect(run).toContain('<KeyboardAvoidingView');
    expect(run).toContain('Alert.alert(C.completeChecklist, C.completeConfirm, [');
    // The About and status lines come from core, the web's words.
    expect(run).toContain('receivingRunAboutLines(view.about, anyFail)');
    expect(run).toContain('receivingRunStatusLines(');
  });

  // Desk check F5 (mutation caught: the Editor keyed on every read, so Reload
  // after a conflict threw away the staged edits the message says are kept).
  it('the editor keeps its staged edits across Reload, and publishes against the version they began on', () => {
    expect(editor).toContain('key={state.generation}');
    expect(editor).toContain('setState((prev) => editorScreenLoaded(prev, editor, saved));');
    expect(editor).toContain('onSaved={() => void reload(true)}');
    expect(editor).toContain('onReload={() => reload(false)}');
    expect(editor).toContain('expectedCurrentId: baseId,');
    const begin = fnBody(editor, "  function begin(from: 'suggested' | 'blank' | 'live') {");
    expect(begin).toContain('setBaseId(live?.id ?? null);');
    const again = fnBody(editor, '  async function reloadAfterConflict() {');
    expect(again).toContain('const fresh = await onReload();');
    expect(again).toContain('setBaseId(fresh.live?.id ?? null);');
    expect(editor).toContain('onPress={() => void reloadAfterConflict()}');
  });

  it('the editor: read only without the publisher gate, confirmations to publish and to turn off', () => {
    expect(editor).toContain('const canPublish = editor.gate.canPublishChecklist;');
    expect(editor).toContain('{C.readOnlyEditor}');
    expect(editor).toContain('Alert.alert(C.publishVersion(next), C.publishConfirm(next), [');
    expect(editor).toMatch(
      /Alert\.alert\(C\.turnOff, C\.turnOffConfirm, \[[\s\S]*?style: 'destructive'/,
    );
    expect(editor).toContain('accessibilityRole="checkbox"');
    expect(editor).toContain('{C.proceduresUnavailable}');
  });

  it('every touchable has a real press handler and wraps no text field', () => {
    expect(auditTouchSinks(read(RUN), RUN)).toEqual([]);
    expect(auditTouchSinks(read(EDITOR), EDITOR)).toEqual([]);
  });

  it('new controls are 44 pt', () => {
    for (const src of [run, editor]) expect(src).toContain('const MIN_TAP = 44;');
    expect(run).toMatch(/segmentOption: \{\s*minHeight: MIN_TAP,/);
    expect(editor).toMatch(/option: \{\s*minHeight: MIN_TAP,/);
    expect(editor).toMatch(/checkboxRow: \{\s*minHeight: MIN_TAP,/);
  });
});

describe('reaching the screens (5)', () => {
  const RUN_ID = '0f400000-0000-4000-8000-000000000008';
  const PO_ID = '0f400000-0000-4000-8000-000000000002';

  it('both screens are registered on the root stack', () => {
    const layout = read('app/_layout.tsx');
    expect(layout).toContain(
      '<Stack.Screen name="receiving-check/[id]" options={{ presentation: \'card\' }} />',
    );
    expect(layout).toContain(
      '<Stack.Screen name="receiving-checklist" options={{ presentation: \'card\' }} />',
    );
  });

  // Mutation caught: the rows below the PO-id row or the catch-all (a link
  // opened home or "Could not load this PO").
  it('a warm web link opens the native screen', () => {
    expect(rewriteWebPath(`/dashboard/purchase-orders/receiving-checks/${RUN_ID}`)).toBe(
      `/receiving-check/${RUN_ID}`,
    );
    expect(rewriteWebPath('/dashboard/purchase-orders/receiving-checklist')).toBe(
      '/receiving-checklist',
    );
    expect(rewriteWebPath('/dashboard/purchase-orders/receiving-checklist?x=1')).toBe(
      '/receiving-checklist',
    );
    expect(
      rewriteWebPath(`stockpilot:///dashboard/purchase-orders/receiving-checks/${RUN_ID}`),
    ).toBe(`/receiving-check/${RUN_ID}`);
    // A PO is still a PO; a malformed run id is not a run.
    expect(rewriteWebPath(`/dashboard/purchase-orders/${PO_ID}`)).toBe(`/po/${PO_ID}`);
    expect(rewriteWebPath('/dashboard/purchase-orders/receiving-checks/not-an-id')).toBe('/');
    const src = read('src/lib/web-path-rewrite.ts');
    const poRow = src.indexOf('{ re: new RegExp(`/dashboard/purchase-orders/${UUID}`)');
    expect(src.indexOf('/dashboard/purchase-orders/receiving-checks/${UUID}')).toBeLessThan(poRow);
    expect(src.indexOf('purchase-orders\\/receiving-checklist(')).toBeLessThan(poRow);
  });

  it('a cold start reaches the static shims, which redirect to the screens', () => {
    const list = 'app/dashboard/purchase-orders/receiving-checklist.tsx';
    const one = 'app/dashboard/purchase-orders/receiving-checks/[id].tsx';
    expect(existsSync(path.join(MOBILE_ROOT, list))).toBe(true);
    expect(existsSync(path.join(MOBILE_ROOT, one))).toBe(true);
    expect(read(list)).toContain("<Redirect href={'/receiving-checklist' as Href} />");
    expect(read(one)).toContain(
      "<Redirect href={(isUuid(id) ? `/receiving-check/${id}` : '/') as Href} />",
    );
  });

  it('managers reach the editor from the Receive tab, anyone who reads POs from Procedures', () => {
    const receive = codeOnly(read('app/(drawer)/(tabs)/receive.tsx'));
    expect(receive).toContain(
      'const showChecklistLink = receivingOn && role !== null && isManagerOrAbove(role);',
    );
    expect(receive).toMatch(
      /<IconChip\s+icon=\{ListChecks\}\s+onPress=\{\(\) => router\.push\('\/receiving-checklist' as Href\)\}\s+accessibilityLabel=\{RECEIVING_CHECKLIST_COPY\.editorTitle\}\s+minTap\s+\/>/,
    );
    const procedures = codeOnly(read('src/screens/procedures.tsx'));
    expect(procedures).toContain(
      "if (!receivingOn || !perms?.has('purchase_orders:read')) return null;",
    );
    expect(procedures).toContain('header={<ReceivingChecklistRow />}');
    expect(procedures).toContain("router.push('/receiving-checklist' as Href)");
  });
});

describe('no emoji in what F4-1 adds (6)', () => {
  it.each([
    RUN,
    EDITOR,
    'app/dashboard/purchase-orders/receiving-checklist.tsx',
    'app/dashboard/purchase-orders/receiving-checks/[id].tsx',
    'src/lib/receive-gate.ts',
    'src/lib/receiving-checks-api.ts',
    'src/lib/receiving-checks-view.ts',
  ])('%s', (file) => {
    expect(read(file)).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
