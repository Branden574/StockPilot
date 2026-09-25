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
    expect(src).toContain('}, [orgId, id, nonce]);');
    expect(src).toMatch(/refreshControl=\{<RefreshControl refreshing=\{refreshing\} onRefresh=\{reload\} \/>\}/);
  });

  it('says the emails with core (the sweep rule), never local copy', () => {
    const src = code(DETAIL);
    expect(src).toMatch(/rentalEmailLines\(rental, context\.remindersOn, nowMs, context\.timeZone\)/);
    expect(src).toContain('{RENTAL_EMAILS_RECORD_NOTE}');
    expect(src).toContain('const borrower = rentalBorrowerView(rental);');
    expect(src).toContain('{borrower.kind}');
    expect(src).toContain('{borrower.note}');
    // The clock is taken with the data, not during render.
    expect(src).toMatch(/if \(cancelled\) return;\s*setNowMs\(Date\.now\(\)\);/);
  });

  it('a failed read is not "not found", and can be retried', () => {
    const src = code(DETAIL);
    expect(src).toContain('onRetry={load.notFound ? undefined : reload}');
    expect(src).toContain('`Could not load this rental. ${load.message}`');
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
});

describe('src/screens/rentals.tsx: the list', () => {
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

  it('marks overdue rows with the shared rule and the snapshot clock', () => {
    const src = code(LIST);
    expect(src).toContain('reminderMark={rentalListReminderMark(r, reminderContext, now)}');
    expect(src).toContain('{reminderMark}');
    expect(src).toContain('const status = rentalStatusPill(rental, now);');
  });
});
