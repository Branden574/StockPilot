import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the phone's rental detail (app/rentals/[id].tsx) and the
 * rentals list's reminder marks (src/screens/rentals.tsx), 2026-09-25.
 *
 * The screens live under app/ (excluded from the mobile vitest config: native
 * imports at module scope) or import native modules, so these read the source
 * and assert the property. The decisions themselves are tested where they
 * live: lib/rental-view.test.ts and @stockpilot/core rentals/emails.test.ts.
 */

const DETAIL = readFileSync(path.resolve(__dirname, '../../app/rentals/[id].tsx'), 'utf8');
const LIST = readFileSync(path.resolve(__dirname, '../screens/rentals.tsx'), 'utf8');
const LAYOUT = readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf8');

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('app/rentals/[id].tsx', () => {
  it('is a registered card screen next to rentals/new', () => {
    expect(LAYOUT).toContain('<Stack.Screen name="rentals/[id]" options={{ presentation: \'card\' }} />');
  });

  it('reads through the shared loader, scoped to the org, and re-reads on refresh', () => {
    const src = code(DETAIL);
    expect(src).toContain('const result = await loadRentalDetail(supabase, orgId, id);');
    expect(src).toContain('}, [orgId, id]);');
    expect(src).toMatch(
      /refreshControl=\{<RefreshControl refreshing=\{refreshing\} onRefresh=\{\(\) => void reload\(\)\} \/>\}/,
    );
  });

  // Simulator walk 2026-09-25: after an offline failure, Try again turned
  // disabled and stayed disabled once the connection was back. reload() set
  // `refreshing` and left clearing it to the load effect, which returns early
  // while the workspace is unset. Mutation caught: that old reload().
  it('a refresh or Try again ends when its own read ends, never waiting on the effect', () => {
    const src = code(DETAIL);
    expect(src).toMatch(
      /async function reload\(\) \{\s*setRefreshing\(true\);\s*try \{\s*await loadRental\(\);\s*\} finally \{\s*setRefreshing\(false\);\s*\}\s*\}/,
    );
    expect(src).not.toMatch(/setNonce|nonce/);
    // The only other setRefreshing is the one in reload().
    expect(src.match(/setRefreshing\(/g)).toHaveLength(2);
    // Try again is disabled only while that read runs.
    expect(src).toContain('onRetry={load.notFound ? undefined : () => void reload()} retrying={refreshing}');
  });

  it('says the emails with core (the sweep rule), never local copy', () => {
    const src = code(DETAIL);
    expect(src).toMatch(/rentalEmailLines\(rental, context\.remindersOn, nowMs, context\.timeZone\)/);
    expect(src).toContain('{RENTAL_EMAILS_RECORD_NOTE}');
    expect(src).toContain('const borrower = rentalBorrowerView(rental);');
    expect(src).toContain('{borrower.kind}');
    expect(src).toContain('{borrower.note}');
    // The clock is taken with the data, not during render.
    expect(src).toMatch(/if \(seq !== seqRef\.current\) return;\s*setNowMs\(Date\.now\(\)\);/);
  });

  it('a failed read is not "not found", and can be retried', () => {
    const src = code(DETAIL);
    expect(src).toContain('onRetry={load.notFound ? undefined : () => void reload()}');
    expect(src).toContain('`Could not load this rental. ${load.message}`');
  });

  // Review 2026-09-26: offline at launch (or a failed first read after
  // signing in) there is no workspace, loadRental returns early, and the
  // screen showed a spinner with nothing to tap. Mutation caught: the old
  // screen, which went straight to the spinner.
  it('with no workspace, says so with a Try again that loads the workspace again', () => {
    const src = code(DETAIL);
    expect(src).toContain('const { orgId, loading: workspaceLoading } = useOrg();');
    expect(src).toContain("import { retryWorkspace } from '@/lib/use-workspace';");
    expect(src).toMatch(
      /async function reloadWorkspace\(\) \{\s*setRetryingWorkspace\(true\);\s*try \{\s*await retryWorkspace\(\);\s*\} finally \{\s*setRetryingWorkspace\(false\);\s*\}\s*\}/,
    );
    const gate = src.indexOf('if (!orgId && !workspaceLoading) {');
    expect(gate).toBeGreaterThan(-1);
    // Decided before the spinner that waits for a load.
    expect(gate).toBeLessThan(src.indexOf('if (load === null) {'));
    const branch = src.slice(gate, src.indexOf('if (load === null) {'));
    expect(branch).toContain('onRetry={() => void reloadWorkspace()} retrying={retryingWorkspace}');
    expect(branch).toContain('{RENTAL_WORKSPACE_UNAVAILABLE}');
  });

  it('is gated on the Rentals module like the other detail screens', () => {
    expect(code(DETAIL)).toMatch(/const enabled = enabledModules\.has\('rentals'\);/);
  });

  it('writes nothing: returns and cancels stay on the web', () => {
    const src = code(DETAIL);
    expect(src).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    expect(src).not.toMatch(/method:\s*'(POST|PATCH|DELETE)'/);
  });

  it('never describes a reminder before the return date', () => {
    expect(DETAIL).not.toMatch(/due soon|before (it is|the rental is) due|upcoming reminder|day before/i);
  });

  // Mutation caught: the button on `rental.status === 'out'` alone (the old
  // screen), which offered a rentals:read viewer "Mark returned or cancel on
  // the web" and sent them to a web page with neither.
  it('offers the web actions only to a viewer the web page gives them to, worded for what they can do', () => {
    const src = code(DETAIL);
    expect(src).toContain('const perms = useEffectivePermissions();');
    expect(src).toContain('const webAction = rentalWebActionLabel(rental.status, perms);');
    expect(src).toMatch(/\{webAction \? \(/);
    expect(src).toContain('{webAction}');
    expect(src).not.toMatch(/\{rental\.status === 'out' \? \(/);
    expect(src).not.toContain('Mark returned or cancel on the web');
    // The hook runs before any early return (rules of hooks).
    expect(src.indexOf('const perms = useEffectivePermissions();')).toBeLessThan(src.indexOf('if (!enabled) {'));
  });
});

describe('src/screens/rentals.tsx: the list', () => {
  // Simulator walk 2026-09-25: after a checkout, router.back() showed the list
  // from before it ("0 OUT", "No rentals yet.") until a pull to refresh. The
  // list loaded on mount only. Mutation caught: React.useEffect(() => void
  // load(), [load]), the old mount-only load.
  it('reloads on focus (back from New rental or a rental), like the PO imports list', () => {
    const src = code(LIST);
    expect(src).toContain("import { useFocusEffect, useRouter } from 'expo-router';");
    expect(src).toMatch(
      /useFocusEffect\(\s*React\.useCallback\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\),\s*\);/,
    );
    expect(src).not.toMatch(/React\.useEffect\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\);/);
  });

  // Review 2026-09-26: load() set its rows with no check of which read they
  // came from. After a switch of organization, the old organization's slower
  // read could land last and show its checkouts under the new one; and every
  // focus adds another read. Mutation caught: the old load(), with neither a
  // sequence check nor rows tagged with their organization.
  it('only the latest read lands, and rows show only for the organization they were read for', () => {
    const src = code(LIST);
    expect(src).toContain('const loadSeqRef = React.useRef(0);');
    expect(src).toMatch(/if \(!orgId\) return;\s*const seq = \+\+loadSeqRef\.current;/);
    const load = src.slice(src.indexOf('const load = React.useCallback('), src.indexOf('const loadItems = React.useCallback('));
    const landed = load.indexOf('if (seq !== loadSeqRef.current) return;');
    expect(landed).toBeGreaterThan(load.indexOf('await Promise.all('));
    // Every state write in the load comes after that check.
    expect(landed).toBeLessThan(load.indexOf('setCheckouts('));
    expect(load).not.toMatch(/setRows\(|setReminderContext\(|setCheckoutsFailed\(/);
    expect(src).toContain('const shown = checkouts && checkouts.orgId === orgId ? checkouts : null;');
    expect(src).toContain('const rows = shown?.rows ?? [];');
    expect(src).toContain('loading={shown === null && !noWorkspace}');
  });

  // Review 2026-09-26: offline, going back from a rental replaced the list
  // being read with "Could not load rentals." and no rows. Mutation caught:
  // setRows(data ?? []) on an error.
  it('a failed reload keeps the rows already shown, with a banner that says so', () => {
    const src = code(LIST);
    expect(src).toMatch(
      /setCheckouts\(\(prev\) => settleRentalCheckouts\(prev, orgId, \{ ok: false, reason, context, readAt \}\)\);/,
    );
    expect(src).toMatch(
      /setCheckouts\(\(prev\) => settleRentalCheckouts\(prev, orgId, \{ ok: true, rows, context, readAt \}\)\);/,
    );
    expect(src).toContain('const reason = rentalReadErrorMessage(error, status);');
    expect(src).toContain('{rentalListStaleCopy(shown.staleReason)}');
    expect(src).toMatch(/shown\?\.staleReason \? \(/);
  });

  it('with no workspace, both views say so and a pull loads the workspace again', () => {
    const src = code(LIST);
    expect(src).toContain('const noWorkspace = !orgId && !workspaceLoading;');
    expect(src).toMatch(/await \(noWorkspace \? retryWorkspace\(\) : view === 'items' \? loadItems\(\) : load\(\)\);/);
    expect(src).toContain('loading={current === null && !noWorkspace}');
    expect(src.match(/noWorkspace\s*\?\s*RENTAL_LIST_NO_WORKSPACE_TITLE/g)).toHaveLength(2);
  });

  it('a card opens the rental on the phone, not the web', () => {
    const src = code(LIST);
    expect(src).toContain('onPress={() => router.push(`/rentals/${r.id}`)}');
    expect(src).not.toMatch(/Linking\.openURL/);
  });

  it('selects the reminder columns and reads the reminder context with the rows', () => {
    const src = code(LIST);
    expect(src).toContain('${RENTAL_LIST_REMINDER_COLUMNS}');
    expect(src).toContain('loadRentalReminderContext(supabase, orgId),');
    expect(src).toContain('overdue_reminder_sent_at: (r.overdue_reminder_sent_at as string | null) ?? null,');
    expect(src).toContain('borrower_user_id: (r.borrower_user_id as string | null) ?? null,');
  });

  // Mutation caught: toLocaleDateString(undefined, ...) (the old card), the
  // device's zone, beside a mark and a detail screen in the organization's.
  it("prints the card's dates in the organization's zone, like its mark and the detail", () => {
    const src = code(LIST);
    expect(src).toContain('timeZone={reminderContext.timeZone}');
    expect(src).toContain('out {rentalDayLabel(rental.checked_out_at, timeZone)}');
    expect(src).toContain('{rentalDayLabel(rental.expected_return_at, timeZone)}');
    expect(src).not.toMatch(/toLocaleDateString\(/);
  });

  it('marks overdue rows with the shared rule and the snapshot clock', () => {
    const src = code(LIST);
    expect(src).toContain('reminderMark={rentalListReminderMark(r, reminderContext, now)}');
    expect(src).toContain('{reminderMark}');
    expect(src).toContain('const status = rentalStatusPill(rental, now);');
  });
});
