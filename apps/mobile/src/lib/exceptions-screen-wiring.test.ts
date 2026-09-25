import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveSurface } from '@stockpilot/core';

/**
 * Exceptions screens (F1-1): WIRING PINS for app/(drawer)/exceptions.tsx,
 * app/exceptions/[id].tsx and the Acknowledge / Note sheet.
 *
 * The screens cannot render under this node test environment (vitest excludes
 * app/, which imports native modules at load), so the load-bearing wiring is
 * pinned at source level. The logic itself is pure and tested in
 * exceptions-api.test.ts and core's exceptions.test.ts. Each pin encodes a
 * rule the owner set:
 *   1. the rows come from the shared service through /api/v1/exceptions,
 *      never a second Supabase query (one set of rules for web and phone);
 *   2. a failed or offline load is an error or an "as of" list, never an
 *      empty list;
 *   3. offline, Acknowledge and Add note are DISABLED with the reason, fed by
 *      the live network state;
 *   4. the actions are offered only to a reader the server said may act;
 *   5. the drawer entry, its icon and the routes are registered.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

const listScreen = read('../../app/(drawer)/exceptions.tsx');
const detailScreen = read('../../app/exceptions/[id].tsx');
const sheet = read('../components/exception-note-sheet.tsx');
const drawerLayout = read('../../app/(drawer)/_layout.tsx');
const rootLayout = read('../../app/_layout.tsx');
const navIcons = read('./nav-icons.ts');

/** Source with comments stripped, so a header explaining what a screen avoids
 *  cannot trip the negative pins. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('exceptions list screen', () => {
  const code = codeOnly(listScreen);

  it('reads the stored list from the shared endpoint, never Supabase', () => {
    expect(code).toContain('listExceptions(status)');
    expect(code).not.toContain("from('exception_occurrences')");
    expect(code).not.toContain('supabase');
    expect(code).not.toContain('.rpc(');
  });

  it('a failed load is an error (or the list this session loaded, with its time), never an empty list', () => {
    expect(code).toContain("{ kind: 'error', key, message: `${EXCEPTION_LIST_UNAVAILABLE_COPY} ${message}` }");
    expect(code).not.toMatch(/catch \([^)]*\) \{[^}]*occurrences: \[\]/);
    expect(code).toContain('Try again');
  });

  it('offline shows the remembered list "as of" its time, or says it needs a connection', () => {
    expect(code).toContain('recalledList(userId, orgId, status)');
    expect(code).toContain('offlineAsOfCopy(kept.receivedAt, kept.list.timeZone)');
    expect(code).toContain('EXCEPTIONS_OFFLINE_NOTHING_LOADED_COPY');
    // The live network state, so going offline or reconnecting reloads.
    expect(code).toContain('isOfflineState(useNetworkState())');
    expect(code).toMatch(/\}, \[orgId, userId, status, offline\]\);/);
  });

  it('before the first check it shows the pending copy and never the all-clear', () => {
    expect(code).toContain('EXCEPTION_FIRST_CHECK_PENDING_COPY');
    expect(code).toContain('data={list!.syncState === null ? [] : items}');
  });

  it('never shows the all-clear while a check is unknown or an open row cannot be shown', () => {
    // Rows of a newer rule (as count_variance was before F1-2's OTA) are
    // counted by parseExceptionList; the empty state must not call them all
    // clear. Mutation caught: gating the all-clear on syncState and the
    // unchecked rules only.
    expect(code).toContain(
      'list!.syncState === null || unchecked !== null || unrecognized !== null ? null',
    );
    expect(code).toContain("list && list.status === 'open' ? exceptionUnrecognizedCopy(list.unrecognized) : null");
    expect(code).toContain('list.syncState.unrecognizedUncheckedRules');
    expect(code).toContain('EXCEPTION_ALL_CLEAR_BODY');
    expect(code).not.toContain('No archived locations holding stock');
  });

  it('prints times in the org time zone, like the web page', () => {
    expect(code).toContain('const timeZone = list?.timeZone ?? null;');
    expect(code).not.toMatch(/exceptionTimeLabel\([^,()]+\)/);
  });

  it('never shows a bare error code: a 429 or 5xx is worded by status', () => {
    expect(code).toContain("describeExceptionsRequestError(e, 'Pull down to try again.')");
    expect(code).toContain("describeExceptionsRequestError(e, 'Could not start a check. Try again.')");
    expect(code).toContain('setCheckNote(exceptionCheckNowCopy(res))');
    expect(code).not.toMatch(/e instanceof Error && e\.message \? e\.message/);
  });

  it('shows "Checked at" and never runs a check on view; Check now is offered only when the server allows it', () => {
    expect(code).toContain('Checked at ${exceptionTimeLabel(list!.syncState.lastSyncedAt, timeZone)}');
    expect(code).toContain('{list?.canCheckNow ? (');
    expect(code).toContain('disabled={checking || offline}');
  });

  it('words every row through core, so the phone and the browser agree', () => {
    expect(code).toContain('groupOccurrences(list.occurrences)');
    expect(code).toContain('occurrenceStateLabel(state)');
    expect(code).toContain('recurrenceBadge(o.recurrenceIndex)');
    expect(code).toContain("'Already present when tracking began'");
  });

  it('re-reads on focus, so returning from an acknowledged exception shows its new state', () => {
    expect(code).toMatch(/useFocusEffect\(\s+React\.useCallback\(\(\) => \{\s+void load\(\);\s+\}, \[load\]\),\s+\);/);
  });

  it('drops a stale response', () => {
    expect(code).toContain('const seq = ++seqRef.current;');
    expect(code).toContain('if (seq !== seqRef.current) return;');
  });
});

describe('exception detail screen', () => {
  const code = codeOnly(detailScreen);

  it('reads the detail from the shared endpoint, never Supabase', () => {
    expect(code).toContain('getException(id)');
    expect(code).not.toContain('supabase');
    expect(code).not.toContain('.rpc(');
  });

  it('offers Acknowledge and Add note only when the server says this reader may act', () => {
    expect(code).toContain('const showActButtons = !resolved && o.canAct;');
    expect(code).toContain('{showActButtons ? (');
  });

  // Mutation caught: `online: true` (or dropping the argument) leaves the
  // buttons live in airplane mode.
  it('offline, the buttons stay but are disabled with the reason, from the live network state', () => {
    expect(code).toContain('isOfflineState(useNetworkState())');
    expect(code).toContain('exceptionActDisabledReason({ resolved, canAct: o.canAct, online: !offline })');
    expect(code).toContain('disabled={disabledReason !== null}');
    expect(code).toContain('{disabledReason}');
    expect(code).toContain('online={!offline}');
  });

  it('prints every time in the org time zone and words a failed read by status', () => {
    expect(code).not.toMatch(/exceptionTimeLabel\([^,()]+\)/);
    expect(code).toContain('exceptionTimeLabel(detail.syncState.lastSyncedAt, detail.timeZone)');
    expect(code).toContain("describeExceptionsRequestError(e, 'Could not load this exception.')");
  });

  it('a failed read is an error on screen; a 404 says the exception is not available', () => {
    expect(code).toContain("'This exception is not available to you, or it no longer exists.'");
    expect(code).toContain("{ kind: 'error', message }");
  });
});

describe('acknowledge and note sheet', () => {
  const code = codeOnly(sheet);

  it('gates submit on the shared rule, fed the live online state', () => {
    // The LIVE prop goes into the rule, next to the server's canAct hint.
    // Mutation caught: `online: true` here leaves the sheet live offline.
    expect(code).toMatch(/exceptionSheetSubmit\(\{\s+mode,\s+note,\s+submitting,\s+online,\s+canAct: occurrence\.canAct,/);
    expect(code).not.toMatch(/online:\s*true/);
    expect(code).toContain('disabled={!submitState.enabled}');
    expect(code).toContain('{submitState.reason}');
  });

  it('ties the client event id to the payload, through the Bearer route', () => {
    // Reused only for a resend of the same action and note; an edited note is
    // a new request (the rule itself is tested in exceptions-api.test.ts).
    // Mutation caught: one id per opening, which dropped an edited note as a
    // replay of a lost first request.
    expect(code).toContain('clientEventIdFor(lastAttempt.current, mode, payloadNote)');
    expect(code).toContain('lastAttempt.current = { action: mode, note: payloadNote, id: clientEventId }');
    expect(code).not.toContain('newClientEventId()');
    expect(code).toContain("if (reason === 'client_event_id_conflict') lastAttempt.current = null;");
    expect(code).toContain('actOnException(occurrence.id, {');
    expect(code).toContain('clientEventId,');
    expect(code).not.toContain('.rpc(');
  });

  it('shows a failure inline, not only as a toast', () => {
    expect(code).toContain('setError(describeActError(e))');
    expect(code).toContain('accessibilityRole="alert"');
  });
});

describe('exceptions is registered in the app navigation', () => {
  it('has a drawer screen and a stack screen, so both routes are real destinations', () => {
    expect(drawerLayout).toContain('<Drawer.Screen name="exceptions"');
    expect(rootLayout).toContain('<Stack.Screen name="exceptions/[id]"');
  });

  it('appears in the drawer for a role that can read items, right after Staging', () => {
    const hrefs = resolveSurface('mobile_drawer', {
      role: 'staff',
      enabledModules: new Set(['inventory']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/exceptions');
    expect(hrefs.indexOf('/exceptions')).toBe(hrefs.indexOf('/staging') + 1);
  });

  it('is visible to a viewer (read only) and hidden without items:read', () => {
    const viewer = resolveSurface('mobile_drawer', {
      role: 'viewer',
      enabledModules: new Set(['inventory']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(viewer).toContain('/exceptions');
    const none = resolveSurface('mobile_drawer', {
      role: 'viewer',
      enabledModules: new Set(['inventory']),
      permissions: new Set(),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(none).not.toContain('/exceptions');
  });

  it('resolves a real icon rather than falling back to the generic box', () => {
    const item = resolveSurface('mobile_drawer', {
      role: 'staff',
      enabledModules: new Set(['inventory']),
    })
      .flatMap((s) => s.items)
      .find((i) => i.href === '/exceptions');
    expect(item?.label).toBe('Exceptions');
    expect(item?.iconName).toBe('AlertTriangle');
    expect(navIcons).toMatch(/^\s+AlertTriangle,$/m);
  });
});
