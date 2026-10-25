/**
 * MIGRATION GUARD (D1): a migration from 0402 on that creates a table, view or
 * sequence in schema public decides, in the same file, every privilege the
 * default privileges would otherwise decide for anon, authenticated and
 * service_role.
 *
 * WHY. Supabase's default privileges have given those three roles ALL on every
 * public table, view and sequence the migration role creates (production's
 * schema on 2026-10-24: ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA
 * public GRANT ALL ON TABLES, and ON SEQUENCES, TO anon, authenticated,
 * service_role). On 2026-10-30 Supabase changes that on every existing project
 * (changelog 45329: github.com/orgs/supabase/discussions/45329). It revokes
 * SELECT, INSERT, UPDATE and DELETE from the table defaults and USAGE and
 * SELECT from the sequence defaults. Objects that exist keep their grants; a
 * new one gets only what its migration grants, and the Data API refuses the
 * rest before RLS is ever asked. The local stack and CI keep the old defaults
 * (supabase/config.toml sets [api] auto_expose_new_tables = true, and CLI
 * 2.117.0 treats unset the same), so a privilege a migration leaves to the
 * defaults is there in every test and missing in production.
 *
 * THE RULE. For each public table, partitioned table, partition, view,
 * materialized view, foreign table or sequence a checked file creates, and for
 * each of anon, authenticated and service_role, a GRANT or a REVOKE after the
 * CREATE, in the same file, names each privilege the change takes out of the
 * defaults (requiredPrivileges in ./migration-grants.ts):
 *   - SELECT, INSERT, UPDATE and DELETE on a table, partitioned table,
 *     partition, view, materialized view or foreign table;
 *   - USAGE and SELECT on a sequence.
 * ALL names them all, so the usual form is
 *   revoke all on <object> from anon, authenticated, service_role;
 *   grant <what each role needs> on <object> to <role>;
 * A privilege named either way ends the same under both defaults; one named
 * by neither is whatever the defaults say, which is where CI and production
 * part. (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN and a sequence's UPDATE stay
 * in both defaults, so they cannot differ.) A partial decision is the trap:
 * 0111's `revoke all ... from public, anon, authenticated; grant select,
 * insert ... to service_role` left service_role's UPDATE and DELETE to the
 * defaults, 0230 left anon's SELECT, and 0394 service_role's INSERT, UPDATE
 * and DELETE.
 * Not a decision: a column-level GRANT or REVOKE (it leaves the table-level
 * privilege the defaults set), a schema-wide GRANT or REVOKE (it names no
 * object, and fails on its own: BLANKET STATEMENTS), TO PUBLIC or FROM PUBLIC
 * (not one of the three roles), REVOKE GRANT OPTION FOR (it leaves the
 * privilege), ALTER DEFAULT PRIVILEGES (later objects only; its GRANT form
 * fails on its own), and anything in a comment, a string or a function body.
 *
 * BLANKET STATEMENTS. In a checked file these fail whatever else the file
 * holds, each with its own file:line message:
 *   - GRANT or REVOKE (REVOKE GRANT OPTION FOR too) ... ON ALL TABLES, ALL
 *     SEQUENCES, ALL FUNCTIONS, ALL PROCEDURES or ALL ROUTINES IN SCHEMA, when
 *     the list names public in any spelling Postgres reads as public: public,
 *     PUBLIC, "public", U&"publi\0063" ("Public" in quotes is another schema);
 *   - ALTER DEFAULT PRIVILEGES ... GRANT in every form: IN SCHEMA any schema,
 *     no IN SCHEMA (database-wide, which covers public too), FOR ROLE or FOR
 *     USER, on any kind of object.
 * Why. A schema-wide statement reaches every object of its kind in public
 * when it runs (REL_17_6 aclchk.c, objectsInSchemaToOids), so neither a
 * review nor this guard can see which privileges it changes. A GRANT puts
 * back what the migrations' 512 REVOKEs took away and makes the column grants
 * (0311, 0368 and 0369, 0384 and 0388) moot, since a table-level SELECT
 * covers every column; a REVOKE takes away what they granted, and the column
 * grants of the same privilege with it (checked on 17.6). ALTER DEFAULT
 * PRIVILEGES ... GRANT gives privileges to objects not created yet, out of
 * sight of the statements that create them, and in public it puts back what
 * Supabase's change takes away. An earlier version of this guard reported a
 * schema-wide statement only in a file that had another finding, so a file
 * whose one defect was such a statement passed (automated security review,
 * 2026-10-24); none of fail/16 to fail/22 has any other defect.
 * Still allowed:
 *   - ALTER DEFAULT PRIVILEGES ... REVOKE, in any form: it only takes from
 *     what later objects get, each of which a checked file decides by name,
 *     and the deferred follow-up (option (a)) needs the changelog's two
 *     revokes (pass/17);
 *   - a schema-wide GRANT or REVOKE whose schemas are all other than public
 *     (pass/19). Postgres reads each name as that one schema
 *     (LookupExplicitNamespace, no search_path) and changes only what is in
 *     it when the statement runs, so no public object is in reach: on 17.6
 *     the public tables, sequences and functions came out untouched. A public
 *     object gets there only by being moved there or by public being renamed
 *     (a public table moved out, granted on all tables there and moved back
 *     came out granted, and so did one under a renamed public), so in a file
 *     with an ALTER ... SET SCHEMA or ALTER SCHEMA ... RENAME TO anywhere in
 *     it, such a statement fails too (fail/22).
 * They are read where Postgres runs them: at the top level, in a DO block
 * (its static statements), and as a GRANT element of CREATE SCHEMA, which
 * Postgres runs as written. In a comment, a string or a function body they
 * run nothing and are not read (pass/18).
 *
 * HELD TO POSTGRES. Every fixture below was applied, on the migration scratch
 * server (Postgres 17.6, 2026-10-24), to a fresh database with the old
 * default privileges and to one with the changelog's two statements added.
 * For each, the public objects Postgres held are exactly the ones the scanner
 * lists, and the (object, role, privilege) triples whose ACL differs between
 * the two databases are exactly the scanner's findings, identity sequences
 * aside. Two differences are deliberate: a schema-wide grant (fail/08) and a
 * GRANT run by EXECUTE (fail/09) do settle a privilege in Postgres, and are
 * still not accepted as decisions. Every public object in the blanket
 * fixtures (fail/16 to fail/22, pass/17 to pass/19) comes out the same under
 * both, so a blanket statement is all that fails them. On the history, a
 * scratch replay of 0001-0401 under the changelog's defaults agrees: of the
 * 17 objects an earlier version of this rule counted as decided, the 4 it now
 * flags are the 4 whose privileges came out different from production's.
 *
 * SEQUENCES. Under the changelog's defaults a new sequence keeps UPDATE, so
 * nextval() and serial inserts keep working after 2026-10-30. It loses USAGE
 * and SELECT, which currval(), lastval() and reading the sequence need, and
 * which nextval() needs once UPDATE goes too (revoke all on sequences in the
 * defaults). A serial, bigserial or smallserial column (serial2, serial4,
 * serial8 too) makes such a sequence, named as Postgres names it
 * (table_column_seq cut to 63 bytes, with a 1 added to the label when this
 * file already used the name), and that sequence is an object of its own
 * here. An identity column's sequence is not: Postgres draws identity values
 * without a privilege check (REL_17_6, ExecEvalNextValueExpr calls
 * nextval_internal(seqid, false)), so identity inserts work under any
 * defaults (checked on Postgres 17.6 with none at all). Only currval(),
 * lastval() and reading the identity sequence need its USAGE or SELECT, and
 * nothing in this repository calls them: use RETURNING. Prefer identity
 * columns.
 *
 * WHICH FILES. Every file the Supabase CLI applies (/^([0-9]+)_(.*)\.sql$/)
 * except the four-digit 0001-0401, which predate the rule: 132 of their 145
 * creations would fail it, and applied migrations are not edited. A
 * timestamped file, as `supabase migration new` names one, is checked.
 *
 * HOW IT READS SQL: ./migration-grants.ts. Comments, strings and quoted
 * identifiers are never code, and their escapes (E'...', U&"...", UESCAPE)
 * are decoded as Postgres decodes them. A DO block's body runs during the
 * migration and is read as code; a function body runs later and is not.
 * EXPLAIN ANALYZE runs its statement and a parenthesized SELECT INTO creates
 * its table, so both are read. Names fold and are cut as Postgres folds and
 * cuts them, and an unqualified name is in public. An object SET SCHEMA moves
 * out of public and back is the same object; one moved in from another schema
 * never had public's default privileges and is not checked. Dropping a
 * column, a partitioned table or a schema drops what Postgres drops with it.
 * Replaying 0001-0401 ends with exactly the 136 tables and 8 views of
 * production's schema (2026-10-24).
 *
 * NOT SEEN: SQL run from a string (EXECUTE, or a function the migration
 * calls), a CREATE and a blanket statement alike: a DO block's EXECUTE 'grant
 * select on all tables in schema public to anon' runs, and its text cannot be
 * read statically. Nor objects CREATE EXTENSION or IMPORT FOREIGN SCHEMA
 * makes, a search_path or standard_conforming_strings the file sets, and a
 * serial sequence whose name clashes with an object this file did not create
 * in public. Nor, across files, an object an earlier file moved out of public
 * (0359 moved functions into ledger) that a schema-wide statement reaches
 * there and a later file moves back: each file is read alone, and the later
 * file's SET SCHEMA public names the object. Do not create public objects or
 * grant those ways. One case errs the other way: an object that only DROP ...
 * CASCADE removes, through a dependency (a view on a dropped table), is still
 * listed; drop it by name.
 *
 * IF THIS FAILS, the message names the file, the line, the object and, for
 * each role, the privileges nothing names. After the CREATE, in the same
 * file:
 *   revoke all on <object> from anon, authenticated, service_role;
 *   grant <privileges> on <object> to <role>;   for each role that needs some.
 * For a serial column's sequence, the same on sequence <name> (grant usage,
 * select), or make the column an identity column. CREATE OR REPLACE VIEW of a
 * view an earlier migration made keeps that view's grants, but this guard
 * reads one file at a time: restate them. For a blanket statement, grant or
 * revoke on each object by name instead; to take privileges out of what later
 * objects get, ALTER DEFAULT PRIVILEGES ... REVOKE is allowed. There is no
 * allowlist.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createdObjects,
  formatBlanket,
  formatFinding,
  isCheckedMigration,
  LAST_EXEMPT_MIGRATION,
  makeObjectName,
  MIGRATION_FILE,
  newScanState,
  reportLines,
  requiredPrivileges,
  scanInto,
  scanMigration,
} from './migration-grants';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');
const FIXTURES_DIR = path.join(__dirname, '__fixtures__', 'migration-grants');

const migrationFiles = readdirSync(MIGRATIONS_DIR).sort();
const readMigration = (file: string): string =>
  readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

const IF_THIS_FAILS =
  'Name each privilege listed above for its role in the same migration, after the CREATE: ' +
  '`revoke all on <object> from anon, authenticated, service_role;` and then ' +
  '`grant <privileges> on <object> to <role>;` for each role that needs some. ' +
  'Replace a schema-wide GRANT or REVOKE, or an ALTER DEFAULT PRIVILEGES ... GRANT, with a ' +
  'GRANT or REVOKE on each object by name. ' +
  'The local stack and CI still grant them by default; production stops on 2026-10-30 ' +
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

  it('finds no privilege a checked migration leaves to the default privileges', () => {
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
 * the ones Postgres's catalog held afterwards (identity sequences aside).
 * Each passing fixture leaves the three roles the same ACL on every one of
 * its objects whether the database has the old default privileges or the
 * changelog's; each failing one differs in exactly the privileges its
 * findings name, except where fail/08 and fail/09 say otherwise. Checked on
 * the migration scratch server, 2026-10-24.
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
  'pass/16-unusual-forms.sql': [
    'table public.paren_rows',
    'table public.explained_rows',
    'table public.explained_into',
    'materialized view public.explained_totals',
    'table public.uni_rows',
    'table public.data',
    'table public.escaped_rows',
    'table public.round_trip',
    'sequence public.round_trip_id_seq',
    'table public.with_counter',
    'partitioned table public.events_by_kind',
    'partition public.events_kind_a',
  ],
  'pass/17-default-privileges-revoke.sql': ['table public.after_revokes'],
  'pass/18-blanket-words-in-prose.sql': [],
  'pass/19-schema-wide-elsewhere.sql': ['table public.visible_rows'],
};

const ALL_ROLES = 'anon, authenticated, service_role';
const LEFT = 'leaves to the default privileges:';
/** Every privilege the changelog takes out of the defaults, by kind. */
const EVERY_TABLE = 'SELECT, INSERT, UPDATE, DELETE';
const EVERY_SEQUENCE = 'USAGE, SELECT';

/** What a schema-wide statement reaches, by the kind it names. */
const REACHES = {
  TABLES: 'table, view, materialized view and foreign table',
  SEQUENCES: 'sequence',
  FUNCTIONS: 'function and aggregate',
  PROCEDURES: 'procedure',
  ROUTINES: 'function, aggregate and procedure',
} as const;

/** The line for a schema-wide GRANT or REVOKE whose list names public. */
const inPublic = (
  at: string,
  verb: 'GRANT' | 'REVOKE',
  kind: keyof typeof REACHES,
  schemas = 'public',
): string =>
  `${at}: ${verb} ... ON ALL ${kind} IN SCHEMA ${schemas} reaches every ${REACHES[kind]} in public, ` +
  `so it would ${verb === 'GRANT' ? 'put back what earlier migrations revoked' : 'take away what earlier migrations granted'}; ` +
  `${verb.toLowerCase()} on each object by name`;

/** The line for an ALTER DEFAULT PRIVILEGES ... GRANT. */
const defaultsGrant = (at: string): string =>
  `${at}: ALTER DEFAULT PRIVILEGES ... GRANT gives privileges to objects not created yet, ` +
  'out of sight of the statements that create them; grant on each object by name after creating it';

/** Each failing fixture: exactly what the guard prints for it. */
const FAILING: Record<string, string[]> = {
  'fail/01-no-decision.sql': [
    `fail/01-no-decision.sql:3: table public.widgets ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/01-no-decision.sql:7: table public.gadgets ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
  ],
  'fail/02-missing-roles.sql': [
    `fail/02-missing-roles.sql:2: table public.orders_archive ${LEFT} ${EVERY_TABLE} for service_role`,
    `fail/02-missing-roles.sql:6: view public.orders_archive_view ${LEFT} ${EVERY_TABLE} for anon, service_role`,
  ],
  'fail/03-names-must-match.sql': [
    `fail/03-names-must-match.sql:5: table public.widgets ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/03-names-must-match.sql:8: table public."Order Lines" ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/03-names-must-match.sql:14: table public.gizmos ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
  ],
  'fail/04-if-not-exists-unlogged-ctas.sql': [
    `fail/04-if-not-exists-unlogged-ctas.sql:2: table public.cache_rows ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/04-if-not-exists-unlogged-ctas.sql:4: table public.fast_rows ${LEFT} ${EVERY_TABLE} for service_role`,
    `fail/04-if-not-exists-unlogged-ctas.sql:7: table public.copied ${LEFT} ${EVERY_TABLE} for authenticated, service_role`,
  ],
  'fail/05-views.sql': [
    `fail/05-views.sql:6: view public.plain_view ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/05-views.sql:8: view public.replaced_view ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/05-views.sql:10: materialized view public.totals ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/05-views.sql:12: materialized view public.totals_again ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/05-views.sql:15: view public.counting ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
  ],
  'fail/06-sequences.sql': [
    `fail/06-sequences.sql:3: sequence public.ticket_numbers ${LEFT} ${EVERY_SEQUENCE} for ${ALL_ROLES}`,
    `fail/06-sequences.sql:4: sequence public.other_numbers ${LEFT} ${EVERY_SEQUENCE} for anon, service_role; SELECT for authenticated`,
    `fail/06-sequences.sql:8: sequence public.tickets_id_seq (made by the serial column tickets.id) ${LEFT} ${EVERY_SEQUENCE} for ${ALL_ROLES}`,
    `fail/06-sequences.sql:9: sequence public.tickets_big_ref_seq (made by the bigserial column tickets.big_ref) ${LEFT} ${EVERY_SEQUENCE} for ${ALL_ROLES}`,
    `fail/06-sequences.sql:10: sequence public.tickets_small_ref_seq (made by the smallserial column tickets.small_ref) ${LEFT} ${EVERY_SEQUENCE} for ${ALL_ROLES}`,
    `fail/06-sequences.sql:11: sequence public.tickets_old_style_seq (made by the serial8 column tickets.old_style) ${LEFT} ${EVERY_SEQUENCE} for ${ALL_ROLES}`,
    `fail/06-sequences.sql:12: sequence public.tickets_quoted_type_seq (made by the serial column tickets.quoted_type) ${LEFT} ${EVERY_SEQUENCE} for ${ALL_ROLES}`,
    `fail/06-sequences.sql:18: sequence public.later_n_seq (made by the serial2 column later.n) ${LEFT} ${EVERY_SEQUENCE} for ${ALL_ROLES}`,
    `fail/06-sequences.sql:21: sequence public.misnamed_id_seq (made by the serial column misnamed.id) ${LEFT} ${EVERY_SEQUENCE} for ${ALL_ROLES}`,
  ],
  'fail/07-grant-before-create.sql': [
    `fail/07-grant-before-create.sql:6: table public.rebuilt ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
  ],
  'fail/08-not-a-decision.sql': [
    `fail/08-not-a-decision.sql:2: table public.broad ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    inPublic('fail/08-not-a-decision.sql:4', 'GRANT', 'TABLES'),
    inPublic('fail/08-not-a-decision.sql:5', 'GRANT', 'SEQUENCES'),
    `fail/08-not-a-decision.sql:7: table public.via_public ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/08-not-a-decision.sql:12: table public.option_only ${LEFT} ${EVERY_TABLE} for service_role`,
    `fail/08-not-a-decision.sql:18: table public.defaults_only ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    defaultsGrant('fail/08-not-a-decision.sql:19'),
  ],
  'fail/09-do-block.sql': [
    `fail/09-do-block.sql:6: table public.lazy_table ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
  ],
  'fail/10-partitioned.sql': [
    `fail/10-partitioned.sql:8: partition public.readings_2026 ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/10-partitioned.sql:11: partitioned table public.by_list ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
  ],
  'fail/11-decisions-in-prose.sql': [
    `fail/11-decisions-in-prose.sql:2: table public.commented ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
  ],
  'fail/12-select-into.sql': [
    `fail/12-select-into.sql:5: table public.copied_rows ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/12-select-into.sql:7: table public.moved_rows ${LEFT} ${EVERY_TABLE} for anon, authenticated`,
  ],
  'fail/13-foreign-table.sql': [
    `fail/13-foreign-table.sql:4: foreign table public.remote_rows ${LEFT} ${EVERY_TABLE} for anon, service_role`,
  ],
  'fail/14-partial-decisions.sql': [
    `fail/14-partial-decisions.sql:5: table public.log_rows ${LEFT} UPDATE, DELETE for service_role`,
    `fail/14-partial-decisions.sql:9: table public.stats_rows ${LEFT} SELECT for anon`,
    `fail/14-partial-decisions.sql:14: view public.overview ${LEFT} INSERT, UPDATE, DELETE for service_role`,
    `fail/14-partial-decisions.sql:19: table public.read_only ${LEFT} INSERT, UPDATE, DELETE for ${ALL_ROLES}`,
    `fail/14-partial-decisions.sql:23: table public.by_column ${LEFT} SELECT, INSERT, UPDATE for ${ALL_ROLES}`,
    `fail/14-partial-decisions.sql:28: sequence public.counter ${LEFT} SELECT for ${ALL_ROLES}`,
    `fail/14-partial-decisions.sql:30: sequence public.reader ${LEFT} USAGE for anon, authenticated`,
  ],
  'fail/15-unusual-forms.sql': [
    `fail/15-unusual-forms.sql:3: table public.paren_rows ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/15-unusual-forms.sql:4: table public.explained_rows ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/15-unusual-forms.sql:5: table public.explained_into ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/15-unusual-forms.sql:6: table public.uni_rows ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/15-unusual-forms.sql:7: table public.data ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/15-unusual-forms.sql:8: table public.escaped_rows ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
    `fail/15-unusual-forms.sql:11: table public.round_trip ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
  ],
  // The blanket statements: each fixture's objects are all decided, so these
  // lines are all that fails them.
  'fail/16-grant-on-all-tables.sql': [
    'fail/16-grant-on-all-tables.sql:9: GRANT ... ON ALL TABLES IN SCHEMA public reaches every table, ' +
      'view, materialized view and foreign table in public, so it would put back what earlier ' +
      'migrations revoked; grant on each object by name',
  ],
  'fail/17-revoke-on-all-sequences.sql': [
    'fail/17-revoke-on-all-sequences.sql:8: REVOKE ... ON ALL SEQUENCES IN SCHEMA public reaches ' +
      'every sequence in public, so it would take away what earlier migrations granted; revoke on ' +
      'each object by name',
  ],
  'fail/18-grant-on-all-functions.sql': [
    'fail/18-grant-on-all-functions.sql:12: GRANT ... ON ALL FUNCTIONS IN SCHEMA public reaches every ' +
      'function and aggregate in public, so it would put back what earlier migrations revoked; grant ' +
      'on each object by name',
  ],
  'fail/19-alter-default-privileges-grant.sql': [
    'fail/19-alter-default-privileges-grant.sql:10: ALTER DEFAULT PRIVILEGES ... GRANT gives privileges ' +
      'to objects not created yet, out of sight of the statements that create them; grant on each ' +
      'object by name after creating it',
  ],
  'fail/20-schema-wide-forms.sql': [
    ...[5, 6, 7, 8, 9].map((line) =>
      inPublic(`fail/20-schema-wide-forms.sql:${line}`, 'GRANT', 'TABLES'),
    ),
    inPublic('fail/20-schema-wide-forms.sql:11', 'GRANT', 'TABLES', 'd1_other, public'),
    inPublic('fail/20-schema-wide-forms.sql:12', 'GRANT', 'SEQUENCES'),
    inPublic('fail/20-schema-wide-forms.sql:13', 'GRANT', 'PROCEDURES'),
    inPublic('fail/20-schema-wide-forms.sql:14', 'GRANT', 'ROUTINES'),
    inPublic('fail/20-schema-wide-forms.sql:15', 'REVOKE', 'TABLES'),
    inPublic('fail/20-schema-wide-forms.sql:16', 'REVOKE', 'FUNCTIONS'),
    inPublic('fail/20-schema-wide-forms.sql:17', 'REVOKE', 'TABLES'),
    inPublic('fail/20-schema-wide-forms.sql:18', 'REVOKE', 'ROUTINES'),
    inPublic('fail/20-schema-wide-forms.sql:22', 'GRANT', 'TABLES'),
    inPublic('fail/20-schema-wide-forms.sql:26', 'REVOKE', 'SEQUENCES'),
    inPublic('fail/20-schema-wide-forms.sql:29', 'GRANT', 'TABLES'),
  ],
  'fail/21-default-privileges-forms.sql': [7, 8, 9, 10, 12, 13, 14, 15, 18].map((line) =>
    defaultsGrant(`fail/21-default-privileges-forms.sql:${line}`),
  ),
  'fail/22-schema-wide-after-a-move.sql': [
    'fail/22-schema-wide-after-a-move.sql:10: GRANT ... ON ALL TABLES IN SCHEMA d1_stash reaches every ' +
      'table, view, materialized view and foreign table in d1_stash when it runs, and this file moves ' +
      'objects between schemas or renames one (lines 9, 11, 13, 15), which can put public objects ' +
      'there; grant on each object by name',
    'fail/22-schema-wide-after-a-move.sql:14: REVOKE ... ON ALL SEQUENCES IN SCHEMA d1_public_renamed ' +
      'reaches every sequence in d1_public_renamed when it runs, and this file moves objects between ' +
      'schemas or renames one (lines 9, 11, 13, 15), which can put public objects there; revoke on ' +
      'each object by name',
  ],
};

/** The fixtures whose only defects are blanket statements. */
const BLANKET_ONLY = [
  'fail/16-grant-on-all-tables.sql',
  'fail/17-revoke-on-all-sequences.sql',
  'fail/18-grant-on-all-functions.sql',
  'fail/19-alter-default-privileges-grant.sql',
  'fail/20-schema-wide-forms.sql',
  'fail/21-default-privileges-forms.sql',
  'fail/22-schema-wide-after-a-move.sql',
];

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

  // The gap the 2026-10-24 security review found: a blanket statement used to
  // be reported only in a file that had another finding.
  it.each(BLANKET_ONLY)(
    '%s: every object decided, so its blanket statements alone fail it',
    (name) => {
      const scan = scanMigration(fixture(name), name);
      expect(scan.findings).toEqual([]);
      expect(scan.blanket.length).toBeGreaterThan(0);
      expect(reportLines(scan)).toEqual(scan.blanket.map(formatBlanket));
    },
  );

  it('cannot read a blanket statement run from a string, which Postgres runs (NOT SEEN in the header)', () => {
    const dynamic =
      "do $$ begin execute 'grant select on all tables in schema public to anon'; end $$;";
    expect(scanMigration(dynamic, 'dynamic.sql').blanket).toEqual([]);
  });
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

describe('the privileges a decision names', () => {
  it.each([
    ['table', EVERY_TABLE],
    ['partitioned table', EVERY_TABLE],
    ['partition', EVERY_TABLE],
    ['view', EVERY_TABLE],
    ['materialized view', EVERY_TABLE],
    ['foreign table', EVERY_TABLE],
    ['sequence', EVERY_SEQUENCE],
  ] as const)('%s: %s, what changelog 45329 takes out of the defaults', (kind, privileges) => {
    expect(requiredPrivileges(kind).join(', ')).toBe(privileges);
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

  it('holds no blanket statement: no schema-wide GRANT or REVOKE, no ALTER DEFAULT PRIVILEGES ... GRANT', () => {
    const blanket = history.flatMap((file) => scanMigration(readMigration(file), file).blanket);
    expect(blanket.map(formatBlanket)).toEqual([]);
  });

  it('would fail the rule 132 times in 145 creations: the rule has teeth on real SQL', () => {
    const scans = history.map((file) => scanMigration(readMigration(file), file));
    expect(scans.flatMap((s) => s.objects)).toHaveLength(145);
    expect(scans.flatMap((s) => s.findings)).toHaveLength(132);
    // 0017 left its two tables to the default and granted SELECT on its three
    // views to authenticated alone.
    const of0017 = scans.find((s) => s.file === '0017_reconciliation_views.sql')!;
    expect(of0017.findings.map(formatFinding)).toEqual([
      `0017_reconciliation_views.sql:18: table public.tolerance_profiles ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
      `0017_reconciliation_views.sql:52: table public.approvals ${LEFT} ${EVERY_TABLE} for ${ALL_ROLES}`,
      `0017_reconciliation_views.sql:110: view public.vw_po_reconciliation ${LEFT} ${EVERY_TABLE} for anon, service_role; INSERT, UPDATE, DELETE for authenticated`,
      `0017_reconciliation_views.sql:138: view public.vw_warehouse_inbound ${LEFT} ${EVERY_TABLE} for anon, service_role; INSERT, UPDATE, DELETE for authenticated`,
      `0017_reconciliation_views.sql:159: view public.vw_vendor_performance ${LEFT} ${EVERY_TABLE} for anon, service_role; INSERT, UPDATE, DELETE for authenticated`,
    ]);
  });

  // A scratch replay of 0001-0401 with Supabase's new defaults run first
  // (2026-10-24) left these four with privileges production does not have
  // and the other thirteen below exactly as production has them.
  it('flags the partial decisions in 0111, 0230, 0394 and 0396, which give a role a different privilege under the new defaults', () => {
    const files = [
      '0111_orders_pick_slip_rpcs.sql',
      '0230_dashboard_snapshot_rollups.sql',
      '0394_returns_lifecycle_original_rack.sql',
      '0396_returns_exchange_staff.sql',
    ];
    const lines = files.flatMap((file) =>
      scanMigration(readMigration(file), file)
        .findings.filter((f) =>
          [
            'order_email_log',
            'org_daily_stats',
            'org_daily_movement_stats',
            'return_overview',
          ].some((name) => f.object === `public.${name}`),
        )
        .map(formatFinding),
    );
    expect(lines).toEqual([
      `0111_orders_pick_slip_rpcs.sql:239: table public.order_email_log ${LEFT} UPDATE, DELETE for service_role`,
      `0230_dashboard_snapshot_rollups.sql:111: table public.org_daily_stats ${LEFT} SELECT for anon`,
      `0230_dashboard_snapshot_rollups.sql:129: table public.org_daily_movement_stats ${LEFT} SELECT for anon`,
      `0394_returns_lifecycle_original_rack.sql:2537: view public.return_overview ${LEFT} INSERT, UPDATE, DELETE for service_role`,
      `0396_returns_exchange_staff.sql:3027: view public.return_overview ${LEFT} INSERT, UPDATE, DELETE for service_role`,
    ]);
  });

  it('counts as decided only the 13 creations that came out the same as production under the new defaults', () => {
    const decided = history.flatMap((file) =>
      scanMigration(readMigration(file), file)
        .objects.filter((o) => o.missing.length === 0)
        .map((o) => `${file.slice(0, 4)} ${o.name}`),
    );
    expect(decided).toEqual([
      '0370 exception_occurrences',
      '0370 exception_occurrence_events',
      '0370 exception_occurrence_counters',
      '0370 exception_sync_state',
      '0373 stock_movement_holdings',
      '0375 exception_evidence',
      '0389 order_request_secrets',
      '0391 order_submissions',
      '0394 return_decisions',
      '0396 return_exchange_lines',
      '0399 item_grouping_requests',
      '0400 item_display_groups',
      '0400 item_display_group_members',
    ]);
  });
});
