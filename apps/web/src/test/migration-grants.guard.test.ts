/**
 * MIGRATION GUARD (D1): a migration from 0402 on that creates a table, view or
 * sequence in schema public decides, in the same file, what anon,
 * authenticated and service_role may do with it.
 *
 * WHY. Supabase's default privileges have given those three roles ALL on every
 * public table, view and sequence the migration role creates (production's
 * schema on 2026-10-24: ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA
 * public GRANT ALL ON TABLES, and ON SEQUENCES, TO anon, authenticated,
 * service_role). On 2026-10-30 Supabase stops that on every existing project
 * (changelog: github.com/orgs/supabase/discussions/45329). Objects that exist
 * keep their grants; a new one gets none, and the Data API refuses it before
 * RLS is ever asked. The local stack and CI keep auto-granting (CLI 2.117.0
 * with [api] auto_expose_new_tables unset, which it describes as covering
 * "newly-created tables, views, sequences and functions in the public
 * schema"), so a migration that leans on the old default passes every test
 * and fails in production.
 *
 * THE RULE. For each public table, partitioned table, partition, view,
 * materialized view, foreign table or sequence a checked file creates, and for
 * each of anon, authenticated and service_role, a GRANT or a REVOKE after the
 * CREATE, in the same file, names the object for that role:
 *   - GRANT what the role needs (a column grant counts);
 *   - REVOKE ALL ... FROM the role when it must have nothing. That is how a
 *     deliberate no-access object says so (0111's order_email_log: revoke from
 *     public, anon, authenticated; grant to service_role).
 * Not a decision: GRANT ... ON ALL TABLES IN SCHEMA (it names no object, and it
 * would re-grant what earlier migrations revoked, 0368's and 0384's column
 * grants included), TO PUBLIC or FROM PUBLIC (not one of the three roles),
 * REVOKE GRANT OPTION FOR (it leaves the privilege), ALTER DEFAULT PRIVILEGES
 * (later objects only), and anything in a comment, a string or a function
 * body.
 *
 * SEQUENCES. nextval() needs USAGE or UPDATE on the sequence, so an INSERT by
 * a role without it fails with "permission denied for sequence". A serial,
 * bigserial or smallserial column (serial2, serial4, serial8 too) makes such a
 * sequence, named as Postgres names it (table_column_seq cut to 63 bytes, with
 * a 1 added to the label when this file already used the name), and that
 * sequence is an object of its own here. An identity column's sequence is not:
 * Postgres draws identity values without a privilege check (REL_17_6,
 * ExecEvalNextValueExpr calls nextval_internal(seqid, false)), and on the
 * scratch database (Postgres 17.6, 2026-10-24) anon, authenticated and
 * service_role inserted into ALWAYS and BY DEFAULT identity tables holding no
 * privilege on the sequence, while their serial, bigserial, smallserial and
 * nextval-default inserts failed. Prefer identity columns.
 *
 * WHICH FILES. Every file the Supabase CLI applies (/^([0-9]+)_(.*)\.sql$/)
 * except the four-digit 0001-0401, which predate the rule: 127 of their 145
 * creations would fail it, and applied migrations are not edited. A
 * timestamped file, as `supabase migration new` names one, is checked.
 *
 * HOW IT READS SQL: ./migration-grants.ts. Comments, strings and quoted
 * identifiers are never code; a DO block's body runs during the migration and
 * is read as code; a function body runs later and is not. Names fold and are
 * cut as Postgres folds and cuts them, and an unqualified name is in public.
 * Every fixture below was applied to a fresh database on Postgres 17.6 and left
 * exactly the public objects the scanner lists, and replaying 0001-0401 ends
 * with exactly the 136 tables and 8 views of production's schema (2026-10-24).
 *
 * NOT SEEN: SQL run from a string (EXECUTE, or a function the migration
 * calls), objects CREATE EXTENSION or IMPORT FOREIGN SCHEMA makes, and a
 * search_path the file sets. Do not create public objects those ways.
 *
 * IF THIS FAILS, the message names the file, the line, the object and each
 * role never decided. After the CREATE, in the same file, add for each role
 *   grant <privileges> on <object> to <role>;   when it needs access, or
 *   revoke all on <object> from <role>;         when it must have none.
 * For a serial column's sequence, grant (or revoke) usage on sequence <name>,
 * or make the column an identity column. CREATE OR REPLACE VIEW of a view an
 * earlier migration made keeps that view's grants, but this guard reads one
 * file at a time: restate them. There is no allowlist.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createdObjects,
  formatFinding,
  isCheckedMigration,
  LAST_EXEMPT_MIGRATION,
  makeObjectName,
  MIGRATION_FILE,
  newScanState,
  reportLines,
  scanInto,
  scanMigration,
} from './migration-grants';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');
const FIXTURES_DIR = path.join(__dirname, '__fixtures__', 'migration-grants');

const migrationFiles = readdirSync(MIGRATIONS_DIR).sort();
const readMigration = (file: string): string =>
  readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

const IF_THIS_FAILS =
  'Decide each role named above in the same migration, after the CREATE: ' +
  '`grant <privileges> on <object> to <role>;` or `revoke all on <object> from <role>;` ' +
  '(see the header of apps/web/src/test/migration-grants.guard.test.ts).';

describe('every public table, view and sequence a migration from 0402 on creates is decided for anon, authenticated and service_role', () => {
  const applied = migrationFiles.filter((f) => MIGRATION_FILE.test(f));
  const checked = applied.filter(isCheckedMigration);

  it('checks every file the CLI applies after 0401, and exempts only the four-digit history', () => {
    const exempt = applied.filter((f) => !isCheckedMigration(f));
    expect(exempt).toContain('0001_init.sql');
    expect(exempt).toContain('0401_inventory_items_clear_stale_embedding.sql');
    for (const file of exempt) {
      expect(file).toMatch(/^\d{4}_/);
      expect(Number(file.slice(0, 4))).toBeLessThanOrEqual(LAST_EXEMPT_MIGRATION);
    }
    expect(checked).toEqual(applied.filter((f) => !exempt.includes(f)));
  });

  it('finds no public object a checked migration leaves undecided', () => {
    const report = checked.flatMap((file) => reportLines(scanMigration(readMigration(file), file)));
    expect(report, `\n${report.join('\n')}\n${IF_THIS_FAILS}\n`).toEqual([]);
  });
});

describe('which files are checked', () => {
  it.each([
    ['0001_init.sql', false],
    ['0401_inventory_items_clear_stale_embedding.sql', false],
    ['0402_explicit_grants.sql', true],
    ['0999_later.sql', true],
    ['20261030120000_made_by_migration_new.sql', true],
    ['402_three_digits.sql', true],
    ['0402-dash.sql', false],
    ['0402_backup.sql.orig', false],
    ['README.md', false],
  ] as const)('%s: %s', (file, isChecked) => {
    expect(isCheckedMigration(file)).toBe(isChecked);
  });
});

/** `n` copies of a two-byte UTF-8 character. */
const twoByte = (n: number): string => 'é'.repeat(n);

/**
 * Each passing fixture: the public objects it creates, in line order. Every
 * one is decided, so the guard finds nothing.
 *
 * Every fixture, passing or failing, applies cleanly to a fresh database on
 * Postgres 17.6, and the public objects the scanner lists for it are exactly
 * the ones Postgres's catalog held afterwards (identity sequences aside):
 * checked on the migration scratch database, 2026-10-24.
 */
const PASSING: Record<string, string[]> = {
  'pass/01-tables.sql': [
    'table public.widgets',
    'table public.gadgets',
    'table public.fast_rows',
    'table public.widget_names',
    'table public.pairs',
  ],
  'pass/02-quoted-names.sql': [
    'table public."Order Lines"',
    'table public.parts',
    'table public.mixed_case',
    'table public."say ""hi"""',
  ],
  'pass/03-if-not-exists.sql': ['table public.settings_cache', 'sequence public.settings_version'],
  'pass/04-views.sql': [
    'table public.base_rows',
    'view public.base_view',
    'view public.replaced_view',
    'materialized view public.base_totals',
    'materialized view public.base_totals_2',
    'view public.counting',
  ],
  'pass/05-sequences.sql': [
    'sequence public.ticket_numbers',
    'table public.tickets',
    'sequence public.tickets_id_seq',
    'sequence public.tickets_big_ref_seq',
    'sequence public.tickets_small_ref_seq',
    'table public.a_table_name_that_is_long_enough_to_force_truncation_xyz',
    'sequence public.a_table_name_that_is_long_eno_a_column_name_that_is_also_ra_seq',
    'table public."Quoted Table"',
    'sequence public."Quoted Table_Quoted Col_seq"',
    'sequence public.tickets_line_no_seq',
    'table public.clash_id_seq',
    'table public.clash',
    'sequence public.clash_id_seq1',
    `sequence public."${twoByte(28)}_id_seq"`,
    `table public."${twoByte(31)}"`,
  ],
  'pass/06-identity.sql': ['table public.events', 'table public.audit_marks'],
  'pass/07-no-access.sql': ['table public.internal_ledger', 'table public.service_only'],
  'pass/08-separate-statements.sql': ['table public.profiles'],
  'pass/09-comments-and-strings.sql': [],
  'pass/10-do-blocks.sql': ['table public.lazy_table', 'view public.lazy_view'],
  'pass/11-partitioned.sql': [
    'partitioned table public.readings',
    'partition public.readings_2026',
    'partition public.readings_default',
  ],
  'pass/12-not-public.sql': [],
  'pass/13-drop-rename-move.sql': ['sequence public.draft_name_id_seq', 'table public.final_name'],
  'pass/14-select-into.sql': ['table public.source_rows', 'table public.copied_rows'],
  'pass/15-foreign-table.sql': ['foreign table public.remote_rows'],
};

const ALL_ROLES = 'anon, authenticated, service_role';

/** Each failing fixture: exactly what the guard prints for it. */
const FAILING: Record<string, string[]> = {
  'fail/01-no-decision.sql': [
    `fail/01-no-decision.sql:3: table public.widgets has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/01-no-decision.sql:7: table public.gadgets has no GRANT or REVOKE for ${ALL_ROLES}`,
  ],
  'fail/02-missing-roles.sql': [
    'fail/02-missing-roles.sql:2: table public.orders_archive has no GRANT or REVOKE for service_role',
    'fail/02-missing-roles.sql:6: view public.orders_archive_view has no GRANT or REVOKE for anon, service_role',
  ],
  'fail/03-names-must-match.sql': [
    `fail/03-names-must-match.sql:5: table public.widgets has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/03-names-must-match.sql:8: table public."Order Lines" has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/03-names-must-match.sql:14: table public.gizmos has no GRANT or REVOKE for ${ALL_ROLES}`,
  ],
  'fail/04-if-not-exists-unlogged-ctas.sql': [
    `fail/04-if-not-exists-unlogged-ctas.sql:2: table public.cache_rows has no GRANT or REVOKE for ${ALL_ROLES}`,
    'fail/04-if-not-exists-unlogged-ctas.sql:4: table public.fast_rows has no GRANT or REVOKE for service_role',
    'fail/04-if-not-exists-unlogged-ctas.sql:7: table public.copied has no GRANT or REVOKE for authenticated, service_role',
  ],
  'fail/05-views.sql': [
    `fail/05-views.sql:6: view public.plain_view has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/05-views.sql:8: view public.replaced_view has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/05-views.sql:10: materialized view public.totals has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/05-views.sql:12: materialized view public.totals_again has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/05-views.sql:15: view public.counting has no GRANT or REVOKE for ${ALL_ROLES}`,
  ],
  'fail/06-sequences.sql': [
    `fail/06-sequences.sql:3: sequence public.ticket_numbers has no GRANT or REVOKE for ${ALL_ROLES}`,
    'fail/06-sequences.sql:4: sequence public.other_numbers has no GRANT or REVOKE for anon, service_role',
    `fail/06-sequences.sql:8: sequence public.tickets_id_seq (made by the serial column tickets.id) has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/06-sequences.sql:9: sequence public.tickets_big_ref_seq (made by the bigserial column tickets.big_ref) has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/06-sequences.sql:10: sequence public.tickets_small_ref_seq (made by the smallserial column tickets.small_ref) has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/06-sequences.sql:11: sequence public.tickets_old_style_seq (made by the serial8 column tickets.old_style) has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/06-sequences.sql:12: sequence public.tickets_quoted_type_seq (made by the serial column tickets.quoted_type) has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/06-sequences.sql:18: sequence public.later_n_seq (made by the serial2 column later.n) has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/06-sequences.sql:21: sequence public.misnamed_id_seq (made by the serial column misnamed.id) has no GRANT or REVOKE for ${ALL_ROLES}`,
  ],
  'fail/07-grant-before-create.sql': [
    `fail/07-grant-before-create.sql:6: table public.rebuilt has no GRANT or REVOKE for ${ALL_ROLES}`,
  ],
  'fail/08-not-a-decision.sql': [
    `fail/08-not-a-decision.sql:2: table public.broad has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/08-not-a-decision.sql:7: table public.via_public has no GRANT or REVOKE for ${ALL_ROLES}`,
    'fail/08-not-a-decision.sql:12: table public.option_only has no GRANT or REVOKE for service_role',
    `fail/08-not-a-decision.sql:18: table public.defaults_only has no GRANT or REVOKE for ${ALL_ROLES}`,
    'fail/08-not-a-decision.sql: a GRANT or REVOKE ... ON ALL TABLES|SEQUENCES IN SCHEMA names no object, so it decides nothing here',
  ],
  'fail/09-do-block.sql': [
    `fail/09-do-block.sql:6: table public.lazy_table has no GRANT or REVOKE for ${ALL_ROLES}`,
  ],
  'fail/10-partitioned.sql': [
    `fail/10-partitioned.sql:8: partition public.readings_2026 has no GRANT or REVOKE for ${ALL_ROLES}`,
    `fail/10-partitioned.sql:11: partitioned table public.by_list has no GRANT or REVOKE for ${ALL_ROLES}`,
  ],
  'fail/11-decisions-in-prose.sql': [
    `fail/11-decisions-in-prose.sql:2: table public.commented has no GRANT or REVOKE for ${ALL_ROLES}`,
  ],
  'fail/12-select-into.sql': [
    `fail/12-select-into.sql:5: table public.copied_rows has no GRANT or REVOKE for ${ALL_ROLES}`,
    'fail/12-select-into.sql:7: table public.moved_rows has no GRANT or REVOKE for anon, authenticated',
  ],
  'fail/13-foreign-table.sql': [
    'fail/13-foreign-table.sql:4: foreign table public.remote_rows has no GRANT or REVOKE for anon, service_role',
  ],
};

const fixture = (name: string): string => readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
const fixturesIn = (group: string): string[] =>
  readdirSync(path.join(FIXTURES_DIR, group))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => `${group}/${f}`);

describe('the scanner, on fixtures', () => {
  it('has an expectation for every fixture on disk, and a fixture for every expectation', () => {
    expect(fixturesIn('pass')).toEqual(Object.keys(PASSING).sort());
    expect(fixturesIn('fail')).toEqual(Object.keys(FAILING).sort());
  });

  it.each(Object.entries(PASSING))(
    '%s: sees each public object it creates, every one decided',
    (name, objects) => {
      const scan = scanMigration(fixture(name), name);
      expect(scan.objects.map((o) => `${o.kind} ${o.qualified}`)).toEqual(objects);
      expect(reportLines(scan)).toEqual([]);
    },
  );

  it.each(Object.entries(FAILING))(
    '%s: names the file, the object and each role never decided',
    (name, lines) => {
      expect(reportLines(scanMigration(fixture(name), name))).toEqual(lines);
    },
  );
});

describe("the names Postgres gives a serial column's sequence", () => {
  it.each([
    ['tickets', 'id', 'seq', 'tickets_id_seq'],
    ['clash', 'id', 'seq1', 'clash_id_seq1'],
    // Both over: the longer is shortened first, until the two fit 58 bytes.
    [
      'a_table_name_that_is_long_enough_to_force_truncation_xyz',
      'a_column_name_that_is_also_rather_long',
      'seq',
      'a_table_name_that_is_long_eno_a_column_name_that_is_also_ra_seq',
    ],
    // A two-byte character is never split: 62 bytes shorten to 56, 28 of them.
    [twoByte(31), 'id', 'seq', `${twoByte(28)}_id_seq`],
  ])('%s, %s, %s: %s', (table, column, label, name) => {
    expect(makeObjectName(table, column, label)).toBe(name);
  });
});

describe('history (0001-0401), which the guard exempts', () => {
  const history = migrationFiles.filter((f) => MIGRATION_FILE.test(f) && !isCheckedMigration(f));
  // History is never edited, so these never move. A scanner change that moves
  // one is a scanner bug, or must say why the old number was wrong.

  it("reads every file, and replaying them ends with production's 136 tables and 8 views and no sequence", () => {
    const state = newScanState();
    for (const file of history) scanInto(state, readMigration(file));
    const objects = createdObjects(state);
    const count = (kind: string) => objects.filter((o) => o.kind === kind).length;
    expect(count('table')).toBe(136);
    expect(
      objects
        .filter((o) => o.kind === 'view')
        .map((o) => o.name)
        .sort(),
    ).toEqual([
      'product_group_rollups',
      'return_overview',
      'stock_movement_holdings',
      'vw_inventory_valuation_by_category',
      'vw_inventory_valuation_by_warehouse',
      'vw_po_reconciliation',
      'vw_vendor_performance',
      'vw_warehouse_inbound',
    ]);
    expect(objects).toHaveLength(144);
  });

  it('would fail the rule 127 times in 145 creations: the rule has teeth on real SQL', () => {
    const scans = history.map((file) => scanMigration(readMigration(file), file));
    expect(scans.flatMap((s) => s.objects)).toHaveLength(145);
    expect(scans.flatMap((s) => s.findings)).toHaveLength(127);
    // 0017 left its two tables to the default and granted its three views to
    // authenticated alone.
    const of0017 = scans.find((s) => s.file === '0017_reconciliation_views.sql')!;
    expect(of0017.findings.map(formatFinding)).toEqual([
      `0017_reconciliation_views.sql:18: table public.tolerance_profiles has no GRANT or REVOKE for ${ALL_ROLES}`,
      `0017_reconciliation_views.sql:52: table public.approvals has no GRANT or REVOKE for ${ALL_ROLES}`,
      '0017_reconciliation_views.sql:110: view public.vw_po_reconciliation has no GRANT or REVOKE for anon, service_role',
      '0017_reconciliation_views.sql:138: view public.vw_warehouse_inbound has no GRANT or REVOKE for anon, service_role',
      '0017_reconciliation_views.sql:159: view public.vw_vendor_performance has no GRANT or REVOKE for anon, service_role',
    ]);
    // 0111 decided order_email_log for all three: revoked from anon and
    // authenticated, granted to service_role.
    const of0111 = scans.find((s) => s.file === '0111_orders_pick_slip_rpcs.sql')!;
    expect(of0111.objects.find((o) => o.name === 'order_email_log')?.decided).toEqual([
      'anon',
      'authenticated',
      'service_role',
    ]);
  });
});
