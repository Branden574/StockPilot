import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Recurring POs screen — WIRING PINS for app/(drawer)/recurring-pos.tsx.
 *
 * SP-122. Pause/resume and delete used to be direct PostgREST writes from the
 * phone. RLS allowed them (manager+ / purchase_orders:manage, the same floor
 * the web service asserts) and the daily cron re-checks the plan tier, so the
 * hole was never authorization — it was the AUDIT TRAIL. `audit_logs` is
 * written by app code only (apps/web/src/server/services/audit.ts, through the
 * service-role client); there is no DB trigger, and the table's only policy is
 * SELECT. So a template paused or deleted from a phone produced no audit row
 * at all, while the identical action on web produced one — and the org reads
 * that same log ON THE PHONE (app/(drawer)/admin/audit.tsx). "Why did the
 * monthly PO stop?" had an answer on web and a blank on mobile.
 *
 * The writes therefore go through PATCH/DELETE /api/v1/recurring-pos/[id],
 * which calls RecurringPoTemplatesService.setEnabled/remove — the one place
 * that audits (and stamps `updated_by`, which the direct write never did).
 *
 * These are source-level pins because the screen imports expo/native modules
 * at load and cannot be required in this node vitest environment (the vitest
 * config includes src/ only, by design — see staging-screen-wiring.test.ts).
 */

const screen = readFileSync(
  path.resolve(__dirname, '../../app/(drawer)/recurring-pos.tsx'),
  'utf8',
);

/** Comments explain the rules; only the CODE can satisfy them. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** Collapse formatting so a prettier line-break cannot fail a wiring pin. */
const flat = (src: string) => code(src).replace(/\s+/g, ' ');

const body = code(screen);
const oneLine = flat(screen);

describe('the audited path is the only write path', () => {
  it('toggles through the API route, not PostgREST', () => {
    expect(body).toContain("import { api } from '@/lib/api'");
    expect(oneLine).toContain("api(`/api/v1/recurring-pos/${row.id}`, { method: 'PATCH'");
    expect(oneLine).toContain('body: { enabled: next }');
  });

  it('deletes through the API route, not PostgREST', () => {
    expect(oneLine).toContain("api(`/api/v1/recurring-pos/${row.id}`, { method: 'DELETE' })");
  });

  it('no longer writes recurring_po_templates directly from the device', () => {
    // The READ stays on Supabase (member-level RLS, no audit event to write);
    // only the WRITES move. So pin the write verbs, not the table name.
    expect(oneLine).not.toContain('.update({ enabled');
    expect(oneLine).not.toMatch(/from\('recurring_po_templates'\)[^;]*\.delete\(\)/);
  });

  it('still fails CLOSED — a refused write never updates the list', () => {
    // Bug pattern #22's sibling: an optimistic list update next to a write
    // that was refused hides the failure completely. Every state change here
    // must sit AFTER the awaited call, inside the success path.
    const toggle = body.slice(body.indexOf('async function toggleEnabled'), body.indexOf('function confirmDelete'));
    expect(toggle).toContain('await api');
    expect(toggle).toContain('catch');
    expect(toggle).toContain("Alert.alert(\n        'Could not update',");
    expect(toggle.indexOf('await api')).toBeLessThan(toggle.indexOf('setRows('));

    const del = body.slice(body.indexOf('function confirmDelete'));
    expect(del).toContain('await api');
    expect(del).toContain("'Could not delete'");
    expect(del.indexOf('await api')).toBeLessThan(del.indexOf('setRows('));
  });
});
