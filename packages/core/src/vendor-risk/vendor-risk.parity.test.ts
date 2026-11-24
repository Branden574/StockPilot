/**
 * ONE LIST, ONE SET OF RULES, TWO ENGINES: core here, the database in migration
 * 0481. This file reads the database's side as text and holds core to it:
 *   - the question list between the vendor-risk-questions markers of the
 *     migration (_supplier_risk_questions) against VENDOR_RISK_QUESTIONS;
 *   - the case table, the default-date table and the answer-problem table
 *     between their markers in supabase/tests/0481_supplier_risk_reviews.test.sql,
 *     which the pgTAP file runs against the database's rules, run here against
 *     core's;
 *   - the text rule's characters, the limits and the refusal words, read from
 *     the migration.
 * A change on one side only fails here or there.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  VENDOR_RISK_QUESTIONS,
  vendorRiskQuestionsFor,
  type VendorRiskDataLevel,
} from './questions';
import {
  evaluateVendorRisk,
  VENDOR_RISK_ACTION_MAX,
  VENDOR_RISK_ANSWER_DATE_MAX,
  VENDOR_RISK_ANSWER_DATE_MIN,
  VENDOR_RISK_ANSWER_PROBLEMS,
  VENDOR_RISK_EVIDENCE_LEVELS,
  VENDOR_RISK_FINDING_MAX,
  VENDOR_RISK_ITEM_STATUSES,
  VENDOR_RISK_MAX_YEARS_AHEAD,
  VENDOR_RISK_NEXT_REVIEW_MONTHS,
  VENDOR_RISK_NOTE_MAX,
  VENDOR_RISK_OVERRIDE_REASON_MAX,
  VENDOR_RISK_OVERRIDE_REASON_MIN,
  VENDOR_RISK_RESULTS,
  VENDOR_RISK_RISK_LEVELS,
  vendorRiskAnswersProblem,
  vendorRiskDefaultNextReview,
  type VendorRiskAnswers,
} from './rules';
import { VENDOR_RISK_REFUSAL_WORDS } from './words';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const MIGRATION = readFileSync(
  join(ROOT, 'supabase/migrations/0481_supplier_risk_reviews.sql'),
  'utf8',
);
const PGTAP = readFileSync(
  join(ROOT, 'supabase/tests/0481_supplier_risk_reviews.test.sql'),
  'utf8',
);
const RULES_SRC = readFileSync(join(HERE, 'rules.ts'), 'utf8');

/** The lines strictly between two marker lines, which must each appear once. */
function block(text: string, begin: string, end: string): string[] {
  const lines = text.split('\n');
  const b = lines.findIndex((l) => l.trim() === begin);
  const e = lines.findIndex((l) => l.trim() === end);
  expect(
    lines.filter((l) => l.trim() === begin),
    begin,
  ).toHaveLength(1);
  expect(
    lines.filter((l) => l.trim() === end),
    end,
  ).toHaveLength(1);
  expect(e).toBeGreaterThan(b);
  return lines.slice(b + 1, e);
}

/** The value rows of a block's insert: each line that starts with '(' (the insert line itself is skipped). */
function rows(lines: string[], re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  for (const line of lines) {
    if (!line.trim().startsWith('(')) continue;
    const m = re.exec(line);
    expect(m, `a row the parity test cannot read: ${line}`).not.toBeNull();
    out.push(m!);
  }
  return out;
}

/** The SQL text of one function of the migration, from its create to the closing $$. */
function sqlFunction(name: string): string {
  const start = MIGRATION.indexOf(`create function public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const body = MIGRATION.indexOf('$$', start);
  const close = MIGRATION.indexOf('$$;', body + 2);
  return MIGRATION.slice(start, close);
}

/** As pg_temp.answers in the pgTAP file: every asked question Yes, then the overrides ('missing' leaves one out). */
function answersFor(level: VendorRiskDataLevel, over: Record<string, string>): VendorRiskAnswers {
  const out: Record<string, { answer: string }> = {};
  for (const q of vendorRiskQuestionsFor(level)) out[q.key] = { answer: 'yes' };
  for (const [k, v] of Object.entries(over)) {
    if (v === 'missing') delete out[k];
    else out[k] = { answer: v };
  }
  return out as VendorRiskAnswers;
}

describe('the question list is the database list', () => {
  const ROW =
    /^\s*\('([a-z_]+)',\s*'([a-z]+)',\s*(\d+),\s*(true|false),\s*(true|false),\s*(true|false),\s*(null|'[a-z_]+'),\s*(null|'[a-z]+'),\s*'([a-z]+)'\),?$/;
  const sqlRows = rows(
    block(MIGRATION, '-- vendor-risk-questions:begin', '-- vendor-risk-questions:end'),
    ROW,
  );

  it('has the same fourteen questions, in order, with the same group, date, level, key paper, hard stop and severities', () => {
    expect(sqlRows).toHaveLength(VENDOR_RISK_QUESTIONS.length);
    const unq = (s: string) => (s === 'null' ? null : s.slice(1, -1));
    const fromSql = sqlRows.map((m) => ({
      key: m[1],
      group: m[2],
      ord: Number(m[3]),
      hasDate: m[4] === 'true',
      studentOnly: m[5] === 'true',
      keyEvidence: m[6] === 'true',
      hardStop: unq(m[7]!),
      severityStaff: unq(m[8]!),
      severityStudent: m[9],
    }));
    const fromCore = VENDOR_RISK_QUESTIONS.map((q, i) => ({
      key: q.key,
      group: q.group,
      ord: i + 1,
      hasDate: q.date !== null,
      studentOnly: q.studentDataOnly,
      keyEvidence: q.keyEvidence,
      hardStop: q.hardStop,
      severityStaff: q.severity.staff,
      severityStudent: q.severity.student,
    }));
    expect(fromSql).toEqual(fromCore);
  });
});

describe('the case table gives the same answers from core', () => {
  const ROW =
    /^\s*\((\d+), '([a-z]+)', '(\{.*\})', '([a-z_]+)', '([a-z_]+)', '([a-z_]+)', '([a-z_,]*)', '([a-z_]+)'\)[,;]$/;
  const cases = rows(block(PGTAP, '-- VENDOR RISK CASES BEGIN', '-- VENDOR RISK CASES END'), ROW);

  it('reads the 40 rows the pgTAP file counts', () => {
    expect(cases.map((m) => Number(m[1]))).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(PGTAP).toContain('(select count(*)::int from vr_cases), 40,');
  });

  it.each(cases.map((m) => [Number(m[1]), m] as const))('case %i', (_n, m) => {
    const level = m[2] as VendorRiskDataLevel;
    const e = evaluateVendorRisk(
      level,
      answersFor(level, JSON.parse(m[3]!) as Record<string, string>),
    );
    expect({
      startingRisk: e.startingRisk,
      evidence: e.evidence,
      residualRisk: e.residualRisk,
      hardStops: e.hardStops.join(','),
      result: e.result,
    }).toEqual({
      startingRisk: m[4],
      evidence: m[5],
      residualRisk: m[6],
      hardStops: m[7],
      result: m[8],
    });
  });

  it('covers every hard stop, every result, every evidence level and every risk level', () => {
    const seen = cases.map((m) => ({
      stops: m[7]!.split(',').filter(Boolean),
      evidence: m[5],
      residual: m[6],
      result: m[8],
    }));
    expect(new Set(seen.flatMap((s) => s.stops))).toEqual(
      new Set(VENDOR_RISK_QUESTIONS.filter((q) => q.hardStop).map((q) => q.hardStop)),
    );
    expect(new Set(seen.map((s) => s.result))).toEqual(new Set(VENDOR_RISK_RESULTS));
    expect(new Set(seen.map((s) => s.evidence))).toEqual(new Set(VENDOR_RISK_EVIDENCE_LEVELS));
    expect(new Set(seen.map((s) => s.residual))).toEqual(new Set(VENDOR_RISK_RISK_LEVELS));
  });
});

describe('the default next review dates are the same', () => {
  const ROW = /^\s*\((\d+), '([a-z]+)', '(\d{4}-\d{2}-\d{2})', '(\d{4}-\d{2}-\d{2})'\)[,;]$/;
  const dates = rows(block(PGTAP, '-- VENDOR RISK DATES BEGIN', '-- VENDOR RISK DATES END'), ROW);

  it('reads the date table', () => {
    expect(dates.length).toBeGreaterThanOrEqual(9);
  });

  it.each(dates.map((m) => [Number(m[1]), m] as const))('date %i', (_n, m) => {
    expect(vendorRiskDefaultNextReview(m[2] as VendorRiskDataLevel, m[3]!)).toBe(m[4]);
  });

  it('uses the months the database uses', () => {
    const fn = sqlFunction('_supplier_risk_default_next_review');
    for (const level of ['none', 'staff', 'student'] as const) {
      expect(fn).toMatch(
        new RegExp(`when '${level}' then ${VENDOR_RISK_NEXT_REVIEW_MONTHS[level]}\\b`),
      );
    }
  });
});

describe('the answer-problem table gives the same words from core', () => {
  const ROW = /^\s*\((\d+), '([a-z]+)', (null|'.*'), (true|false), (null|'[a-z_]+')\)[,;]$/;
  const problems = rows(
    block(PGTAP, '-- VENDOR RISK ANSWER PROBLEMS BEGIN', '-- VENDOR RISK ANSWER PROBLEMS END'),
    ROW,
  );

  it('reads the rows, and they name every word', () => {
    expect(problems.length).toBeGreaterThanOrEqual(35);
    expect(
      new Set(
        problems
          .map((m) => m[5])
          .filter((w) => w !== 'null')
          .map((w) => w!.slice(1, -1)),
      ),
    ).toEqual(new Set(VENDOR_RISK_ANSWER_PROBLEMS));
  });

  it.each(problems.map((m) => [Number(m[1]), m] as const))('row %i', (_n, m) => {
    // A standard SQL string: '' is one quote, a backslash is itself (JSON then reads its escapes).
    const answers = m[3] === 'null' ? null : JSON.parse(m[3]!.slice(1, -1).replace(/''/g, "'"));
    const want = m[5] === 'null' ? null : m[5]!.slice(1, -1);
    expect(vendorRiskAnswersProblem(m[2], answers, m[4] === 'true')).toBe(want);
  });

  it("names the database's words, and no other (bad_rules_version is the database's own guard)", () => {
    const fn = sqlFunction('_supplier_risk_answers_problem');
    const words = new Set([...fn.matchAll(/return '([a-z_]+)';/g)].map((m) => m[1]));
    words.delete('bad_rules_version');
    expect(words).toEqual(new Set(VENDOR_RISK_ANSWER_PROBLEMS));
  });
});

describe('the limits and words are the database ones', () => {
  it('forbids the same characters', () => {
    const core = /const FORBIDDEN_CHARS =[\s\S]*?\/(\[[^\]]+\])\/u;/.exec(RULES_SRC);
    const sql = /p_text !~ '(\[[^\]]+\])'/.exec(sqlFunction('_supplier_risk_text_ok'));
    expect(core?.[1]).toBeTruthy();
    expect(core?.[1]).toBe(sql?.[1]);
    expect(sqlFunction('_supplier_risk_text_ok')).toContain("p_text ~ '[^ \\t\\r\\n]'");
    expect(RULES_SRC).toContain('if (!/[^ \\t\\r\\n]/.test(text)) return false;');
  });

  it('holds notes, reasons, findings, actions and dates to the same numbers', () => {
    const problem = sqlFunction('_supplier_risk_answers_problem');
    expect(problem).toContain(
      `_supplier_risk_text_ok(v_val ->> 'note', 1, ${VENDOR_RISK_NOTE_MAX})`,
    );
    expect(problem).toContain(
      `v_d < date '${VENDOR_RISK_ANSWER_DATE_MIN}' or v_d > date '${VENDOR_RISK_ANSWER_DATE_MAX}'`,
    );
    const reason = sqlFunction('_supplier_risk_reason_ok');
    expect(reason).toContain(
      `_supplier_risk_text_ok(p_text, 1, ${VENDOR_RISK_OVERRIDE_REASON_MAX})`,
    );
    expect(reason).toContain(`>= ${VENDOR_RISK_OVERRIDE_REASON_MIN};`);
    expect(MIGRATION).toContain(
      `check (public._supplier_risk_text_ok(finding, 1, ${VENDOR_RISK_FINDING_MAX}))`,
    );
    expect(MIGRATION).toContain(
      `check (public._supplier_risk_text_ok(action, 1, ${VENDOR_RISK_ACTION_MAX}))`,
    );
    const finalise = sqlFunction('supplier_risk_finalise');
    expect(finalise).toContain(
      `_supplier_risk_text_ok(v_el ->> 'finding', 1, ${VENDOR_RISK_FINDING_MAX})`,
    );
    expect(finalise).toContain(
      `_supplier_risk_text_ok(v_el ->> 'action', 1, ${VENDOR_RISK_ACTION_MAX})`,
    );
    expect(finalise).toContain(`(v_today + interval '${VENDOR_RISK_MAX_YEARS_AHEAD} years')::date`);
    const itemUpdate = sqlFunction('supplier_risk_item_update');
    expect(itemUpdate).toContain(`_supplier_risk_text_ok(p_action, 1, ${VENDOR_RISK_ACTION_MAX})`);
    expect(itemUpdate).toContain(
      `(v_today + interval '${VENDOR_RISK_MAX_YEARS_AHEAD} years')::date`,
    );
  });

  it('lists the same item statuses and results', () => {
    expect(MIGRATION).toContain(
      `check (status in (${VENDOR_RISK_ITEM_STATUSES.map((s) => `'${s}'`).join(', ')}))`,
    );
    expect(MIGRATION).toContain(
      `override_result in (${VENDOR_RISK_RESULTS.map((s) => `'${s}'`).join(', ')})`,
    );
  });

  it('has words for every refusal the functions give, and for no other', () => {
    const raised = new Set(
      [
        ...MIGRATION.matchAll(
          /raise exception '([a-z_]+)' using errcode = '22023', hint = '([a-z_]+)';/g,
        ),
      ].map((m) => {
        expect(m[1]).toBe(m[2]);
        return m[1]!;
      }),
    );
    // The answer words are raised through v_problem, from _supplier_risk_answers_problem.
    expect(MIGRATION).toContain(
      "raise exception '%', v_problem using errcode = '22023', hint = v_problem;",
    );
    for (const w of VENDOR_RISK_ANSWER_PROBLEMS) raised.add(w);
    expect(new Set(Object.keys(VENDOR_RISK_REFUSAL_WORDS))).toEqual(raised);
  });
});
