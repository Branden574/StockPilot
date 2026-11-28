/**
 * ONE LIST, ONE SET OF RULES, TWO ENGINES: core here, the database in migration
 * 0481. This file reads the database's side as text and holds core to it:
 *   - the question list between the vendor-risk-questions markers of the
 *     migration (_supplier_risk_questions) against VENDOR_RISK_QUESTIONS;
 *   - the case table, the default-date table and the answer-problem table
 *     between their markers in supabase/tests/0481_supplier_risk_reviews.test.sql,
 *     which the pgTAP file runs against the database's rules, run here against
 *     core's;
 *   - the text rule's characters, the limits, the thresholds and the refusal
 *     words, read from the migration;
 *   - the rollback note at the end of the migration: one transaction with a
 *     short lock wait, a drop for every object it makes.
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
  VENDOR_RISK_ADEQUATE_MAX_GAPS,
  VENDOR_RISK_ANSWER_PROBLEMS,
  VENDOR_RISK_CONDITIONS_MAX_GAPS,
  VENDOR_RISK_EVIDENCE_LEVELS,
  VENDOR_RISK_FINDING_MAX,
  VENDOR_RISK_HIDDEN_CHARACTERS,
  VENDOR_RISK_ITEM_STATUSES,
  VENDOR_RISK_MAX_YEARS_AHEAD,
  VENDOR_RISK_NEXT_REVIEW_MONTHS,
  VENDOR_RISK_NOTE_MAX,
  VENDOR_RISK_OVERRIDE_REASON_MAX,
  VENDOR_RISK_OVERRIDE_REASON_MIN,
  VENDOR_RISK_OVERRIDE_REASON_MIN_DIFFERENT,
  VENDOR_RISK_RESULTS,
  VENDOR_RISK_RISK_LEVELS,
  VENDOR_RISK_SPACE_CHARACTERS,
  vendorRiskAnswersProblem,
  vendorRiskDefaultNextReview,
  type VendorRiskAnswers,
} from './rules';
import {
  VENDOR_RISK_ACT_AS_REFUSAL,
  VENDOR_RISK_ACT_AS_REFUSAL_WORDS,
  VENDOR_RISK_REFUSAL_WORDS,
} from './words';

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

/**
 * As pg_temp.answers in the pgTAP file: every asked question Yes, then the
 * overrides ('missing' leaves one out; "@YYYY-MM-DD" adds the date beside an
 * answer, a bare "@" gives none). A Yes to a question whose date is judged
 * (the security report, insurance) given without "@" has the date `datedOn`
 * beside it, when there is one.
 */
function answersFor(
  level: VendorRiskDataLevel,
  over: Record<string, string>,
  datedOn: string | null,
): VendorRiskAnswers {
  const out: Record<string, { answer: string; date?: string }> = {};
  const all: Record<string, string> = {};
  for (const q of vendorRiskQuestionsFor(level)) all[q.key] = 'yes';
  Object.assign(all, over);
  for (const [k, v] of Object.entries(all)) {
    if (v === 'missing') continue;
    const at = v.indexOf('@');
    const judged = Boolean(VENDOR_RISK_QUESTIONS.find((q) => q.key === k)?.date?.maxAgeMonths);
    if (at >= 0) {
      const date = v.slice(at + 1);
      out[k] = date === '' ? { answer: v.slice(0, at) } : { answer: v.slice(0, at), date };
    } else if (v === 'yes' && judged && datedOn !== null) {
      out[k] = { answer: v, date: datedOn };
    } else {
      out[k] = { answer: v };
    }
  }
  return out as VendorRiskAnswers;
}

/** Code point ranges from a character class written with \uXXXX, \UXXXXXXXX or \u{X...} escapes only. */
function classRanges(cls: string): Array<[number, number]> {
  expect(cls.startsWith('[') && cls.endsWith(']'), cls).toBe(true);
  const body = cls.slice(1, -1);
  const one = /\\u\{([0-9A-Fa-f]+)\}|\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/y;
  const read = (): number => {
    one.lastIndex = pos;
    const m = one.exec(body);
    expect(m, `an escape the parity test cannot read at ${pos} of ${body}`).not.toBeNull();
    pos = one.lastIndex;
    return parseInt(m![1] ?? m![2] ?? m![3]!, 16);
  };
  const out: Array<[number, number]> = [];
  let pos = 0;
  while (pos < body.length) {
    const lo = read();
    if (body[pos] === '-') {
      pos += 1;
      out.push([lo, read()]);
    } else {
      out.push([lo, lo]);
    }
  }
  return out;
}

/** The one quoted character class a migration function returns. */
function sqlClass(name: string): string {
  const m = /select '(\[[^']+\])'::text;/.exec(sqlFunction(name));
  expect(m, name).not.toBeNull();
  return m![1]!;
}

describe('the question list is the database list', () => {
  const ROW =
    /^\s*\('([a-z_]+)',\s*'([a-z]+)',\s*(\d+),\s*(true|false),\s*(null|\d+),\s*(true|false),\s*(true|false),\s*(null|'[a-z_]+'),\s*(null|'[a-z]+'),\s*'([a-z]+)'\),?$/;
  const sqlRows = rows(
    block(MIGRATION, '-- vendor-risk-questions:begin', '-- vendor-risk-questions:end'),
    ROW,
  );

  it('has the same fourteen questions, in order, with the same group, date and its age limit, level, key paper, hard stop and severities', () => {
    expect(sqlRows).toHaveLength(VENDOR_RISK_QUESTIONS.length);
    const unq = (s: string) => (s === 'null' ? null : s.slice(1, -1));
    const fromSql = sqlRows.map((m) => ({
      key: m[1],
      group: m[2],
      ord: Number(m[3]),
      hasDate: m[4] === 'true',
      maxAgeMonths: m[5] === 'null' ? null : Number(m[5]),
      studentOnly: m[6] === 'true',
      keyEvidence: m[7] === 'true',
      hardStop: unq(m[8]!),
      severityStaff: unq(m[9]!),
      severityStudent: m[10],
    }));
    const fromCore = VENDOR_RISK_QUESTIONS.map((q, i) => ({
      key: q.key,
      group: q.group,
      ord: i + 1,
      hasDate: q.date !== null,
      maxAgeMonths: q.date?.maxAgeMonths ?? null,
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
    /^\s*\((\d+), '([a-z]+)', '(\{.*\})', '([a-z_]+)', '([a-z_]+)', '([a-z_]+)', '([a-z_,]*)', '([a-z_,]*)', '([a-z_]+)'\)[,;]$/;
  const lines = block(PGTAP, '-- VENDOR RISK CASES BEGIN', '-- VENDOR RISK CASES END');
  const cases = rows(lines, ROW);
  const DAY = /^-- reviewed on (\d{4}-\d{2}-\d{2})$/;
  const reviewedOn = lines.map((l) => DAY.exec(l.trim())?.[1]).find(Boolean);

  it('reads the 58 rows the pgTAP file counts, and the review day both engines judge them on', () => {
    expect(cases.map((m) => Number(m[1]))).toEqual(Array.from({ length: 58 }, (_, i) => i + 1));
    expect(PGTAP).toContain('(select count(*)::int from vr_cases), 58,');
    expect(reviewedOn).toBe('2026-06-30');
    expect(PGTAP).toContain(`pg_temp.answers(c.level, c.answers, null), date '${reviewedOn}')`);
  });

  it.each(cases.map((m) => [Number(m[1]), m] as const))('case %i', (_n, m) => {
    const level = m[2] as VendorRiskDataLevel;
    const e = evaluateVendorRisk(
      level,
      answersFor(level, JSON.parse(m[3]!) as Record<string, string>, null),
      { reviewedOn },
    );
    expect({
      startingRisk: e.startingRisk,
      evidence: e.evidence,
      residualRisk: e.residualRisk,
      hardStops: e.hardStops.join(','),
      outOfDate: e.outOfDate.join(','),
      result: e.result,
    }).toEqual({
      startingRisk: m[4],
      evidence: m[5],
      residualRisk: m[6],
      hardStops: m[7],
      outOfDate: m[8],
      result: m[9],
    });
  });

  it('covers every hard stop, every result, every evidence level, every risk level and each date judged', () => {
    const seen = cases.map((m) => ({
      stops: m[7]!.split(',').filter(Boolean),
      stale: m[8]!.split(',').filter(Boolean),
      evidence: m[5],
      residual: m[6],
      result: m[9],
    }));
    expect(new Set(seen.flatMap((s) => s.stale))).toEqual(
      new Set(VENDOR_RISK_QUESTIONS.filter((q) => q.date?.maxAgeMonths).map((q) => q.key)),
    );
    expect(new Set(seen.flatMap((s) => s.stops))).toEqual(
      new Set(VENDOR_RISK_QUESTIONS.filter((q) => q.hardStop).map((q) => q.hardStop)),
    );
    expect(new Set(seen.map((s) => s.result))).toEqual(new Set(VENDOR_RISK_RESULTS));
    expect(new Set(seen.map((s) => s.evidence))).toEqual(new Set(VENDOR_RISK_EVIDENCE_LEVELS));
    expect(new Set(seen.map((s) => s.residual))).toEqual(new Set(VENDOR_RISK_RISK_LEVELS));
  });
});

describe('the dated cases give the same answers from core (R2-S2)', () => {
  // (n, question, its answer and date, finished or a draft, the review day, today in UTC, what it counts as or
  // the refusal). Every other question Yes, the other judged date the review day.
  const ROW =
    /^\s*\((\d+), '([a-z_]+)', '([a-z_]+@?(?:\d{4}-\d{2}-\d{2})?)', (true|false), '(\d{4}-\d{2}-\d{2})', '(\d{4}-\d{2}-\d{2})', '([a-z_]+)'\)[,;]$/;
  const dated = rows(
    block(PGTAP, '-- VENDOR RISK DATED CASES BEGIN', '-- VENDOR RISK DATED CASES END'),
    ROW,
  );

  function got(m: RegExpExecArray): string {
    const key = m[2]!;
    const a = answersFor('staff', { [key]: m[3]! }, m[5]!);
    const problem = vendorRiskAnswersProblem('staff', a, m[4] === 'true', { utcToday: m[6]! });
    if (problem) return problem;
    const e = evaluateVendorRisk('staff', a, { reviewedOn: m[5]! });
    if (e.outOfDate.includes(key as never)) return 'out_of_date';
    if (e.gaps.includes(key as never))
      return (a as Record<string, { answer: string }>)[key]!.answer;
    return 'yes';
  }

  it('reads the rows: the day itself, a leap day, a date missing and a date in the future, on both questions', () => {
    expect(dated.map((m) => Number(m[1]))).toEqual(
      Array.from({ length: dated.length }, (_, i) => i + 1),
    );
    expect(dated.length).toBeGreaterThanOrEqual(25);
    expect(PGTAP).toContain(`(select count(*)::int from vr_dated), ${dated.length},`);
    const want = new Set(dated.map((m) => m[7]));
    for (const w of [
      'yes',
      'out_of_date',
      'no',
      'not_shown',
      'answer_date_missing',
      'answer_date_in_future',
    ])
      expect(want.has(w), w).toBe(true);
    expect(new Set(dated.map((m) => m[2]))).toEqual(
      new Set(['security_report', 'insurance', 'data_agreement']),
    );
    expect(dated.some((m) => m[5] === '2028-02-29' || m[3]!.endsWith('2028-02-29'))).toBe(true);
    expect(dated.some((m) => m[3]!.slice(m[3]!.indexOf('@') + 1) === m[5])).toBe(true);
  });

  it.each(dated.map((m) => [Number(m[1]), m] as const))('dated case %i', (_n, m) => {
    expect(got(m)).toBe(m[7]);
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
  // (n, level, answers, final, today in UTC or null, the word or null)
  const ROW =
    /^\s*\((\d+), '([a-z]+)', (null|'.*'), (true|false), (null|'\d{4}-\d{2}-\d{2}'), (null|'[a-z_]+')\)[,;]$/;
  const problems = rows(
    block(PGTAP, '-- VENDOR RISK ANSWER PROBLEMS BEGIN', '-- VENDOR RISK ANSWER PROBLEMS END'),
    ROW,
  );

  it('reads the rows, and they name every word', () => {
    expect(problems.length).toBeGreaterThanOrEqual(49);
    expect(
      new Set(
        problems
          .map((m) => m[6])
          .filter((w) => w !== 'null')
          .map((w) => w!.slice(1, -1)),
      ),
    ).toEqual(new Set(VENDOR_RISK_ANSWER_PROBLEMS));
  });

  it.each(problems.map((m) => [Number(m[1]), m] as const))('row %i', (_n, m) => {
    // A standard SQL string: '' is one quote, a backslash is itself (JSON then reads its escapes).
    const answers = m[3] === 'null' ? null : JSON.parse(m[3]!.slice(1, -1).replace(/''/g, "'"));
    const want = m[6] === 'null' ? null : m[6]!.slice(1, -1);
    const utcToday = m[5] === 'null' ? null : m[5]!.slice(1, -1);
    expect(vendorRiskAnswersProblem(m[2], answers, m[4] === 'true', { utcToday })).toBe(want);
  });

  it("names the database's words, and no other (bad_rules_version is the database's own guard)", () => {
    const fn = sqlFunction('_supplier_risk_answers_problem');
    const words = new Set([...fn.matchAll(/return '([a-z_]+)';/g)].map((m) => m[1]));
    words.delete('bad_rules_version');
    expect(words).toEqual(new Set(VENDOR_RISK_ANSWER_PROBLEMS));
  });
});

describe('the limits and words are the database ones', () => {
  it('forbids the same hidden characters and takes the same spaces: one list each, the same ranges', () => {
    expect(classRanges(sqlClass('_supplier_risk_hidden_chars'))).toEqual(
      VENDOR_RISK_HIDDEN_CHARACTERS.map(([lo, hi]) => [lo, hi]),
    );
    expect(classRanges(sqlClass('_supplier_risk_space_chars'))).toEqual(
      VENDOR_RISK_SPACE_CHARACTERS.map(([lo, hi]) => [lo, hi]),
    );
    // The pgTAP file checks the database's two classes against every code point of these same rows.
    const ROW = /^\s*\('(hidden|space)', '([0-9A-F]{4,6})', '([0-9A-F]{4,6})'\)[,;]$/;
    const listed = rows(
      block(PGTAP, '-- VENDOR RISK CHARACTERS BEGIN', '-- VENDOR RISK CHARACTERS END'),
      ROW,
    );
    for (const [kind, list] of [
      ['hidden', VENDOR_RISK_HIDDEN_CHARACTERS],
      ['space', VENDOR_RISK_SPACE_CHARACTERS],
    ] as const) {
      expect(
        listed.filter((m) => m[1] === kind).map((m) => [parseInt(m[2]!, 16), parseInt(m[3]!, 16)]),
        kind,
      ).toEqual(list.map(([lo, hi]) => [lo, hi]));
    }
    // The text rule and the names use the two classes, and only them.
    const textOk = sqlFunction('_supplier_risk_text_ok');
    expect(textOk).toContain('p_text !~ public._supplier_risk_hidden_chars()');
    expect(textOk).toContain(
      "pg_catalog.regexp_replace(p_text, public._supplier_risk_space_chars(), '', 'g') <> ''",
    );
    expect(sqlFunction('_supplier_risk_plain_name')).toContain(
      'public._supplier_risk_hidden_chars()',
    );
    expect(MIGRATION.match(/'\[\\u0001/g)).toHaveLength(1);
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
    // At least 20 once each run of spaces is one space and the ends are trimmed.
    expect(reason).toContain(
      "pg_catalog.char_length(pg_catalog.btrim(pg_catalog.regexp_replace(p_text, public._supplier_risk_space_chars() || '+', ' ', 'g'), ' '))" +
        ` >= ${VENDOR_RISK_OVERRIDE_REASON_MIN}`,
    );
    // At least five different characters that are not spaces.
    expect(reason).toContain(
      `where c !~ public._supplier_risk_space_chars()) >= ${VENDOR_RISK_OVERRIDE_REASON_MIN_DIFFERENT};`,
    );
    expect(RULES_SRC).toMatch(/\.size >=\s+VENDOR_RISK_OVERRIDE_REASON_MIN_DIFFERENT/);
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

  it('judges the dates beside the answers on the same today: UTC, one day of tolerance, every save and the table', () => {
    const problem = sqlFunction('_supplier_risk_answers_problem');
    expect(problem).toContain(
      'if v_q.date_max_months is not null and p_utc_today is not null and v_d > p_utc_today + 1 then',
    );
    expect(problem).toContain("return 'answer_date_in_future';");
    expect(problem).toContain("return 'answer_date_missing';");
    expect(RULES_SRC).toContain('addVendorRiskDays(utcToday, 1)');
    const utcToday = "(pg_catalog.now() at time zone 'UTC')::date";
    expect(sqlFunction('supplier_risk_draft_save')).toContain(
      `_supplier_risk_answers_problem(1::smallint, p_data_level, p_answers, false, ${utcToday})`,
    );
    expect(sqlFunction('supplier_risk_finalise')).toContain(
      `_supplier_risk_answers_problem(1::smallint, p_data_level, p_answers, true, ${utcToday})`,
    );
    expect(MIGRATION).toContain(
      "check (public._supplier_risk_answers_problem(rules_version, data_level, answers, status = 'final',\n" +
        "                                                 (reviewed_at at time zone 'UTC')::date) is null)",
    );
  });

  it('holds every name the tables keep to the text rule, as the notes, findings and actions', () => {
    for (const [col, max] of [
      ['supplier_name', 300],
      ['reviewer_name', 200],
      ['changed_by_name', 200],
    ] as const) {
      expect(MIGRATION).toContain(`check (public._supplier_risk_text_ok(${col}, 1, ${max}))`);
    }
    expect(MIGRATION).toContain(
      'check (owner_name is null or public._supplier_risk_text_ok(owner_name, 1, 200))',
    );
    expect(MIGRATION).toContain(
      'and (accepted_by_name is null or public._supplier_risk_text_ok(accepted_by_name, 1, 200))',
    );
    expect(MIGRATION).not.toMatch(/char_length\([a-z_]*name\)/);
  });

  it('holds the evidence and result thresholds to the same numbers', () => {
    const evaluate = sqlFunction('_supplier_risk_evaluate');
    expect(evaluate).toContain(
      `pg_catalog.cardinality(v_gaps) > ${VENDOR_RISK_ADEQUATE_MAX_GAPS} then`,
    );
    expect(evaluate).toContain(
      `or pg_catalog.cardinality(v_gaps) > ${VENDOR_RISK_CONDITIONS_MAX_GAPS} then`,
    );
    expect(evaluate).toContain(
      'v_d < (p_review_on - pg_catalog.make_interval(months => v_q.date_max_months))::date',
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

  it("names the support seat's refusal as the four writes raise it", () => {
    const raised = [
      ...MIGRATION.matchAll(
        /raise exception '([a-z_]+)' using errcode = '42501', hint = '([a-z_]+)';/g,
      ),
    ]
      .map((m): [string, string] => [m[1]!, m[2]!])
      .filter(([code]) => code.includes('act_as'));
    expect(raised).toEqual(Array(4).fill([VENDOR_RISK_ACT_AS_REFUSAL, VENDOR_RISK_ACT_AS_REFUSAL]));
    expect(VENDOR_RISK_ACT_AS_REFUSAL_WORDS.length).toBeGreaterThan(20);
  });
});

describe('the rollback note', () => {
  const lines = MIGRATION.split('\n');
  const start = lines.findIndex((l) => l.startsWith('-- ── ROLLBACK'));
  const note = lines.slice(start);
  const steps = note.filter((l) => l.startsWith('--   ')).map((l) => l.slice(5));

  it('is one transaction with a short lock wait, and says what the drops lock', () => {
    expect(start).toBeGreaterThan(0);
    expect(steps[0]).toBe('begin;');
    expect(steps[1]).toMatch(/^set local lock_timeout = '\d+ms';$/);
    expect(steps[steps.length - 1]).toBe('commit;');
    const words = note.join(' ');
    expect(words).toContain('ACCESS');
    expect(words).toContain('EXCLUSIVE');
    expect(words).toContain('public.organizations');
    expect(words).toContain('public.user_profiles');
  });

  it('drops every function and table the migration makes, and nothing else', () => {
    const made = new Set(
      [...MIGRATION.matchAll(/^create (function|table) (public\.[a-z_]+)\(?/gm)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    );
    const dropped = new Set(
      steps
        .filter((l) => l.startsWith('drop '))
        .map((l) => /^drop (function|table) if exists (public\.[a-z_]+)/.exec(l))
        .map((m) => (m ? `${m[1]} ${m[2]}` : 'unreadable')),
    );
    expect(dropped).toEqual(made);
    expect(steps.filter((l) => l.startsWith('drop ')).length).toBe(made.size);
  });
});
