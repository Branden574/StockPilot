import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runReaderQueryOnLine } from '@/test/clickhouse-row-model';

import { AUTH_LOGS_TOTALS_SQL } from './auth-logs';

/**
 * Security invariant: none of this app's own ordinary requests to Supabase
 * falls inside the refused sign-ins reader's wide net as a request of an
 * unknown form.
 *
 * The reader (server/security/auth-logs.ts) reads every refused POST on
 * Supabase's gateway whose path, decoded and in small letters, holds `auth`
 * and one of `token`, `factors` or `verify`, wherever they stand, and stores
 * one FLAGGED count for any of them that is not an exact sign-in form (unless
 * it was answered 404). The net is wide on purpose: no spelling of the
 * sign-in paths can slip past it. Its price is that a name of our own that
 * holds both words would flag our own refusals: every expired session
 * refused on a database function called, say, `auth_token_refresh` would be
 * one flagged count an hour, and a real flag would be lost in that noise.
 *
 * So every name this app puts in a path at Supabase is read from where it is
 * made, and the reader's OWN query text (run on a made-up refused POST to
 * that path, through the test model of ClickHouse) must not keep the line:
 *   - database functions (`/rest/v1/rpc/<name>`), tables and views
 *     (`/rest/v1/<name>`), and every name given by a rename: from every
 *     migration under supabase/migrations, every schema (stricter than the
 *     exposed one);
 *   - storage buckets (`/storage/v1/object/<bucket>/..` and its POST forms
 *     `sign`, `upload/sign` and `list`): every literal of a
 *     storage.buckets insert and every `bucket_id = '<id>'` in a migration;
 *     the objects' own names are ids and an extension, never a member's
 *     file name;
 *   - Edge Functions (`/functions/v1/<name>`): the folder names under
 *     supabase/functions, when it exists.
 * The ordinary sign-in requests the app makes are inside the net by design;
 * the last test pins that each of them is an exact form, never an unknown
 * one. A name that fails here is renamed, or the reader learns a kind for it
 * (counted, not flagged) before it ships.
 * The self-tests at the bottom plant each kind of name, so this cannot pass
 * by reading nothing.
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const REPO = path.resolve(WEB_SRC, '../../..');
const MIGRATIONS = path.join(REPO, 'supabase/migrations');
const EDGE_FUNCTIONS = path.join(REPO, 'supabase/functions');

/** A name as written in SQL: bare or in double quotes, maybe after a schema. */
const NAME = String.raw`(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const FUNCTION_RE = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+${NAME}`,
  'gi',
);
const TABLE_RE = new RegExp(
  String.raw`\bcreate\s+(?:(?:global\s+|local\s+)?(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}`,
  'gi',
);
const VIEW_RE = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${NAME}`,
  'gi',
);
const RENAME_RE = new RegExp(String.raw`\brename\s+to\s+${NAME}`, 'gi');
const BUCKET_INSERT_RE =
  /\binsert\s+into\s+storage\s*\.\s*buckets\b([\s\S]*?)(?:\bon\s+conflict\b|;)/gi;
const BUCKET_ID_RE = /\bbucket_id\s*(?:=\s*'([^']*)'|in\s*\(([^)]*)\))/gi;
const LITERAL_RE = /'([^']*)'/g;

interface NamesInPaths {
  functions: Set<string>;
  /** Tables, views and renamed names: each is a path of its own at `/rest/v1/`. */
  relations: Set<string>;
  buckets: Set<string>;
  edgeFunctions: Set<string>;
}

const unquote = (name: string) => (name.startsWith('"') ? name.slice(1, -1) : name);

/** Every name one migration's text gives to something that can be in a path. */
function namesInMigration(sql: string, into: NamesInPaths): void {
  for (const m of sql.matchAll(FUNCTION_RE)) into.functions.add(unquote(m[1]!));
  for (const re of [TABLE_RE, VIEW_RE, RENAME_RE]) {
    for (const m of sql.matchAll(re)) into.relations.add(unquote(m[1]!));
  }
  for (const m of sql.matchAll(BUCKET_INSERT_RE)) {
    for (const lit of m[1]!.matchAll(LITERAL_RE)) into.buckets.add(lit[1]!);
  }
  for (const m of sql.matchAll(BUCKET_ID_RE)) {
    if (m[1] !== undefined) into.buckets.add(m[1]);
    for (const lit of (m[2] ?? '').matchAll(LITERAL_RE)) into.buckets.add(lit[1]!);
  }
}

function emptyNames(): NamesInPaths {
  return {
    functions: new Set(),
    relations: new Set(),
    buckets: new Set(),
    edgeFunctions: new Set(),
  };
}

/** The gateway paths a POST of this app can carry for each name. */
function pathsOf(names: NamesInPaths): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const OBJECT =
    '00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000001/a1b2.png';
  for (const n of names.functions) out.push([`function ${n}`, `/rest/v1/rpc/${n}`]);
  for (const n of names.relations) out.push([`table or view ${n}`, `/rest/v1/${n}`]);
  for (const n of names.buckets) {
    out.push([`bucket ${n}`, `/storage/v1/object/${n}/${OBJECT}`]);
    out.push([`bucket ${n} (sign)`, `/storage/v1/object/sign/${n}/${OBJECT}`]);
    out.push([`bucket ${n} (upload sign)`, `/storage/v1/object/upload/sign/${n}/${OBJECT}`]);
    out.push([`bucket ${n} (list)`, `/storage/v1/object/list/${n}`]);
  }
  for (const n of names.edgeFunctions) out.push([`Edge Function ${n}`, `/functions/v1/${n}`]);
  return out;
}

/** A refused POST to `path`, as the gateway logs it (made up). */
const refusedPost = (requestPath: string, status = '401') => ({
  source: 'edge_logs',
  attributes: {
    'request.method': 'POST',
    'request.path': requestPath,
    'request.search': '',
    'response.status_code': status,
    'request.headers.x_client_info': 'supabase-js-react-native/2.50.0',
    'request.cf.asOrganization': 'Example Telecom',
    'request.cf.country': 'NL',
  },
});

/**
 * Whether the reader reads a refused POST to `path` at all: its totals query,
 * whose innermost WHERE is the net (the groups query has the same one and
 * keeps fewer lines; the reader's own test compares the two).
 */
const inTheNet = (requestPath: string) =>
  runReaderQueryOnLine(AUTH_LOGS_TOTALS_SQL, refusedPost(requestPath), []).kept;

/** Every name in a path of this app that the reader's net would read. */
function caught(names: NamesInPaths): string[] {
  return pathsOf(names)
    .filter(([, p]) => inTheNet(p))
    .map(([what, p]) => `${what}: ${p}`);
}

describe("the reader's wide net holds none of this app's own names", () => {
  const names = emptyNames();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
  for (const f of files) namesInMigration(readFileSync(path.join(MIGRATIONS, f), 'utf8'), names);
  if (existsSync(EDGE_FUNCTIONS)) {
    for (const entry of readdirSync(EDGE_FUNCTIONS)) {
      if (statSync(path.join(EDGE_FUNCTIONS, entry)).isDirectory()) names.edgeFunctions.add(entry);
    }
  }

  it('reads the real migrations, with the real names in them', () => {
    expect(files.length).toBeGreaterThan(400);
    expect(names.functions.size).toBeGreaterThan(300);
    expect(names.relations.size).toBeGreaterThan(100);
    expect(names.buckets.size).toBeGreaterThanOrEqual(8);
    // Names the app calls every day, and the ones closest to the net.
    for (const n of ['record_security_events', 'register_push_token', 'auth_user_exists_by_email'])
      expect(names.functions, n).toContain(n);
    for (const n of ['security_events', 'push_tokens', 'organization_members'])
      expect(names.relations, n).toContain(n);
    for (const n of ['item-images', 'po-attachments', 'org-logos', 'user-avatars'])
      expect(names.buckets, n).toContain(n);
  });

  it('no database function, table, view, bucket or Edge Function of ours is inside the net', () => {
    expect(caught(names)).toEqual([]);
  });

  it("the app's ordinary sign-in requests are inside the net only as exact forms, never as an unknown one", () => {
    // POSTs the app (web or phone, through supabase-js) makes to the sign-in
    // service. Each is either outside the net or one of the reader's named
    // kinds; none is token_other, verify_other or emailed_code_other.
    const UUID = '5eed0000-0000-4000-8000-00000000c0de';
    const unknown = ['token_other', 'verify_other', 'emailed_code_other'];
    const ordinary: Array<[string, string]> = [
      ['/auth/v1/token', '?grant_type=password'],
      ['/auth/v1/token', '?grant_type=refresh_token'],
      ['/auth/v1/token', '?grant_type=pkce'],
      ['/auth/v1/token', '?grant_type=id_token'],
      ['/auth/v1/factors', ''],
      [`/auth/v1/factors/${UUID}/challenge`, ''],
      [`/auth/v1/factors/${UUID}/verify`, ''],
      ['/auth/v1/verify', ''],
      ['/auth/v1/otp', ''],
      ['/auth/v1/recover', ''],
      ['/auth/v1/magiclink', ''],
      ['/auth/v1/resend', ''],
      ['/auth/v1/signup', ''],
      ['/auth/v1/logout', ''],
      ['/auth/v1/sso', ''],
      ['/auth/v1/invite', ''],
      ['/auth/v1/admin/generate_link', ''],
      ['/auth/v1/admin/users', ''],
    ];
    for (const [requestPath, search] of ordinary) {
      const line = refusedPost(requestPath, '400');
      line.attributes['request.search'] = search;
      const { kept, values } = runReaderQueryOnLine(AUTH_LOGS_TOTALS_SQL, line, ['kind']);
      if (kept) expect(unknown, `${requestPath}${search}`).not.toContain(values.kind);
    }
  });
});

describe('the net guard finds what it is meant to find (self-test)', () => {
  const namesOf = (sql: string) => {
    const names = emptyNames();
    namesInMigration(sql, names);
    return names;
  };

  it.each([
    ['create or replace function public.auth_token_check() returns void', 'function'],
    ['CREATE FUNCTION "public"."Auth_Verify_Code"(p text) RETURNS boolean', 'function'],
    ['create procedure private.rotate_auth_factors()', 'function'],
    ['create table if not exists public.oauth_tokens (id uuid)', 'table or view'],
    ['create unlogged table auth_verify_queue (id uuid)', 'table or view'],
    ['create or replace view public.author_tokens as select 1', 'table or view'],
    ['create materialized view if not exists auth_factors_seen as select 1', 'table or view'],
    ['alter table public.sessions rename to auth_tokens;', 'table or view'],
    [
      "insert into storage.buckets (id, name, public) values ('auth-tokens', 'auth-tokens', false);",
      'bucket',
    ],
    ["create policy p on storage.objects using (bucket_id = 'author-verify');", 'bucket'],
    [
      "create policy p on storage.objects using (bucket_id in ('a', 'oauth-token-files'));",
      'bucket',
    ],
  ])('reports %s', (sql, what) => {
    const found = caught(namesOf(sql));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.startsWith(what))).toBe(true);
  });

  it('reports an Edge Function whose name holds both words', () => {
    const names = emptyNames();
    names.edgeFunctions.add('verify-auth');
    expect(caught(names)).toEqual(['Edge Function verify-auth: /functions/v1/verify-auth']);
  });

  it.each([
    ['create or replace function public.register_push_token() returns void'],
    ['create or replace function public.auth_user_exists_by_email(p text) returns boolean'],
    ['create table public.push_tokens (id uuid)'],
    ["insert into storage.buckets (id, name, public) values ('item-images', 'item-images', true);"],
    ['-- a word in a comment: verify, then a sentence about tokens'],
  ])('passes %s', (sql) => {
    expect(caught(namesOf(sql))).toEqual([]);
  });

  it('reads names in double quotes and after a schema', () => {
    const names = namesOf(
      'create or replace function "public"."Mixed_Name"() returns void; create table "x"."Some Table" (id int);',
    );
    expect([...names.functions]).toEqual(['Mixed_Name']);
    expect([...names.relations]).toEqual(['Some Table']);
  });
});
