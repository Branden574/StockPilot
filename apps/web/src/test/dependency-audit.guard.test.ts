/**
 * Security invariant: the dependency audit of the weekly Security Scan
 * (.github/workflows/security-scan.yml, job "Dependency audit").
 *
 * WHAT WAS WRONG. CI had no dependency audit. The Security Scan ran Semgrep
 * and TruffleHog only, and a vulnerable dependency reached us only as a
 * Dependabot alert, which fails nothing. On 2026-10-24 `pnpm audit --prod`
 * listed four critical advisories (Next.js twice, dompurify, shell-quote) and
 * no check said so.
 *
 * WHAT THIS PINS. scripts/dependency-audit/report.mjs decides the job from
 * the `pnpm audit --json` output:
 *   - a critical advisory fails the job unless allow-list.json dismisses it
 *     by its advisory id AND package, with a reason and a review date that
 *     has not passed; high ones are reported and never fail it;
 *   - it fails closed: an audit the registry did not answer, unreadable
 *     output, or an allow-list entry missing any field fails the job with
 *     the reason (exit 2) instead of passing with nothing checked;
 *   - registry text cannot break the report's table or form a command the
 *     Actions runner reads from a log line;
 * and the job itself holds nothing to leak and runs no package code: read-only
 * permissions, a checkout that does not keep its token, no `secrets.*` and no
 * `${{ }}` expression at all, no install, and the log copy printed with
 * workflow commands switched off behind a marker that is random per run.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = 'scripts/dependency-audit/report.mjs';
const ALLOW_LIST = 'scripts/dependency-audit/allow-list.json';
const WORKFLOW = '.github/workflows/security-scan.yml';

interface Advisory {
  id: string;
  package: string;
  severity: string;
  title: unknown;
  vulnerable: unknown;
  patched: unknown;
  versions: string[];
  paths: string[];
}

interface AllowEntry {
  advisory: string;
  package: string;
  reason: string;
  reviewBy: string;
  alert: string | null;
}

interface Row extends Advisory {
  entry: AllowEntry | null;
  dismissed: boolean;
  expired: boolean;
}

interface Result {
  rows: Row[];
  failing: Row[];
  unused: AllowEntry[];
  counts: Record<string, number>;
  passed: boolean;
}

interface ReportLib {
  AuditInputError: new (message: string) => Error;
  oneLine: (value: unknown, max?: number) => string;
  parseAudit: (text: string) => Advisory[];
  parseAllowlist: (text: string) => AllowEntry[];
  evaluate: (advisories: Advisory[], allowlist: AllowEntry[], today: string) => Result;
  renderReport: (result: Result) => string;
  main: (
    argv: string[],
    io?: { readFile?: (p: string) => string; out?: (s: string) => void; now?: Date },
  ) => number;
}

let lib: ReportLib;

beforeAll(async () => {
  lib = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, SCRIPT)).href)) as ReportLib;
});

// -- fixtures: the shape `pnpm audit --json` prints (pnpm 9) ----------------

interface RawAdvisory {
  id: number;
  module_name?: unknown;
  severity?: unknown;
  github_advisory_id?: unknown;
  title?: unknown;
  vulnerable_versions?: unknown;
  patched_versions?: unknown;
  findings?: unknown;
}

function raw(over: Partial<RawAdvisory> & { id: number }): RawAdvisory {
  return {
    module_name: 'left-pad',
    severity: 'critical',
    github_advisory_id: 'GHSA-2222-3333-4444',
    title: 'left-pad: something bad',
    vulnerable_versions: '<1.3.0',
    patched_versions: '>=1.3.0',
    findings: [{ version: '1.2.0', paths: ['apps/web > left-pad@1.2.0'] }],
    ...over,
  };
}

function auditJson(...advisories: RawAdvisory[]): string {
  return JSON.stringify({
    actions: [],
    advisories: Object.fromEntries(advisories.map((a) => [String(a.id), a])),
    muted: [],
    metadata: { vulnerabilities: {}, dependencies: 1, totalDependencies: 1 },
  });
}

function allowJson(...entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ dismissed: entries });
}

const ENTRY = {
  advisory: 'GHSA-2222-3333-4444',
  package: 'left-pad',
  reason: 'No fixed release exists and the package runs only at build time.',
  reviewBy: '2026-12-31',
};

const TODAY = '2026-10-24';

/** main() over in-memory files; returns the exit code and what it printed. */
function run(
  files: Record<string, string>,
  argv = ['audit.json', 'allow.json'],
  now = new Date(`${TODAY}T12:00:00Z`),
) {
  let printed = '';
  const code = lib.main(argv, {
    readFile: (p) => {
      const key = path.basename(p);
      if (!(key in files)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return files[key]!;
    },
    out: (s) => {
      printed += s;
    },
    now,
  });
  return { code, printed };
}

// -- parseAudit --------------------------------------------------------------

describe('parseAudit reads the pnpm report', () => {
  it('takes the advisory id, package, severity, ranges, installed versions and paths', () => {
    const [a] = lib.parseAudit(
      auditJson(
        raw({
          id: 7,
          findings: [
            { version: '1.2.0', paths: ['apps/web > left-pad@1.2.0'] },
            { version: '1.2.0', paths: ['apps/mobile > x > left-pad@1.2.0'] },
            { version: '1.1.0', paths: [] },
          ],
        }),
      ),
    );
    expect(a).toMatchObject({
      id: 'GHSA-2222-3333-4444',
      package: 'left-pad',
      severity: 'critical',
      vulnerable: '<1.3.0',
      patched: '>=1.3.0',
      versions: ['1.2.0', '1.1.0'],
      paths: ['apps/web > left-pad@1.2.0', 'apps/mobile > x > left-pad@1.2.0'],
    });
  });

  it('an advisory with no GitHub id keeps the registry id', () => {
    const [a] = lib.parseAudit(auditJson(raw({ id: 1234, github_advisory_id: undefined })));
    expect(a!.id).toBe('npm-1234');
  });

  // Mutation caught: treating unreadable or error output as "no advisories",
  // which passes a job that checked nothing.
  it('fails closed on output that is not a report', () => {
    const refused: Array<[string, RegExp]> = [
      ['', /no JSON report/],
      ['ERR_PNPM_AUDIT_BAD_RESPONSE The audit endpoint responded with 503', /no JSON report/],
      ['[]', /no JSON report/],
      ['null', /no JSON report/],
      [
        JSON.stringify({
          error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE', message: 'responded with 503' },
        }),
        /did not get an answer from the registry \(ERR_PNPM_AUDIT_BAD_RESPONSE\)/,
      ],
      [JSON.stringify({ metadata: {} }), /no advisories object/],
      [JSON.stringify({ advisories: [] }), /no advisories object/],
      [auditJson(raw({ id: 1, severity: 'urgent' })), /left-pad has no known severity/],
      [auditJson(raw({ id: 1, severity: undefined })), /no known severity/],
    ];
    for (const [text, reason] of refused) {
      expect(() => lib.parseAudit(text), text).toThrow(lib.AuditInputError);
      expect(() => lib.parseAudit(text), text).toThrow(reason);
    }
  });
});

// -- parseAllowlist ----------------------------------------------------------

describe('the allow-list', () => {
  it('the committed allow-list parses, and every entry names an advisory, a package, a reason and a review date', () => {
    const entries = lib.parseAllowlist(readFileSync(path.join(ROOT, ALLOW_LIST), 'utf8'));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.advisory).toMatch(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/);
      expect(e.package.length).toBeGreaterThan(0);
      expect(e.reason.length).toBeGreaterThanOrEqual(20);
      expect(e.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Dependabot #112: node-forge has no patched release.
    expect(entries.map((e) => `${e.package} ${e.advisory}`)).toContain(
      'node-forge GHSA-86w9-cpqp-85rv',
    );
  });

  // Mutation caught: a lenient parser that skips a malformed entry or
  // matches by package alone, so a typo could dismiss a real advisory.
  it('an entry missing its advisory id, package, reason or review date is refused, never skipped', () => {
    const broken: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...ENTRY, advisory: undefined }, /no GitHub advisory id/],
      [{ ...ENTRY, advisory: 'GHSA-2222-3333-444' }, /no GitHub advisory id/],
      [{ ...ENTRY, advisory: 'ghsa-2222-3333-4444' }, /no GitHub advisory id/],
      [{ ...ENTRY, advisory: 'CVE-2026-12345' }, /no GitHub advisory id/],
      [{ ...ENTRY, advisory: 'GHSA-2222-3333-4444 ' }, /no GitHub advisory id/],
      [{ ...ENTRY, package: '' }, /names no package/],
      [{ ...ENTRY, package: undefined }, /names no package/],
      [{ ...ENTRY, reason: 'no fix' }, /gives no reason/],
      [{ ...ENTRY, reason: undefined }, /gives no reason/],
      [{ ...ENTRY, reviewBy: undefined }, /no review date/],
      [{ ...ENTRY, reviewBy: 'next quarter' }, /no review date/],
      [{ ...ENTRY, reviewBy: '2027-1-24' }, /no review date/],
      [{ ...ENTRY, reviewBy: '2027-13-45' }, /no review date/],
    ];
    for (const [entry, reason] of broken) {
      expect(() => lib.parseAllowlist(allowJson(ENTRY, entry)), JSON.stringify(entry)).toThrow(
        reason,
      );
    }
    expect(() => lib.parseAllowlist('not json')).toThrow(/not valid JSON/);
    expect(() => lib.parseAllowlist('{}')).toThrow(/no "dismissed" list/);
    expect(() => lib.parseAllowlist(JSON.stringify({ dismissed: [null] }))).toThrow(
      /not an object/,
    );
  });
});

// -- evaluate ----------------------------------------------------------------

describe('the verdict', () => {
  const critical = () => lib.parseAudit(auditJson(raw({ id: 1 })));

  // Mutation caught: failing on nothing, or on high as well.
  it('a critical advisory fails; high and lower never do, and only high and critical are listed', () => {
    const advisories = lib.parseAudit(
      auditJson(
        raw({ id: 1 }),
        raw({
          id: 2,
          module_name: 'b',
          severity: 'high',
          github_advisory_id: 'GHSA-3333-4444-5555',
        }),
        raw({
          id: 3,
          module_name: 'c',
          severity: 'moderate',
          github_advisory_id: 'GHSA-4444-5555-6666',
        }),
        raw({
          id: 4,
          module_name: 'd',
          severity: 'low',
          github_advisory_id: 'GHSA-5555-6666-7777',
        }),
      ),
    );
    const result = lib.evaluate(advisories, [], TODAY);
    expect(result.passed).toBe(false);
    expect(result.failing.map((r) => r.package)).toEqual(['left-pad']);
    expect(result.rows.map((r) => `${r.severity} ${r.package}`)).toEqual([
      'critical left-pad',
      'high b',
    ]);
    expect(result.counts).toMatchObject({ critical: 1, high: 1, moderate: 1, low: 1 });

    const highOnly = lib.evaluate(advisories.slice(1), [], TODAY);
    expect(highOnly.passed).toBe(true);
  });

  it('a critical advisory the allow-list dismisses passes, up to and including its review date', () => {
    const allow = lib.parseAllowlist(allowJson(ENTRY));
    for (const today of ['2026-10-24', '2026-12-31']) {
      const result = lib.evaluate(critical(), allow, today);
      expect(result.passed, today).toBe(true);
      expect(result.rows[0]).toMatchObject({ dismissed: true, expired: false });
    }
  });

  // Mutation caught: an allow-list entry that dismisses forever.
  it('after the review date the entry dismisses nothing', () => {
    const result = lib.evaluate(critical(), lib.parseAllowlist(allowJson(ENTRY)), '2027-01-01');
    expect(result.passed).toBe(false);
    expect(result.rows[0]).toMatchObject({ dismissed: false, expired: true });
    expect(lib.renderReport(result)).toContain(
      'allow-list review date 2026-12-31 has passed: review it',
    );
  });

  // Mutation caught: matching on the advisory id alone (or the package
  // alone), so an entry written for one package hides another.
  it('an entry dismisses only its own advisory in its own package', () => {
    const otherPackage = lib.parseAllowlist(allowJson({ ...ENTRY, package: 'right-pad' }));
    expect(lib.evaluate(critical(), otherPackage, TODAY).passed).toBe(false);
    const otherAdvisory = lib.parseAllowlist(
      allowJson({ ...ENTRY, advisory: 'GHSA-3333-4444-5555' }),
    );
    expect(lib.evaluate(critical(), otherAdvisory, TODAY).passed).toBe(false);
  });

  it('an entry that matches no advisory any more is reported for removal', () => {
    const result = lib.evaluate([], lib.parseAllowlist(allowJson(ENTRY)), TODAY);
    expect(result.passed).toBe(true);
    expect(result.unused.map((e) => e.advisory)).toEqual(['GHSA-2222-3333-4444']);
    expect(lib.renderReport(result)).toContain(
      'Allow-list entry GHSA-2222-3333-4444 (left-pad) matches no advisory any more: remove it.',
    );
  });
});

// -- main: the exit code the job ends with -----------------------------------

describe('main decides the job', () => {
  it('0 with no critical advisory, 1 with one the allow-list does not dismiss', () => {
    const clean = run({ 'audit.json': auditJson(), 'allow.json': allowJson() });
    expect(clean.code).toBe(0);
    expect(clean.printed).toContain('Result: passed. No critical advisory.');

    const failing = run({ 'audit.json': auditJson(raw({ id: 1 })), 'allow.json': allowJson() });
    expect(failing.code).toBe(1);
    expect(failing.printed).toContain(
      'Result: FAILED. 1 critical advisory is not dismissed: left-pad GHSA-2222-3333-4444.',
    );
    expect(failing.printed).toContain(
      '| critical | left-pad | GHSA-2222-3333-4444 left-pad: something bad |',
    );
    expect(failing.printed).toContain('FAILS the scan');

    const dismissed = run({
      'audit.json': auditJson(raw({ id: 1 })),
      'allow.json': allowJson(ENTRY),
    });
    expect(dismissed.code).toBe(0);
    expect(dismissed.printed).toContain('Every critical advisory is dismissed on the allow-list.');
  });

  // Mutation caught: exiting 0 when an input could not be read.
  it('2, with the reason, when the audit or the allow-list cannot be read', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ 'audit.json': '', 'allow.json': allowJson() }, /no JSON report/],
      [
        {
          'audit.json': JSON.stringify({ error: { code: 'ENOTFOUND' } }),
          'allow.json': allowJson(),
        },
        /did not get an answer from the registry \(ENOTFOUND\)/,
      ],
      [{ 'audit.json': auditJson(), 'allow.json': '{' }, /not valid JSON/],
      [
        { 'audit.json': auditJson(), 'allow.json': allowJson({ ...ENTRY, reason: '' }) },
        /gives no reason/,
      ],
      [{ 'allow.json': allowJson() }, /could not read the input \(ENOENT\)/],
      [{ 'audit.json': auditJson() }, /could not read the input \(ENOENT\)/],
    ];
    for (const [files, reason] of cases) {
      const { code, printed } = run(files);
      expect(code, JSON.stringify(files)).toBe(2);
      expect(printed).toContain('Result: FAILED. The audit was not checked:');
      expect(printed).toMatch(reason);
    }
    expect(run({}, []).code).toBe(2);
  });

  it('with no allow-list argument it reads the committed allow-list next to the script', () => {
    const read: string[] = [];
    const code = lib.main(['audit.json'], {
      readFile: (p) => {
        read.push(p);
        return p === 'audit.json' ? auditJson() : readFileSync(p, 'utf8');
      },
      out: () => {},
    });
    expect(code).toBe(0);
    expect(read[1]).toBe(path.join(ROOT, ALLOW_LIST));
  });
});

// -- registry text cannot steer the runner or break the table ---------------

describe('registry text in the report', () => {
  const LS = String.fromCharCode(0x2028);
  const NEL = String.fromCharCode(0x85);
  const NUL = String.fromCharCode(0);

  const hostile = raw({
    id: 9,
    module_name: 'evil|pkg',
    title: `bad\n::add-mask::x\r::error::y ##[set-output name=a;]b | col${LS}::warning::z`,
    vulnerable_versions: `<1.0.0${NEL}::debug::w`,
    patched_versions: `>=1.0.0\\|${NUL}`,
    findings: [{ version: '0.1.0\n::notice::v', paths: ['apps/web > evil\n::group::g'] }],
  });

  function report(): string {
    return run({ 'audit.json': auditJson(hostile), 'allow.json': allowJson() }).printed;
  }

  // Mutation caught: printing registry values as they come, which lets a
  // line break start a "::command::" line.
  it('no line the runner reads can start a workflow command, in either form', () => {
    const out = report();
    for (const line of out.split('\n')) {
      expect(line.trimStart().startsWith('::'), line).toBe(false);
      expect(line.trimStart().startsWith('##['), line).toBe(false);
    }
    expect(out).not.toContain('##[');
    // Only line feeds separate lines; no other control or line-separator
    // character survives.
    expect(
      [...out].filter(
        (ch) => ch !== '\n' && (ch < ' ' || (ch >= '\x7f' && ch <= '\x9f') || ch === LS),
      ),
    ).toEqual([]);
  });

  it('every table row keeps its seven columns', () => {
    const rows = report()
      .split('\n')
      .filter((line) => line.startsWith('| '));
    expect(rows.length).toBe(3); // header, divider, the one advisory
    for (const row of rows) {
      // Unescaped pipes only: "\|" is a pipe inside a cell.
      const pipes = row.replace(/\\\\/g, '').match(/(?<!\\)\|/g) ?? [];
      expect(pipes.length, row).toBe(8);
    }
  });

  it('oneLine keeps one line, breaks up "##[", and cuts long text between characters', () => {
    expect(lib.oneLine('a\r\nb\tc')).toBe('a b c');
    expect(lib.oneLine('x ##[set-env name=A;]B')).toBe('x # #[set-env name=A;]B');
    expect(lib.oneLine(42)).toBe('');
    const cut = lib.oneLine(`${'x'.repeat(8)}${String.fromCodePoint(0x1f600)}${'y'.repeat(8)}`, 12);
    expect(Array.from(cut)).toHaveLength(12);
    expect(cut.endsWith('...')).toBe(true);
    expect(
      cut.includes(String.fromCharCode(0xd83d)) && !cut.includes(String.fromCodePoint(0x1f600)),
    ).toBe(false);
  });
});

// -- the workflow job --------------------------------------------------------

describe('the Security Scan job', () => {
  const workflow = readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
  const start = workflow.indexOf('\n  dependency-audit:\n');
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  const job = next === -1 ? rest : rest.slice(0, next + 1);
  // The job without its comment lines (YAML and shell), which talk about
  // secrets and installs without having any.
  const code = job
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('exists, and runs weekly and by hand as well as on pushes and pull requests', () => {
    expect(start).toBeGreaterThan(-1);
    expect(job).toContain('name: Dependency audit');
    expect(workflow).toMatch(/\n {2}schedule:\n\s+(?:#.*\n\s+)*- cron: '0 7 \* \* 1'/);
    expect(workflow).toMatch(/\n {2}workflow_dispatch:/);
    expect(workflow).toMatch(/\n {2}pull_request:\n {4}branches: \[main\]/);
  });

  // Mutation caught: a job given a secret, an expression that could carry
  // one (or untrusted event text), a persisted checkout token, or an install
  // step that runs package scripts.
  it('holds nothing to leak and runs no package code', () => {
    expect(job).toMatch(/\n {4}permissions:\n {6}contents: read\n/);
    expect(job).toMatch(
      /- uses: actions\/checkout@v\d+\n {8}with:\n {10}persist-credentials: false\n/,
    );
    expect(code).not.toMatch(/secrets\./);
    expect(code).not.toContain('${{');
    expect(code).not.toMatch(/\b(?:pnpm|npm|yarn)\s+(?:install|i|ci|add)\b/);
    expect(code).not.toMatch(/\bpnpm\s+(?:exec|run|dlx)\b|\bnpx\b/);
    // The comment stripping above left the steps themselves in place.
    expect(code).toContain('pnpm audit --prod');
  });

  it('audits production dependencies from the lockfile and lets the report decide', () => {
    expect(job).toContain(
      'run: pnpm audit --prod --audit-level=high --json > pnpm-audit.json || true',
    );
    expect(job).toContain(
      'node scripts/dependency-audit/report.mjs pnpm-audit.json > dependency-audit.md',
    );
    expect(job).toMatch(/status=\$\?\n/);
    expect(job).toContain('cat dependency-audit.md >> "$GITHUB_STEP_SUMMARY"');
    expect(job.trimEnd().endsWith('exit "$status"')).toBe(true);
  });

  it('prints the log copy with workflow commands off, behind a marker that is random per run', () => {
    const marker = job.match(/(\w+)="\$\(openssl rand -hex 16\)"/);
    expect(marker).not.toBeNull();
    const name = marker![1]!;
    const stop = job.indexOf(`echo "::stop-commands::\${${name}}"`);
    const print = job.indexOf('\n          cat dependency-audit.md\n');
    const resume = job.indexOf(`echo "::\${${name}}::"`);
    expect(stop).toBeGreaterThan(-1);
    expect(print).toBeGreaterThan(stop);
    expect(resume).toBeGreaterThan(print);
  });
});
