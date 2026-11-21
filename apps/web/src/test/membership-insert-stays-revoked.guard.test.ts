/**
 * Security invariant: membership rows are added by the server.
 *
 * THE RULE. The migration `<number>_membership_rows_added_by_the_server.sql`
 * leaves the data API roles, anon and authenticated, with no INSERT on
 * public.organization_members, and binds a BEFORE INSERT trigger
 * (trg_zz_organization_members_added_by_server, function
 * public.tg_membership_rows_added_by_server) that refuses a row inserted as
 * either role. The server adds every membership row through the service-role
 * client.
 *
 * WHAT THIS GUARD DOES. It reads every migration that sorts AFTER that file
 * and fails on one that
 *   grant    grants INSERT or ALL on the table, or INSERT or ALL on a column
 *            list of it, to anon, authenticated or PUBLIC: by the table's
 *            name, or through ON ALL TABLES IN SCHEMA public;
 *   trigger  drops the trigger, disables it (DISABLE TRIGGER with its name,
 *            ALL or USER on the table; ENABLE REPLICA TRIGGER with its name),
 *            or restates or renames it (CREATE OR REPLACE TRIGGER, ALTER
 *            TRIGGER);
 *   function drops, restates or alters the trigger's function.
 * A file that must do one of these is listed in REVIEWED below with the
 * finding it is allowed and the reason; an entry that no longer matches a
 * finding fails too. The pgTAP file for the same migration proves the two
 * layers on a database built from the migrations; this guard names the file
 * and line before a database is involved.
 *
 * HOW IT READS A FILE. Comments are removed (`--` to the end of the line,
 * nested block comments), also inside dollar-quoted bodies, because a DO
 * block's or a function's body is code. The text of a string constant is
 * KEPT, so a statement written inside EXECUTE '...' is read like any other;
 * a string that merely quotes such a statement therefore fails as well, and
 * is listed in REVIEWED if it is harmless. Double quotes around identifiers
 * are dropped, case is folded and the file is cut at each `;`.
 *
 * WHAT IT CANNOT SEE. SQL assembled from pieces at run time; a privilege
 * that reaches anon or authenticated through membership of another role
 * (GRANT some_role TO authenticated); the schema spelled with a Unicode
 * escape; and anything done outside the migrations folder (a statement run
 * by hand or from the dashboard). The migration's header gives the one read
 * that checks a live database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATION_FILE } from './migration-grants';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');
const ANCHOR_SUFFIX = '_membership_rows_added_by_the_server.sql';
const TABLE = 'organization_members';
const TRIGGER = 'trg_zz_organization_members_added_by_server';
const FUNCTION = 'tg_membership_rows_added_by_server';

type Rule = 'grant' | 'trigger' | 'function';

interface Finding {
  rule: Rule;
  /** 1-based line of the statement's first word in the file. */
  line: number;
  /** The statement, comments removed and whitespace folded, cut to 200. */
  statement: string;
}

/**
 * A later migration that is allowed one of the findings above. `rule` is the
 * finding it is allowed; `why` says what the file does instead to keep the
 * rule (for example: it grants INSERT inside a transaction that revokes it
 * again, or it replaces the trigger with a stricter one).
 */
const REVIEWED: ReadonlyArray<{ file: string; rule: Rule; why: string }> = [];

// ── Reading SQL ─────────────────────────────────────────────────────────────

/**
 * Removes comments and keeps everything else, newlines included (so line
 * numbers hold). String constants are kept as written; a dollar-quoted body
 * is kept with its own comments removed.
 */
function withoutComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          if (sql[i] === '\n') out += '\n';
          i += 1;
        }
      }
      out += ' ';
      continue;
    }
    if (ch === "'") {
      // E'...' reads a backslash as an escape; every form doubles the quote.
      const escapes = /[eE]$/u.test(out) && !/[A-Za-z0-9_$][eE]$/u.test(out);
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === '\\') {
          j += 2;
        } else if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
        } else if (sql[j] === "'") {
          break;
        } else {
          j += 1;
        }
      }
      out += sql.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j += 1;
      }
      out += sql.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === '$' && !/[A-Za-z0-9_$]$/u.test(out)) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(i, i + 80));
      if (tag) {
        const open = tag[0];
        const close = sql.indexOf(open, i + open.length);
        if (close !== -1) {
          out += open + withoutComments(sql.slice(i + open.length, close)) + open;
          i = close + open.length;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

const fold = (text: string): string => text.replace(/"/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();

const NAMED = (name: string): RegExp => new RegExp(`(?<![\\w.])(?:public\\s*\\.\\s*)?${name}(?![\\w.])`, 'u');
const TABLE_NAMED = NAMED(TABLE);
const TRIGGER_NAMED = new RegExp(`(?<![\\w.])${TRIGGER}(?![\\w.])`, 'u');
const FUNCTION_NAMED = NAMED(FUNCTION);

/** The rule a single folded statement breaks, or null. */
function ruleBroken(statement: string): Rule | null {
  // GRANT <privileges> ON <objects> TO <grantees>. Every GRANT in the
  // statement's text is tried, so one written inside a string is read too.
  for (const m of statement.matchAll(/\bgrant\b(.*?)\bon\b(.*?)\bto\b(.*)/gsu)) {
    const [, privileges = '', objects = '', grantees = ''] = m;
    const insertOrAll = /\b(insert|all)\b/u.test(privileges);
    const thisTable =
      TABLE_NAMED.test(objects) || /\ball\s+tables\s+in\s+schema\b.*\bpublic\b/u.test(objects);
    const apiRole = /\b(anon|authenticated|public)\b/u.test(grantees);
    if (insertOrAll && thisTable && apiRole) return 'grant';
  }

  if (TRIGGER_NAMED.test(statement)) {
    if (/\bdrop\s+trigger\b/u.test(statement)) return 'trigger';
    if (/\bcreate\s+or\s+replace\s+trigger\b/u.test(statement)) return 'trigger';
    if (/\balter\s+trigger\b/u.test(statement)) return 'trigger';
  }
  if (/\balter\s+table\b/u.test(statement) && TABLE_NAMED.test(statement)) {
    const off = new RegExp(
      `\\bdisable\\s+trigger\\s+(?:${TRIGGER}|all|user)\\b|\\benable\\s+replica\\s+trigger\\s+${TRIGGER}\\b`,
      'u',
    );
    if (off.test(statement)) return 'trigger';
  }

  if (FUNCTION_NAMED.test(statement)) {
    if (/\bdrop\s+(?:function|routine)\b/u.test(statement)) return 'function';
    if (/\bcreate\s+(?:or\s+replace\s+)?function\b/u.test(statement)) return 'function';
    if (/\balter\s+(?:function|routine)\b/u.test(statement)) return 'function';
  }
  return null;
}

/** Every statement of a file that breaks the rule. */
function findings(sql: string): Finding[] {
  const text = withoutComments(sql);
  const found: Finding[] = [];
  let start = 0;
  // Cut at every `;`, inside bodies and strings too: the pieces are only
  // ever matched against the patterns above, never run.
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && text[i] !== ';') continue;
    const raw = text.slice(start, i);
    const statement = fold(raw);
    const rule = statement === '' ? null : ruleBroken(statement);
    if (rule) {
      const lead = raw.length - raw.trimStart().length;
      const line = text.slice(0, start + lead).split('\n').length;
      found.push({ rule, line, statement: statement.slice(0, 200) });
    }
    start = i + 1;
  }
  return found;
}

// ── The migrations ──────────────────────────────────────────────────────────

interface Migration {
  file: string;
  version: bigint;
}

const migrations: Migration[] = readdirSync(MIGRATIONS_DIR)
  .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
  .filter((m): m is { file: string; match: RegExpExecArray } => m.match !== null)
  .map((m) => ({ file: m.file, version: BigInt(m.match[1]!) }));

const anchors = migrations.filter((m) => m.file.endsWith(ANCHOR_SUFFIX));
const anchor = anchors[0];

/** True when the CLI applies `m` after `a`: a higher version, or the same
 *  version and a later name. */
const sortsAfter = (m: Migration, a: Migration): boolean =>
  m.version > a.version || (m.version === a.version && m.file > a.file);

const laterMigrations: Migration[] = anchor ? migrations.filter((m) => sortsAfter(m, anchor)) : [];

const readMigration = (file: string): string => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

const IF_THIS_FAILS =
  'Membership rows are added by the server: anon and authenticated hold no INSERT on ' +
  'public.organization_members and the trigger refuses a row inserted as either role. ' +
  'A migration that must grant it, or touch the trigger or its function, is listed in REVIEWED in ' +
  'apps/web/src/test/membership-insert-stays-revoked.guard.test.ts with the reason, after a review.';

describe('membership rows are added by the server: later migrations keep both layers', () => {
  it('finds the one migration that sets the rule, and it holds both layers', () => {
    expect(anchors.map((m) => m.file)).toHaveLength(1);
    const text = fold(withoutComments(readMigration(anchor!.file)));
    expect(text).toContain(`revoke insert on table public.${TABLE} from anon, authenticated`);
    expect(text).toMatch(
      new RegExp(
        `create trigger ${TRIGGER} before insert on public\\.${TABLE} for each row execute function public\\.${FUNCTION}\\(\\)`,
        'u',
      ),
    );
    expect(text).toContain(`create function public.${FUNCTION}()`);
    expect(text).toContain(`if current_user in ('anon', 'authenticated') then raise exception`);
  });

  it('no later migration grants INSERT on the table to a data API role, or touches the trigger or its function', () => {
    const problems: string[] = [];
    for (const m of laterMigrations) {
      for (const f of findings(readMigration(m.file))) {
        if (REVIEWED.some((r) => r.file === m.file && r.rule === f.rule)) continue;
        problems.push(`supabase/migrations/${m.file}:${f.line} (${f.rule}) ${f.statement}`);
      }
    }
    expect(problems, IF_THIS_FAILS).toEqual([]);
  });

  it('every REVIEWED entry still matches a finding in a later migration, and says why', () => {
    const stale = REVIEWED.filter((r) => {
      const m = laterMigrations.find((x) => x.file === r.file);
      return !m || !findings(readMigration(m.file)).some((f) => f.rule === r.rule);
    }).map((r) => `${r.file} (${r.rule})`);
    expect(stale).toEqual([]);
    expect(REVIEWED.filter((r) => r.why.trim().length < 20).map((r) => r.file)).toEqual([]);
  });

  it('reads the files that sort after it, by version first and then by name, and nothing earlier', () => {
    // The file itself and everything before it are not read: the grant the
    // rule takes away was made by an earlier file.
    const a: Migration = { file: '0473_membership_rows_added_by_the_server.sql', version: 473n };
    const later = (file: string, version: bigint): boolean => sortsAfter({ file, version }, a);
    expect(later('0474_next.sql', 474n)).toBe(true);
    expect(later('20270101120000_timestamped.sql', 20270101120000n)).toBe(true);
    expect(later('0473_x_same_number_later_name.sql', 473n)).toBe(true);
    expect(later('0473_a_same_number_earlier_name.sql', 473n)).toBe(false);
    expect(later(a.file, 473n)).toBe(false);
    expect(later('0402_explicit_data_api_grants.sql', 402n)).toBe(false);
    expect(laterMigrations.some((m) => m.file === anchor!.file)).toBe(false);
    expect(laterMigrations.some((m) => m.file.startsWith('0402_'))).toBe(false);
  });
});

describe('the scanner, on planted statements', () => {
  const rulesOf = (sql: string): Rule[] => findings(sql).map((f) => f.rule);

  const refused: Array<[string, string, Rule]> = [
    ['INSERT to authenticated', 'grant insert on table public.organization_members to authenticated;', 'grant'],
    ['INSERT to anon, table keyword left out', 'GRANT INSERT ON public.organization_members TO anon;', 'grant'],
    ['INSERT among others, schema left out', 'grant select, insert, update on organization_members to authenticated;', 'grant'],
    ['ALL', 'grant all on table public.organization_members to authenticated;', 'grant'],
    ['ALL PRIVILEGES to PUBLIC', 'grant all privileges on public.organization_members to public;', 'grant'],
    [
      'the role named after another',
      'grant insert on table public.organization_members to service_role, authenticated;',
      'grant',
    ],
    [
      'the table named among others',
      'grant insert on table public.organization_invites, public.organization_members to authenticated;',
      'grant',
    ],
    ['a column INSERT', 'grant insert (organization_id, user_id, role) on public.organization_members to authenticated;', 'grant'],
    ['ALL on a column list', 'grant all (role) on table public.organization_members to anon;', 'grant'],
    ['quoted names and line breaks', 'grant insert\n  on table "public"."organization_members"\n  to "authenticated";', 'grant'],
    ['with grant option', 'grant insert on public.organization_members to authenticated with grant option;', 'grant'],
    ['schema-wide', 'grant insert on all tables in schema public to authenticated;', 'grant'],
    ['schema-wide ALL', 'grant all on all tables in schema extensions, public to anon, authenticated;', 'grant'],
    [
      'inside a DO block',
      "do $$ begin grant insert on table public.organization_members to authenticated; end $$;",
      'grant',
    ],
    [
      'inside EXECUTE in a DO block',
      "do $do$ begin execute 'grant insert on public.organization_members to authenticated'; end $do$;",
      'grant',
    ],
    [
      'after a comment that hides nothing',
      '-- tidy up\ngrant insert on public.organization_members to anon; -- done',
      'grant',
    ],
    [
      'dropping the trigger',
      'drop trigger trg_zz_organization_members_added_by_server on public.organization_members;',
      'trigger',
    ],
    [
      'dropping it if it exists',
      'DROP TRIGGER IF EXISTS "trg_zz_organization_members_added_by_server" ON organization_members CASCADE;',
      'trigger',
    ],
    [
      'disabling it by name',
      'alter table public.organization_members disable trigger trg_zz_organization_members_added_by_server;',
      'trigger',
    ],
    ['disabling every trigger', 'alter table public.organization_members disable trigger all;', 'trigger'],
    ['disabling the user triggers', 'alter table only organization_members disable trigger user;', 'trigger'],
    [
      'leaving it to replica sessions only',
      'alter table public.organization_members enable replica trigger trg_zz_organization_members_added_by_server;',
      'trigger',
    ],
    [
      'restating the trigger',
      'create or replace trigger trg_zz_organization_members_added_by_server before insert on public.organization_members for each row when (false) execute function public.tg_membership_rows_added_by_server();',
      'trigger',
    ],
    [
      'renaming the trigger',
      'alter trigger trg_zz_organization_members_added_by_server on public.organization_members rename to old_trigger;',
      'trigger',
    ],
    ['dropping the function', 'drop function public.tg_membership_rows_added_by_server() cascade;', 'function'],
    [
      'restating the function',
      "create or replace function public.tg_membership_rows_added_by_server() returns trigger language plpgsql as $f$ begin return new; end $f$;",
      'function',
    ],
    [
      'making it run as its owner',
      'alter function tg_membership_rows_added_by_server() security definer;',
      'function',
    ],
  ];

  it.each(refused)('refuses %s', (_name, sql, rule) => {
    expect(rulesOf(sql)).toEqual([rule]);
  });

  const allowed: Array<[string, string]> = [
    ['a revoke', 'revoke insert on table public.organization_members from anon, authenticated;'],
    ['revoking the grant option', 'revoke grant option for insert on public.organization_members from authenticated;'],
    ['other privileges', 'grant select, update, delete on table public.organization_members to authenticated;'],
    ['a column UPDATE', 'grant update (role, is_delivery_driver) on public.organization_members to authenticated;'],
    ['INSERT for the service role', 'grant insert on table public.organization_members to service_role;'],
    ['ALL for the service role', 'grant all on table public.organization_members to service_role;'],
    ['INSERT on another table', 'grant insert on table public.organization_invites to authenticated;'],
    ['a table whose name only starts the same', 'grant insert on table public.organization_members_archive to authenticated;'],
    ['the same name in another schema', 'grant insert on table reporting.organization_members to authenticated;'],
    ['EXECUTE on a function', 'grant execute on function public.count_organization_members(uuid) to authenticated;'],
    [
      'a grant named only in a comment',
      '-- grant insert on public.organization_members to authenticated;\n/* grant all on organization_members to anon; */\nselect 1;',
    ],
    [
      'a grant named only in a comment inside a body',
      "do $$ begin\n  -- grant insert on public.organization_members to authenticated;\n  perform 1;\nend $$;",
    ],
    ['another trigger dropped', 'drop trigger trg_zz_forget_draw_scope on public.organization_members;'],
    [
      'another trigger disabled',
      'alter table public.organization_members disable trigger trg_zz_record_member_role_change;',
    ],
    ['every trigger disabled on another table', 'alter table public.organization_invites disable trigger all;'],
    ['enabling it', 'alter table public.organization_members enable trigger trg_zz_organization_members_added_by_server;'],
    [
      'a comment on the trigger',
      "comment on trigger trg_zz_organization_members_added_by_server on public.organization_members is 'x';",
    ],
    ['a comment on the function', "comment on function public.tg_membership_rows_added_by_server() is 'x';"],
    ['another function restated', 'create or replace function public.tg_set_updated_at() returns trigger language plpgsql as $f$ begin return new; end $f$;'],
    ['a new index', 'create index organization_members_role_idx on public.organization_members (role);'],
  ];

  it.each(allowed)('allows %s', (_name, sql) => {
    expect(rulesOf(sql)).toEqual([]);
  });

  it('names the line of each statement and reads several in one file', () => {
    const sql = [
      'select 1;',
      '',
      '-- a comment with a ; in it',
      'grant insert on public.organization_members',
      '  to authenticated;',
      "select 'a string with -- no comment and a ; in it';",
      'drop function public.tg_membership_rows_added_by_server();',
    ].join('\n');
    expect(findings(sql).map((f) => [f.rule, f.line])).toEqual([
      ['grant', 4],
      ['function', 7],
    ]);
  });

  it('keeps what a string holds and drops what a comment holds', () => {
    expect(withoutComments("select 'it''s -- kept'; -- dropped")).toBe("select 'it''s -- kept'; ");
    expect(withoutComments('a /* b /* c */ d */ e')).toBe('a   e');
    expect(withoutComments('$x$ keep -- drop\nkeep $x$')).toBe('$x$ keep \nkeep $x$');
  });
});
