/**
 * The census tools behind migration 0407's REVOKE block
 * (scripts/gen-explicit-grants-sql.mjs --revokes and --compare).
 *
 * 0407 (docket S9, slice 4.3) takes TRUNCATE, REFERENCES, TRIGGER and
 * MAINTAIN from anon and authenticated on every public relation. Its GENERATED
 * REVOKES block is written from a census, like 0402's GENERATED block of
 * grants. These tests pin:
 *   - which relations the block names for a census, and which it leaves out
 *     (sequences, relations only service_role holds them on, relations
 *     without them), in a fixed order whatever the census order;
 *   - that neither mode can read the other's block, and that --revokes finds
 *     its migration by name, so a renumber after a rebase keeps working;
 *   - --compare: the facts two censuses differ on, metadata aside, and its
 *     exit codes, and --revokes --check / write on a scratch file;
 *   - the committed blocks themselves: 0402's block, read back into a census,
 *     renders to itself (so the reading is exact), and that census renders
 *     0407's block byte for byte. No migration between them changes which
 *     relations anon or authenticated hold the four on; one that ever does
 *     makes the last test fail, and the block is then regenerated from a
 *     scratch database at the previous migration (--revokes --db-url).
 *
 * The database side (no holder is left after 0407, nor in the default
 * privileges) is pgTAP: security_invariants INV-42..INV-44 and
 * 0407_grants_policy_cleanup T1-T3.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/gen-explicit-grants-sql.mjs');

type Privilege = [role: string, privilege: string, grantable: boolean];
type ColumnPrivilege = [
  column: string,
  ident: string,
  role: string,
  privilege: string,
  grantable: boolean,
];
interface Relation {
  name: string;
  ident: string;
  kind: string;
  privileges: Privilege[];
  columns: ColumnPrivilege[];
}
interface Census {
  roles: string[];
  relations: Relation[];
  [meta: string]: unknown;
}
interface Gen {
  MIGRATION_PATH: string;
  BEGIN_MARKER: string;
  END_MARKER: string;
  REVOKES_BEGIN_MARKER: string;
  REVOKES_END_MARKER: string;
  renderGrantsBlock: (census: Census) => string;
  renderRevokesBlock: (census: Census) => string;
  currentBlock: (text: string, begin?: string, end?: string) => string | null;
  revokesMigrationPath: (dir?: string) => string;
  compareCensuses: (a: Census, b: Census) => { onlyA: string[]; onlyB: string[] };
}

let gen: Gen;
let tmp: string;

beforeAll(async () => {
  gen = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as Gen;
  tmp = mkdtempSync(path.join(os.tmpdir(), 'explicit-grants-revokes-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ROLES = ['anon', 'authenticated', 'service_role'];
const DDL = 'truncate, references, trigger, maintain';
const revoke = (ident: string) =>
  `revoke ${DDL} on table public.${ident} from anon, authenticated;`;
const revokeWrapped = (ident: string) => [
  `revoke ${DDL}`,
  `  on table public.${ident} from anon, authenticated;`,
];

function rel(
  name: string,
  kind: string,
  privileges: Privilege[] = [],
  columns: ColumnPrivilege[] = [],
) {
  return {
    name,
    ident: /^[a-z_][a-z0-9_]*$/u.test(name) ? name : `"${name}"`,
    kind,
    privileges,
    columns,
  };
}

/** A census with every case the block must decide. */
function sampleCensus(): Census {
  return {
    census: 'scripts/explicit-grants/census.sql',
    taken_at: '2026-10-25T00:00:00Z',
    roles: [...ROLES],
    relations: [
      rel('zeta', 'r', [
        ['anon', 'TRUNCATE', false],
        ['authenticated', 'TRUNCATE', false],
        ['authenticated', 'SELECT', false],
      ]),
      rel('alpha_view', 'v', [['authenticated', 'MAINTAIN', false]]),
      rel(
        'cols_only',
        'r',
        [['authenticated', 'SELECT', false]],
        [['note', 'note', 'anon', 'REFERENCES', false]],
      ),
      rel('Odd Name', 'r', [['authenticated', 'TRIGGER', true]]),
      rel('a_rather_long_relation_name', 'm', [['anon', 'REFERENCES', false]]),
      rel('service_only', 'r', [
        ['anon', 'SELECT', false],
        ['service_role', 'TRUNCATE', false],
        ['service_role', 'MAINTAIN', false],
      ]),
      rel('plain', 'r', [
        ['anon', 'SELECT', false],
        ['authenticated', 'SELECT', false],
        ['authenticated', 'INSERT', false],
        ['authenticated', 'UPDATE', false],
        ['authenticated', 'DELETE', false],
      ]),
      rel('counter_seq', 'S', [
        ['anon', 'USAGE', false],
        ['authenticated', 'UPDATE', false],
      ]),
      rel('nobody', 'r'),
    ],
  };
}

describe('renderRevokesBlock', () => {
  it('names each table, view or materialized view where anon or authenticated hold one of the four, table-level or column-level, and nothing else', () => {
    expect(gen.renderRevokesBlock(sampleCensus())).toBe(
      [
        gen.REVOKES_BEGIN_MARKER,
        '-- 5 relations in public on which anon or authenticated hold TRUNCATE, REFERENCES, TRIGGER or MAINTAIN;',
        '-- 6 such privileges in all, table-level and column-level.',
        revoke('"Odd Name"'),
        ...revokeWrapped('a_rather_long_relation_name'),
        revoke('alpha_view'),
        revoke('cols_only'),
        revoke('zeta'),
        gen.REVOKES_END_MARKER,
      ].join('\n'),
    );
  });

  it('gives the same block for the census in any order, and a block without statements when no client role holds one', () => {
    const census = sampleCensus();
    const reversed = { ...census, relations: [...census.relations].reverse() };
    expect(gen.renderRevokesBlock(reversed)).toBe(gen.renderRevokesBlock(census));

    const clean = {
      ...census,
      relations: census.relations.filter((r) =>
        ['plain', 'service_only', 'nobody', 'counter_seq'].includes(r.name),
      ),
    };
    expect(gen.renderRevokesBlock(clean)).toBe(
      [
        gen.REVOKES_BEGIN_MARKER,
        '-- 0 relations in public on which anon or authenticated hold TRUNCATE, REFERENCES, TRIGGER or MAINTAIN;',
        '-- 0 such privileges in all, table-level and column-level.',
        gen.REVOKES_END_MARKER,
      ].join('\n'),
    );
  });

  it('refuses a census it cannot read instead of writing a short block', () => {
    const census = sampleCensus();
    expect(() => gen.renderRevokesBlock({ ...census, roles: ['anon', 'authenticated'] })).toThrow(
      /"roles" must be/u,
    );
    const odd = sampleCensus();
    odd.relations[0]!.privileges.push(['authenticated', 'CREATE', false]);
    expect(() => gen.renderRevokesBlock(odd)).toThrow(/unexpected table privilege CREATE/u);
  });
});

describe('the two GENERATED blocks', () => {
  it('cannot be read for each other', () => {
    const grants = [gen.BEGIN_MARKER, '-- 0 relations', gen.END_MARKER].join('\n');
    const revokes = gen.renderRevokesBlock(sampleCensus());
    const both = `-- header\n${grants}\n\n${revokes}\n`;
    expect(gen.currentBlock(both)).toBe(grants);
    expect(gen.currentBlock(both, gen.REVOKES_BEGIN_MARKER, gen.REVOKES_END_MARKER)).toBe(revokes);
    expect(gen.currentBlock(`-- header\n${revokes}\n`)).toBeNull();
    expect(
      gen.currentBlock(`-- header\n${grants}\n`, gen.REVOKES_BEGIN_MARKER, gen.REVOKES_END_MARKER),
    ).toBeNull();
  });

  it('finds the revoke migration by its name, whatever its number', () => {
    expect(path.basename(gen.revokesMigrationPath())).toMatch(
      /^[0-9]{4}_grants_policy_cleanup\.sql$/u,
    );
    const none = mkdtempSync(path.join(tmp, 'none-'));
    writeFileSync(path.join(none, '0402_explicit_data_api_grants.sql'), '');
    expect(() => gen.revokesMigrationPath(none)).toThrow(/found 0/u);
    const two = mkdtempSync(path.join(tmp, 'two-'));
    writeFileSync(path.join(two, '0407_grants_policy_cleanup.sql'), '');
    writeFileSync(path.join(two, '0409_grants_policy_cleanup.sql'), '');
    expect(() => gen.revokesMigrationPath(two)).toThrow(/found 2/u);
  });
});

describe('compareCensuses and --compare', () => {
  it('ignores metadata and lists every privilege, grant option and kind only one census states', () => {
    const a = sampleCensus();
    const b = sampleCensus();
    b.taken_at = '2026-10-26T00:00:00Z';
    b.database = 'another';
    expect(gen.compareCensuses(a, b)).toEqual({ onlyA: [], onlyB: [] });

    b.relations[0]!.privileges.push(['anon', 'SELECT', false]);
    b.relations[2]!.columns.push(['note', 'note', 'authenticated', 'UPDATE', false]);
    b.relations[3]!.privileges = [['authenticated', 'TRIGGER', false]];
    b.relations[1]!.kind = 'm';
    expect(gen.compareCensuses(a, b)).toEqual({
      onlyA: [
        'authenticated holds TRIGGER with grant option on public.Odd Name',
        'public.alpha_view is a view',
      ],
      onlyB: [
        'anon holds SELECT on public.zeta',
        'authenticated holds TRIGGER on public.Odd Name',
        'authenticated holds UPDATE on column public.cols_only.note',
        'public.alpha_view is a materialized view',
      ],
    });
  });

  it('exits 0 for the same privileges and 1 with the differences listed', () => {
    const a = path.join(tmp, 'a.json');
    const b = path.join(tmp, 'b.json');
    writeFileSync(a, JSON.stringify(sampleCensus()));
    writeFileSync(b, JSON.stringify({ ...sampleCensus(), taken_at: 'later' }));
    expect(run(['--compare', a, b])).toMatchObject({ status: 0 });

    const changed = sampleCensus();
    changed.relations[4]!.privileges = [];
    writeFileSync(b, JSON.stringify(changed));
    const out = run(['--compare', a, b]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(
      `only in ${a}: anon holds REFERENCES on public.a_rather_long_relation_name`,
    );
  });
});

describe('--revokes on a scratch migration', () => {
  it('checks the block against a census, and rewrites only the block', () => {
    const census = path.join(tmp, 'census.json');
    const file = path.join(tmp, '0999_grants_policy_cleanup.sql');
    writeFileSync(census, JSON.stringify(sampleCensus()));
    const stale = [
      gen.REVOKES_BEGIN_MARKER,
      revoke('zeta'),
      revoke('gone'),
      gen.REVOKES_END_MARKER,
    ].join('\n');
    writeFileSync(file, `-- header kept\n${stale}\n-- footer kept\n`);

    const check = run(['--revokes', '--census', census, '--check', '--out', file]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(`only in the file:   ${revoke('gone')}`);
    expect(check.stderr).toContain(`only in the census: ${revoke('alpha_view')}`);
    // A wrapped statement is compared as one line.
    expect(check.stderr).toContain(
      `only in the census: revoke ${DDL} on table public.a_rather_long_relation_name from anon, authenticated;`,
    );

    expect(run(['--revokes', '--census', census, '--out', file]).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(
      `-- header kept\n${gen.renderRevokesBlock(sampleCensus())}\n-- footer kept\n`,
    );
    expect(run(['--revokes', '--census', census, '--check', '--out', file]).status).toBe(0);
  });

  it('refuses a database that is not local', () => {
    const out = run([
      '--revokes',
      '--db-url',
      'postgresql://user@db.example.invalid:5432/postgres',
      '--check',
    ]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('refusing a database that is not local');
  });
});

describe('the committed blocks', () => {
  it("0402's block reads back into a census that renders it unchanged, and that census renders 0407's block", () => {
    const grants = gen.currentBlock(readFileSync(gen.MIGRATION_PATH, 'utf8'));
    expect(grants).not.toBeNull();
    const census = readGrantsBlock(grants!);
    expect(gen.renderGrantsBlock(census)).toBe(grants);

    const revokes = gen.currentBlock(
      readFileSync(gen.revokesMigrationPath(), 'utf8'),
      gen.REVOKES_BEGIN_MARKER,
      gen.REVOKES_END_MARKER,
    );
    expect(revokes).not.toBeNull();
    expect(gen.renderRevokesBlock(census)).toBe(revokes);
    // Floors, far under today's 122: a block that silently lost its statements fails here.
    expect(revokes!.match(/^revoke /gmu)?.length ?? 0).toBeGreaterThan(100);
  });
});

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

const KIND_CODES: Record<string, string> = {
  table: 'r',
  'partitioned table': 'p',
  view: 'v',
  'materialized view': 'm',
  'foreign table': 'f',
  sequence: 'S',
};

const unquote = (ident: string) =>
  ident.startsWith('"') ? ident.slice(1, -1).replaceAll('""', '"') : ident;

/**
 * The census a GENERATED block of grants states, read from its statements
 * (relation metadata the block does not carry, such as the owner, is absent).
 */
function readGrantsBlock(block: string): Census {
  const relations: Relation[] = [];
  for (const paragraph of block.split('\n\n').slice(1)) {
    if (paragraph === gen.END_MARKER) continue;
    const [label, ...body] = paragraph.split('\n');
    const head =
      /^-- public\.(\S+) \(([a-z ]+)\)(: no privileges for anon, authenticated or service_role\.)?$/u.exec(
        label!,
      );
    if (!head) throw new Error(`unexpected paragraph: ${paragraph}`);
    const [, name, word, none] = head;
    const relation: Relation = {
      name: name!,
      ident: name!,
      kind: KIND_CODES[word!]!,
      privileges: [],
      columns: [],
    };
    if (!relation.kind) throw new Error(`unknown kind ${word}`);
    if (none && body.length > 0) throw new Error(`${name}: statements after "no privileges"`);
    for (const raw of body.join('\n').split(';')) {
      const statement = raw.replace(/\s+/gu, ' ').trim();
      if (!statement) continue;
      const m =
        /^grant (.+?) on (?:table|sequence) public\.(\S+) to ([a-z_, ]+?)( with grant option)?$/u.exec(
          statement,
        );
      if (!m) throw new Error(`unexpected statement: ${statement}`);
      const [, privs, ident, roles, option] = m;
      relation.ident = ident!;
      const grantable = Boolean(option);
      const column = /^([a-z]+) \( ?(.+?) ?\)$/u.exec(privs!);
      for (const role of roles!.split(', ')) {
        if (column) {
          for (const colIdent of column[2]!.split(/, ?/u)) {
            relation.columns.push([
              unquote(colIdent),
              colIdent,
              role,
              column[1]!.toUpperCase(),
              grantable,
            ]);
          }
        } else {
          for (const p of privs!.split(', '))
            relation.privileges.push([role, p.toUpperCase(), grantable]);
        }
      }
    }
    relations.push(relation);
  }
  return { roles: [...ROLES], relations };
}
