import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  VENDOR_RISK_ANSWERS,
  VENDOR_RISK_DATA_LEVELS,
  VENDOR_RISK_HARD_STOPS,
  VENDOR_RISK_QUESTION_KEYS,
  VENDOR_RISK_QUESTIONS,
  vendorRiskQuestionsFor,
  type VendorRiskAnswer,
  type VendorRiskDataLevel,
  type VendorRiskQuestionKey,
} from './questions';
import {
  addVendorRiskDays,
  addVendorRiskMonths,
  evaluateVendorRisk,
  VENDOR_RISK_EVIDENCE_LEVELS,
  VENDOR_RISK_RESULTS,
  VENDOR_RISK_RISK_LEVELS,
  vendorRiskAnswersProblem,
  vendorRiskDefaultNextReview,
  vendorRiskDueDateAllowed,
  vendorRiskFollowUpEmail,
  vendorRiskFollowUps,
  vendorRiskNextReviewAllowed,
  vendorRiskOverrideReasonOk,
  vendorRiskResultInForce,
  vendorRiskReviewDue,
  vendorRiskTextOk,
  type VendorRiskAnswers,
  type VendorRiskEvaluation,
} from './rules';

/** Every question asked at the level Yes, then the overrides ('missing' leaves one unanswered). */
function answers(
  level: VendorRiskDataLevel,
  over: Partial<Record<string, VendorRiskAnswer | 'missing'>> = {},
): VendorRiskAnswers {
  const out: Record<string, { answer: VendorRiskAnswer }> = {};
  for (const q of vendorRiskQuestionsFor(level)) out[q.key] = { answer: 'yes' };
  for (const [k, v] of Object.entries(over)) {
    if (v === 'missing') delete out[k];
    else if (v) out[k] = { answer: v };
  }
  return out as VendorRiskAnswers;
}

function brief(e: VendorRiskEvaluation): string {
  return [e.startingRisk, e.evidence, e.residualRisk, e.hardStops.join(','), e.result].join(' ');
}

describe('the question list', () => {
  it('is fourteen questions in four groups, with stable keys in order', () => {
    expect(VENDOR_RISK_QUESTIONS.map((q) => q.key)).toEqual([...VENDOR_RISK_QUESTION_KEYS]);
    expect(new Set(VENDOR_RISK_QUESTION_KEYS).size).toBe(14);
    expect(VENDOR_RISK_QUESTIONS.map((q) => q.group)).toEqual([
      'holds',
      'holds',
      'holds',
      'paper',
      'paper',
      'paper',
      'paper',
      'proof',
      'proof',
      'student',
      'student',
      'student',
      'student',
      'student',
    ]);
  });

  it('asks nothing with no data of ours, nine with staff contact details, fourteen with student data', () => {
    expect(vendorRiskQuestionsFor('none')).toHaveLength(0);
    expect(vendorRiskQuestionsFor('staff').map((q) => q.key)).toEqual(
      VENDOR_RISK_QUESTION_KEYS.slice(0, 9),
    );
    expect(vendorRiskQuestionsFor('student')).toHaveLength(14);
    for (const q of VENDOR_RISK_QUESTIONS) expect(q.studentDataOnly).toBe(q.group === 'student');
  });

  it('has four hard stops, three key papers and three dates', () => {
    expect(VENDOR_RISK_QUESTIONS.filter((q) => q.hardStop).map((q) => [q.key, q.hardStop])).toEqual(
      [
        ['data_agreement', 'student_data_no_agreement'],
        ['breach_notice', 'student_data_no_breach_notice'],
        ['no_sale_or_ads', 'student_data_sale_or_ads'],
        ['no_ai_training', 'student_data_ai_training'],
      ],
    );
    expect(VENDOR_RISK_QUESTIONS.filter((q) => q.hardStop).map((q) => q.hardStop)).toEqual([
      ...VENDOR_RISK_HARD_STOPS,
    ]);
    expect(VENDOR_RISK_QUESTIONS.filter((q) => q.keyEvidence).map((q) => q.key)).toEqual([
      'data_agreement',
      'breach_notice',
      'security_report',
    ]);
    expect(VENDOR_RISK_QUESTIONS.filter((q) => q.date).map((q) => q.key)).toEqual([
      'data_agreement',
      'security_report',
      'insurance',
    ]);
  });

  it('puts every question so that Yes is the safe answer, with words for every answer that makes an item', () => {
    for (const q of VENDOR_RISK_QUESTIONS) {
      expect(q.text.endsWith('?')).toBe(true);
      expect(q.help.length).toBeGreaterThan(10);
      expect(q.finding.no).not.toBe(q.finding.not_shown);
      expect(q.action.length).toBeGreaterThan(10);
      expect(q.followUp.length).toBeGreaterThan(10);
      expect(q.severity.student).toBeTruthy();
      expect(q.severity.staff === null).toBe(q.studentDataOnly);
      if (q.hardStop) expect(q.severity.student).toBe('critical');
    }
  });
});

describe('the rules', () => {
  // Each row: level, overrides on "every asked question Yes", then
  // starting risk, evidence, risk left, hard stops, result.
  const CASES: Array<
    [
      VendorRiskDataLevel,
      Partial<Record<VendorRiskQuestionKey, VendorRiskAnswer | 'missing'>>,
      string,
    ]
  > = [
    ['none', {}, 'low not_needed low  approve'],
    ['staff', {}, 'moderate strong low  approve'],
    ['student', {}, 'high strong low  approve'],
    // One and two gaps, none a key paper: adequate, one step down.
    ['staff', { insurance: 'no' }, 'moderate adequate low  approve_with_conditions'],
    [
      'staff',
      { insurance: 'no', hosting_known: 'not_shown' },
      'moderate adequate low  approve_with_conditions',
    ],
    [
      'student',
      { direct_control: 'no', purpose_only: 'no' },
      'high adequate moderate  approve_with_conditions',
    ],
    // Three gaps: weak, the starting risk stays.
    [
      'staff',
      { insurance: 'no', hosting_known: 'not_shown', data_listed: 'no' },
      'moderate weak moderate  approve_with_conditions',
    ],
    [
      'student',
      { insurance: 'no', data_listed: 'not_shown', direct_control: 'no' },
      'high weak high  approve_with_conditions',
    ],
    // A key paper No: weak even with one gap; Not shown: not enough to judge.
    ['staff', { security_report: 'no' }, 'moderate weak moderate  approve_with_conditions'],
    ['staff', { security_report: 'not_shown' }, 'moderate insufficient moderate  more_information'],
    ['staff', { data_agreement: 'no' }, 'moderate weak moderate  approve_with_conditions'],
    ['staff', { breach_notice: 'not_shown' }, 'moderate insufficient moderate  more_information'],
    // More than half Not shown: 5 of 9 is, 4 of 9 is not; 8 of 14 is, 7 of 14 is not.
    [
      'staff',
      {
        data_listed: 'not_shown',
        data_we_send: 'not_shown',
        hosting_known: 'not_shown',
        return_or_delete: 'not_shown',
      },
      'moderate weak moderate  approve_with_conditions',
    ],
    [
      'staff',
      {
        data_listed: 'not_shown',
        data_we_send: 'not_shown',
        hosting_known: 'not_shown',
        return_or_delete: 'not_shown',
        subvendors_named: 'not_shown',
      },
      'moderate insufficient moderate  more_information',
    ],
    [
      'student',
      {
        data_listed: 'not_shown',
        data_we_send: 'not_shown',
        hosting_known: 'not_shown',
        return_or_delete: 'not_shown',
        subvendors_named: 'not_shown',
        insurance: 'not_shown',
        direct_control: 'not_shown',
      },
      'high weak high  approve_with_conditions',
    ],
    [
      'student',
      {
        data_listed: 'not_shown',
        data_we_send: 'not_shown',
        hosting_known: 'not_shown',
        return_or_delete: 'not_shown',
        subvendors_named: 'not_shown',
        insurance: 'not_shown',
        direct_control: 'not_shown',
        purpose_only: 'not_shown',
      },
      'high insufficient high  more_information',
    ],
    // Every hard stop, alone; all four together, in question order.
    ['student', { data_agreement: 'no' }, 'high weak high student_data_no_agreement do_not_use'],
    ['student', { breach_notice: 'no' }, 'high weak high student_data_no_breach_notice do_not_use'],
    ['student', { no_sale_or_ads: 'no' }, 'high adequate high student_data_sale_or_ads do_not_use'],
    ['student', { no_ai_training: 'no' }, 'high adequate high student_data_ai_training do_not_use'],
    [
      'student',
      { no_ai_training: 'no', breach_notice: 'no', no_sale_or_ads: 'no', data_agreement: 'no' },
      'high weak high student_data_no_agreement,student_data_no_breach_notice,student_data_sale_or_ads,student_data_ai_training do_not_use',
    ],
    // A hard stop wins over a pending one and over not enough to judge.
    [
      'student',
      { data_agreement: 'no', no_sale_or_ads: 'not_shown' },
      'high weak high student_data_no_agreement do_not_use',
    ],
    [
      'student',
      { no_ai_training: 'no', security_report: 'not_shown' },
      'high insufficient high student_data_ai_training do_not_use',
    ],
    // A hard-stop question Not shown: not yet ruled out.
    ['student', { no_sale_or_ads: 'not_shown' }, 'high adequate moderate  more_information'],
    ['student', { data_agreement: 'not_shown' }, 'high insufficient high  more_information'],
    // The same answers with staff contact details make no hard stop.
    [
      'staff',
      { data_agreement: 'no', breach_notice: 'no' },
      'moderate weak moderate  approve_with_conditions',
    ],
    // Unanswered counts as Not shown.
    ['student', { no_ai_training: 'missing' }, 'high adequate moderate  more_information'],
  ];

  it.each(CASES)('%s %j gives %s', (level, over, want) => {
    expect(brief(evaluateVendorRisk(level, answers(level, over)))).toBe(want);
  });

  it('never counts Not shown as a pass: one Not shown on any asked question is a gap, an item, never Approve and never strong', () => {
    for (const level of ['staff', 'student'] as const) {
      for (const q of vendorRiskQuestionsFor(level)) {
        const e = evaluateVendorRisk(level, answers(level, { [q.key]: 'not_shown' }));
        expect(e.result, `${level}/${q.key}`).not.toBe('approve');
        expect(e.evidence, `${level}/${q.key}`).not.toBe('strong');
        expect(e.gaps).toEqual([q.key]);
        expect(e.items).toEqual([
          expect.objectContaining({
            questionKey: q.key,
            answer: 'not_shown',
            finding: q.finding.not_shown,
          }),
        ]);
        expect(e.notShownCount).toBe(1);
      }
    }
  });

  it('counts an unanswered question exactly as Not shown, and says it is missing', () => {
    for (const level of ['staff', 'student'] as const) {
      for (const q of vendorRiskQuestionsFor(level)) {
        const missing = evaluateVendorRisk(level, answers(level, { [q.key]: 'missing' }));
        const shown = evaluateVendorRisk(level, answers(level, { [q.key]: 'not_shown' }));
        expect(brief(missing)).toBe(brief(shown));
        expect(missing.missing).toEqual([q.key]);
        expect(missing.complete).toBe(false);
        expect(shown.complete).toBe(true);
      }
    }
    expect(evaluateVendorRisk('student', null).result).toBe('more_information');
    expect(evaluateVendorRisk('student', {}).missing).toHaveLength(14);
  });

  it('never gets worse when an answer becomes Yes (2,000 made-up reviews)', () => {
    const rank = (list: readonly string[], v: string) => list.indexOf(v);
    const RESULT_ORDER = ['approve', 'approve_with_conditions', 'more_information', 'do_not_use'];
    const EVIDENCE_ORDER = ['not_needed', 'strong', 'adequate', 'weak', 'insufficient'];
    // Park and Miller's generator: the product stays below 2^53, so every step is exact.
    let seed = 481;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 2000; i += 1) {
      const level: VendorRiskDataLevel = next() < 0.5 ? 'staff' : 'student';
      const a: Record<string, { answer: VendorRiskAnswer }> = {};
      for (const q of vendorRiskQuestionsFor(level))
        a[q.key] = { answer: VENDOR_RISK_ANSWERS[Math.floor(next() * 3)]! };
      const before = evaluateVendorRisk(level, a as VendorRiskAnswers);
      expect(before.complete).toBe(true);
      const gaps = Object.keys(a).filter((k) => a[k]!.answer !== 'yes');
      if (gaps.length === 0) continue;
      const k = gaps[Math.floor(next() * gaps.length)]!;
      const after = evaluateVendorRisk(level, {
        ...a,
        [k]: { answer: 'yes' },
      } as VendorRiskAnswers);
      expect(rank(RESULT_ORDER, after.result)).toBeLessThanOrEqual(
        rank(RESULT_ORDER, before.result),
      );
      expect(rank(EVIDENCE_ORDER, after.evidence)).toBeLessThanOrEqual(
        rank(EVIDENCE_ORDER, before.evidence),
      );
      expect(rank(VENDOR_RISK_RISK_LEVELS, after.residualRisk)).toBeLessThanOrEqual(
        rank(VENDOR_RISK_RISK_LEVELS, before.residualRisk),
      );
      expect(after.gaps.length).toBe(before.gaps.length - 1);
    }
  });

  it('gives only the closed lists', () => {
    for (const level of VENDOR_RISK_DATA_LEVELS) {
      const e = evaluateVendorRisk(level, answers(level, { insurance: 'no' }));
      expect(VENDOR_RISK_RESULTS).toContain(e.result);
      expect(VENDOR_RISK_EVIDENCE_LEVELS).toContain(e.evidence);
      expect(VENDOR_RISK_RISK_LEVELS).toContain(e.residualRisk);
    }
  });

  it('makes one item for each gap, in question order, with the severity for the level', () => {
    const staff = evaluateVendorRisk(
      'staff',
      answers('staff', { insurance: 'no', data_agreement: 'not_shown' }),
    );
    expect(staff.items.map((i) => [i.questionKey, i.answer, i.severity])).toEqual([
      ['data_agreement', 'not_shown', 'medium'],
      ['insurance', 'no', 'low'],
    ]);
    const student = evaluateVendorRisk(
      'student',
      answers('student', { insurance: 'no', data_agreement: 'not_shown' }),
    );
    expect(student.items.map((i) => [i.questionKey, i.severity])).toEqual([
      ['data_agreement', 'critical'],
      ['insurance', 'medium'],
    ]);
    // An answer to a question not asked at the level is ignored by the rules (the database refuses it).
    expect(
      evaluateVendorRisk('staff', { ...answers('staff'), direct_control: { answer: 'no' } }).result,
    ).toBe('approve');
  });

  it('keeps the override in force, else the computed result', () => {
    expect(vendorRiskResultInForce('approve', 'do_not_use')).toBe('do_not_use');
    expect(vendorRiskResultInForce('do_not_use', null)).toBe('do_not_use');
    expect(vendorRiskResultInForce('more_information', undefined)).toBe('more_information');
  });
});

describe('the follow-up questions', () => {
  it('asks one question for each gap, in question order, and nothing when there is none', () => {
    const a = answers('staff', { insurance: 'no', hosting_known: 'not_shown' });
    expect(vendorRiskFollowUps('staff', a)).toEqual([
      VENDOR_RISK_QUESTIONS.find((q) => q.key === 'hosting_known')!.followUp,
      VENDOR_RISK_QUESTIONS.find((q) => q.key === 'insurance')!.followUp,
    ]);
    expect(vendorRiskFollowUpEmail('Example Paper Co', 'staff', answers('staff'))).toBeNull();
    expect(vendorRiskFollowUpEmail('Example Paper Co', 'none', {})).toBeNull();
  });

  it('writes plain text to paste into an email, numbered', () => {
    const text = vendorRiskFollowUpEmail(
      '  Example Paper Co ',
      'staff',
      answers('staff', { insurance: 'no', hosting_known: 'not_shown' }),
    )!;
    const lines = text.split('\n');
    expect(lines[0]).toBe('Questions for Example Paper Co about the data of ours you hold');
    expect(lines[2]).toMatch(/^1\. Please tell us in which country/);
    expect(lines[3]).toMatch(/^2\. Please send us a certificate of your cyber insurance/);
    expect(text).not.toMatch(/[<>]/);
    expect(vendorRiskFollowUpEmail('', 'staff', answers('staff', { insurance: 'no' }))).toMatch(
      /^Questions for your company /,
    );
  });
});

describe('dates', () => {
  it("adds months as Postgres does (the month's last day when the day does not exist)", () => {
    expect(addVendorRiskMonths('2026-01-15', 12)).toBe('2027-01-15');
    expect(addVendorRiskMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(addVendorRiskMonths('2027-08-29', 6)).toBe('2028-02-29');
    expect(addVendorRiskMonths('2028-02-29', 12)).toBe('2029-02-28');
    expect(addVendorRiskMonths('2026-12-31', 6)).toBe('2027-06-30');
    expect(addVendorRiskMonths('2026-11-24', 36)).toBe('2029-11-24');
    expect(() => addVendorRiskMonths('2026-02-30', 1)).toThrow(RangeError);
    expect(addVendorRiskDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addVendorRiskDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('defaults the next review to 12 months, 6 with student data', () => {
    expect(vendorRiskDefaultNextReview('none', '2026-11-24')).toBe('2027-11-24');
    expect(vendorRiskDefaultNextReview('staff', '2026-11-24')).toBe('2027-11-24');
    expect(vendorRiskDefaultNextReview('student', '2026-11-24')).toBe('2027-05-24');
  });

  it('allows a next review after today and up to three years ahead, and a due date from today', () => {
    expect(vendorRiskNextReviewAllowed('2026-11-24', '2026-11-24')).toBe(false);
    expect(vendorRiskNextReviewAllowed('2026-11-25', '2026-11-24')).toBe(true);
    expect(vendorRiskNextReviewAllowed('2029-11-24', '2026-11-24')).toBe(true);
    expect(vendorRiskNextReviewAllowed('2029-11-25', '2026-11-24')).toBe(false);
    expect(vendorRiskNextReviewAllowed('soon', '2026-11-24')).toBe(false);
    expect(vendorRiskDueDateAllowed('2026-11-24', '2026-11-24')).toBe(true);
    expect(vendorRiskDueDateAllowed('2026-11-23', '2026-11-24')).toBe(false);
    expect(vendorRiskDueDateAllowed('2029-11-25', '2026-11-24')).toBe(false);
  });

  it('says where a review stands against its date', () => {
    expect(vendorRiskReviewDue(null, '2026-11-24')).toBe('not_reviewed');
    expect(vendorRiskReviewDue('2026-11-23', '2026-11-24')).toBe('overdue');
    expect(vendorRiskReviewDue('2026-11-24', '2026-11-24')).toBe('due_today');
    expect(vendorRiskReviewDue('2026-12-24', '2026-11-24')).toBe('due_soon');
    expect(vendorRiskReviewDue('2026-12-25', '2026-11-24')).toBe('scheduled');
  });
});

describe('what the database refuses', () => {
  it("holds text to the database's rule", () => {
    const cases: Array<[unknown, boolean]> = [
      ['Plain words.', true],
      ['Two\nlines\r\nand a\ttab', true],
      ['x'.repeat(20), true],
      ['x'.repeat(21), false],
      ['', false],
      [' \n\t', false],
      ['Bell\u0007', false],
      ['Esc\u001b', false],
      ['Del\u007f', false],
      ['C1\u0085', false],
      ['Zero\u200bwidth', false],
      ['Right\u202eleft', false],
      ['Iso\u2066late', false],
      ['Bom\ufeff', false],
      ['Line\u2028sep', false],
      [null, false],
      [5, false],
    ];
    for (const [s, want] of cases) expect(vendorRiskTextOk(s, 1, 20), JSON.stringify(s)).toBe(want);
    // Characters, not UTF-16 units: a letter outside the basic plane counts once.
    expect(vendorRiskTextOk('\u{10400}'.repeat(20), 1, 20)).toBe(true);
  });

  it('holds an override reason to 10 to 2000 characters once the ends are trimmed', () => {
    expect(vendorRiskOverrideReasonOk('Vendor fixed it.')).toBe(true);
    expect(vendorRiskOverrideReasonOk('Too short')).toBe(false);
    expect(vendorRiskOverrideReasonOk('   Too short   ')).toBe(false);
    expect(vendorRiskOverrideReasonOk('y'.repeat(2000))).toBe(true);
    expect(vendorRiskOverrideReasonOk('y'.repeat(2001))).toBe(false);
    expect(vendorRiskOverrideReasonOk(null)).toBe(false);
  });

  it("names each wrong answer with the database's word", () => {
    const cases: Array<[unknown, unknown, boolean, string | null]> = [
      ['staff', answers('staff'), true, null],
      ['student', answers('student'), true, null],
      ['none', {}, true, null],
      ['staff', {}, false, null],
      [
        'student',
        {
          data_agreement: {
            answer: 'yes',
            note: 'Signed by both sides.\nOn file.',
            date: '2026-03-01',
          },
          insurance: { answer: 'not_shown', note: null, date: null },
        },
        false,
        null,
      ],
      ['staff', null, false, 'answers_not_an_object'],
      ['staff', [], false, 'answers_not_an_object'],
      ['staff', 'yes', false, 'answers_not_an_object'],
      ['staff', { data_listd: { answer: 'yes' } }, false, 'answer_unknown_question'],
      ['staff', { direct_control: { answer: 'yes' } }, false, 'answer_not_applicable'],
      ['none', { insurance: { answer: 'yes' } }, false, 'answer_not_applicable'],
      ['staff', { insurance: 'yes' }, false, 'answer_bad_shape'],
      ['staff', { insurance: { answer: 'yes', source: 'web' } }, false, 'answer_bad_shape'],
      ['staff', { insurance: { note: 'no answer' } }, false, 'answer_bad_value'],
      ['staff', { insurance: { answer: 'maybe' } }, false, 'answer_bad_value'],
      ['staff', { insurance: { answer: 'YES' } }, false, 'answer_bad_value'],
      ['staff', { insurance: { answer: true } }, false, 'answer_bad_value'],
      ['staff', { insurance: { answer: 'yes', note: '' } }, false, 'answer_bad_note'],
      ['staff', { insurance: { answer: 'yes', note: '   ' } }, false, 'answer_bad_note'],
      ['staff', { insurance: { answer: 'yes', note: 5 } }, false, 'answer_bad_note'],
      [
        'staff',
        { hosting_known: { answer: 'yes', date: '2026-01-01' } },
        false,
        'answer_date_not_allowed',
      ],
      ['staff', { insurance: { answer: 'yes', date: '2026-02-30' } }, false, 'answer_bad_date'],
      ['staff', { insurance: { answer: 'yes', date: '26-01-01' } }, false, 'answer_bad_date'],
      ['staff', { insurance: { answer: 'yes', date: '1999-12-31' } }, false, 'answer_bad_date'],
      ['staff', { insurance: { answer: 'yes', date: '2101-01-01' } }, false, 'answer_bad_date'],
      ['staff', { insurance: { answer: 'yes', date: 20260101 } }, false, 'answer_bad_date'],
      ['staff', { insurance: { answer: 'yes' } }, true, 'answers_incomplete'],
      ['everyone', {}, false, 'bad_data_level'],
    ];
    for (const [level, a, final, want] of cases) {
      expect(vendorRiskAnswersProblem(level, a, final), JSON.stringify([level, a, final])).toBe(
        want,
      );
    }
  });
});

describe('the source', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('names the skill the questions come from once, in the rules file, and nothing else of the talk', () => {
    const mentions = files.flatMap((f) =>
      readFileSync(join(HERE, f), 'utf8')
        .split('\n')
        .filter((l) => /grc-assessment|Cite-Talk/i.test(l))
        .map((l) => `${f}: ${l}`),
    );
    expect(mentions).toEqual([
      'rules.ts: // The review questions were adapted, reworded and reduced, from the grc-assessment skill shown in the Cite-Talk-2026 talk.',
    ]);
  });
});
