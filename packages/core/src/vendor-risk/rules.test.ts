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
  VENDOR_RISK_HIDDEN_CHARACTERS,
  VENDOR_RISK_OVERRIDE_REASON_MIN_DIFFERENT,
  VENDOR_RISK_RESULTS,
  VENDOR_RISK_RISK_LEVELS,
  VENDOR_RISK_SPACE_CHARACTERS,
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

/** As answers(), with the date `on` beside a Yes to the security report and to insurance (a finished review needs it). */
function datedAnswers(
  level: VendorRiskDataLevel,
  on: string,
  over: Partial<Record<string, VendorRiskAnswer | 'missing'>> = {},
): VendorRiskAnswers {
  const out = answers(level, over) as Record<string, { answer: VendorRiskAnswer; date?: string }>;
  for (const q of vendorRiskQuestionsFor(level)) {
    if (q.date?.maxAgeMonths && out[q.key]?.answer === 'yes')
      out[q.key] = { answer: 'yes', date: on };
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

  it('has seven hard stops, three key papers and three dates, two of them judged', () => {
    expect(VENDOR_RISK_QUESTIONS.filter((q) => q.hardStop).map((q) => [q.key, q.hardStop])).toEqual(
      [
        ['data_agreement', 'student_data_no_agreement'],
        ['breach_notice', 'student_data_no_breach_notice'],
        ['direct_control', 'student_data_no_direct_control'],
        ['purpose_only', 'student_data_no_purpose_limit'],
        ['no_redisclosure', 'student_data_redisclosure'],
        ['no_sale_or_ads', 'student_data_sale_or_ads'],
        ['no_ai_training', 'student_data_ai_training'],
      ],
    );
    // Every question of the Student data group is a hard-stop question, so Not
    // shown on any of them is a hard stop not yet ruled out (More information).
    for (const q of VENDOR_RISK_QUESTIONS.filter((x) => x.group === 'student'))
      expect(q.hardStop, q.key).not.toBeNull();
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
    expect(
      VENDOR_RISK_QUESTIONS.filter((q) => q.date?.maxAgeMonths).map((q) => [
        q.key,
        q.date!.maxAgeMonths,
        Boolean(q.finding.out_of_date),
      ]),
    ).toEqual([
      ['security_report', 12, true],
      ['insurance', 12, true],
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
    // Three gaps: weak, the starting risk stays.
    [
      'staff',
      { insurance: 'no', hosting_known: 'not_shown', data_listed: 'no' },
      'moderate weak moderate  approve_with_conditions',
    ],
    [
      'student',
      { insurance: 'no', data_listed: 'not_shown', return_or_delete: 'no' },
      'high weak high  approve_with_conditions',
    ],
    // More than three gaps is never Approve with conditions: four is More information.
    [
      'staff',
      { insurance: 'no', hosting_known: 'no', data_listed: 'no', data_we_send: 'no' },
      'moderate weak moderate  more_information',
    ],
    [
      'staff',
      { insurance: 'no', hosting_known: 'not_shown', data_listed: 'no', data_we_send: 'not_shown' },
      'moderate weak moderate  more_information',
    ],
    [
      'student',
      { insurance: 'no', hosting_known: 'no', data_listed: 'no', return_or_delete: 'no' },
      'high weak high  more_information',
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
      'moderate weak moderate  more_information',
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
      'high weak high  more_information',
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
    // Every hard stop, alone; all seven together, in question order.
    ['student', { data_agreement: 'no' }, 'high weak high student_data_no_agreement do_not_use'],
    ['student', { breach_notice: 'no' }, 'high weak high student_data_no_breach_notice do_not_use'],
    [
      'student',
      { direct_control: 'no' },
      'high adequate high student_data_no_direct_control do_not_use',
    ],
    [
      'student',
      { purpose_only: 'no' },
      'high adequate high student_data_no_purpose_limit do_not_use',
    ],
    [
      'student',
      { no_redisclosure: 'no' },
      'high adequate high student_data_redisclosure do_not_use',
    ],
    [
      'student',
      { direct_control: 'no', purpose_only: 'no' },
      'high adequate high student_data_no_direct_control,student_data_no_purpose_limit do_not_use',
    ],
    ['student', { no_sale_or_ads: 'no' }, 'high adequate high student_data_sale_or_ads do_not_use'],
    ['student', { no_ai_training: 'no' }, 'high adequate high student_data_ai_training do_not_use'],
    [
      'student',
      { no_ai_training: 'no', breach_notice: 'no', no_sale_or_ads: 'no', data_agreement: 'no' },
      'high weak high student_data_no_agreement,student_data_no_breach_notice,student_data_sale_or_ads,student_data_ai_training do_not_use',
    ],
    [
      'student',
      {
        no_ai_training: 'no',
        breach_notice: 'no',
        no_sale_or_ads: 'no',
        data_agreement: 'no',
        no_redisclosure: 'no',
        purpose_only: 'no',
        direct_control: 'no',
      },
      'high weak high student_data_no_agreement,student_data_no_breach_notice,student_data_no_direct_control,student_data_no_purpose_limit,student_data_redisclosure,student_data_sale_or_ads,student_data_ai_training do_not_use',
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
    // A hard-stop question Not shown: not yet ruled out (so any Student data question Not shown).
    ['student', { no_sale_or_ads: 'not_shown' }, 'high adequate moderate  more_information'],
    ['student', { direct_control: 'not_shown' }, 'high adequate moderate  more_information'],
    ['student', { purpose_only: 'not_shown' }, 'high adequate moderate  more_information'],
    ['student', { no_redisclosure: 'not_shown' }, 'high adequate moderate  more_information'],
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

describe('the dates beside the answers', () => {
  // The review is on 2026-06-30: 12 months before is 2025-06-30.
  const on = { reviewedOn: '2026-06-30' };
  const dated = (level: VendorRiskDataLevel, key: VendorRiskQuestionKey, date: string) => ({
    ...answers(level),
    [key]: { answer: 'yes' as const, date },
  });

  it('counts a security report or insurance dated more than 12 months before the review as Not shown, and the item says it is out of date', () => {
    const report = evaluateVendorRisk('staff', dated('staff', 'security_report', '2025-06-29'), on);
    expect(brief(report)).toBe('moderate insufficient moderate  more_information');
    expect(report.outOfDate).toEqual(['security_report']);
    expect(report.items).toEqual([
      expect.objectContaining({
        questionKey: 'security_report',
        answer: 'out_of_date',
        severity: 'medium',
        finding: VENDOR_RISK_QUESTIONS.find((q) => q.key === 'security_report')!.finding
          .out_of_date,
      }),
    ]);
    const cover = evaluateVendorRisk('staff', dated('staff', 'insurance', '2025-06-29'), on);
    expect(brief(cover)).toBe('moderate adequate low  approve_with_conditions');
    expect(cover.items.map((i) => [i.questionKey, i.answer])).toEqual([
      ['insurance', 'out_of_date'],
    ]);
    const student = evaluateVendorRisk('student', dated('student', 'insurance', '2001-01-01'), on);
    expect(brief(student)).toBe('high adequate moderate  approve_with_conditions');
  });

  it('keeps a date exactly 12 months before, a later one, and no date as Yes', () => {
    for (const d of ['2025-06-30', '2026-06-30', '2027-01-01']) {
      expect(brief(evaluateVendorRisk('staff', dated('staff', 'security_report', d), on)), d).toBe(
        'moderate strong low  approve',
      );
      expect(brief(evaluateVendorRisk('staff', dated('staff', 'insurance', d), on)), d).toBe(
        'moderate strong low  approve',
      );
    }
    expect(evaluateVendorRisk('staff', answers('staff'), on).outOfDate).toEqual([]);
  });

  it('judges no other date, and no date without the day of the review', () => {
    expect(
      brief(evaluateVendorRisk('staff', dated('staff', 'data_agreement', '2001-01-01'), on)),
    ).toBe('moderate strong low  approve');
    expect(
      brief(evaluateVendorRisk('staff', dated('staff', 'security_report', '2001-01-01'))),
    ).toBe('moderate strong low  approve');
    // A No stays a No whatever its date.
    const no = { ...answers('staff'), insurance: { answer: 'no' as const, date: '2001-01-01' } };
    expect(evaluateVendorRisk('staff', no, on).items.map((i) => i.answer)).toEqual(['no']);
    expect(() =>
      evaluateVendorRisk('staff', answers('staff'), { reviewedOn: '2026-02-30' }),
    ).toThrow(RangeError);
  });

  it("takes 12 months back as Postgres does (the month's last day): a review on 2028-02-29", () => {
    const leap = { reviewedOn: '2028-02-29' };
    expect(
      evaluateVendorRisk('staff', dated('staff', 'insurance', '2027-02-28'), leap).result,
    ).toBe('approve');
    expect(
      evaluateVendorRisk('staff', dated('staff', 'insurance', '2027-02-27'), leap).result,
    ).toBe('approve_with_conditions');
  });

  it('asks the vendor again for an out-of-date report', () => {
    expect(
      vendorRiskFollowUps('staff', dated('staff', 'security_report', '2020-01-01'), on),
    ).toEqual([VENDOR_RISK_QUESTIONS.find((q) => q.key === 'security_report')!.followUp]);
  });
});

describe('with student data, over every answer set (3^14 = 4,782,969)', () => {
  it('a hard-stop question that is not Yes is never Approve or Approve with conditions; any gap is never Approve; more than three gaps never Approve with conditions', () => {
    const asked = vendorRiskQuestionsFor('student');
    const stopAt = asked.map((q) => q.hardStop !== null);
    const VALUES = VENDOR_RISK_ANSWERS;
    const digits = new Array<number>(asked.length).fill(0);
    const a: Record<string, { answer: VendorRiskAnswer }> = {};
    for (const q of asked) a[q.key] = { answer: 'yes' };
    let bad = 0;
    let n = 0;
    for (;;) {
      const e = evaluateVendorRisk('student', a as VendorRiskAnswers);
      let stopNotYes = false;
      let gaps = 0;
      for (let i = 0; i < digits.length; i += 1) {
        if (digits[i] !== 0) {
          gaps += 1;
          if (stopAt[i]) stopNotYes = true;
        }
      }
      if (stopNotYes && (e.result === 'approve' || e.result === 'approve_with_conditions'))
        bad += 1;
      if (gaps > 0 && e.result === 'approve') bad += 1;
      if (gaps > 3 && e.result === 'approve_with_conditions') bad += 1;
      n += 1;
      let i = 0;
      while (i < digits.length && digits[i] === 2) {
        digits[i] = 0;
        a[asked[i]!.key] = { answer: VALUES[0] };
        i += 1;
      }
      if (i === digits.length) break;
      digits[i] = digits[i]! + 1;
      a[asked[i]!.key] = { answer: VALUES[digits[i]!]! };
    }
    expect(n).toBe(3 ** 14);
    expect(bad).toBe(0);
  }, 120_000);
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

  it('holds a reason to 20 to 2000 characters once the ends are trimmed, with at least 5 different ones', () => {
    expect(vendorRiskOverrideReasonOk('The vendor fixed it.')).toBe(true);
    expect(vendorRiskOverrideReasonOk('The vendor fixed it')).toBe(false);
    expect(vendorRiskOverrideReasonOk('   The vendor fixed it   ')).toBe(false);
    expect(vendorRiskOverrideReasonOk('abcde'.repeat(400))).toBe(true);
    expect(vendorRiskOverrideReasonOk('abcde'.repeat(400) + 'f')).toBe(false);
    expect(vendorRiskOverrideReasonOk('xy'.repeat(1000))).toBe(false);
    expect(vendorRiskOverrideReasonOk('a'.repeat(20))).toBe(false);
    expect(vendorRiskOverrideReasonOk('aaaa aaaa aaaa aaaa aaaa')).toBe(false);
    expect(vendorRiskOverrideReasonOk('aaaa bbbb\tcccc\ndddd eeee')).toBe(true);
    expect(vendorRiskOverrideReasonOk(null)).toBe(false);
  });

  it("names each wrong answer with the database's word", () => {
    const cases: Array<[unknown, unknown, boolean, string | null]> = [
      ['staff', datedAnswers('staff', '2026-06-30'), true, null],
      ['student', datedAnswers('student', '2026-06-30'), true, null],
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
      ['staff', { insurance: { answer: 'yes', date: '2026-01-01' } }, true, 'answers_incomplete'],
      ['everyone', {}, false, 'bad_data_level'],
    ];
    for (const [level, a, final, want] of cases) {
      expect(vendorRiskAnswersProblem(level, a, final), JSON.stringify([level, a, final])).toBe(
        want,
      );
    }
  });
});

/** Is this code point in one of the ranges. */
function inRanges(ranges: readonly (readonly [number, number])[], cp: number): boolean {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

describe('round 2 (R2-S1): no stored text holds a hidden character, and a reason counts what can be seen', () => {
  it('keeps the hidden characters and the spaces as two lists of ranges in order, apart from each other', () => {
    for (const list of [VENDOR_RISK_HIDDEN_CHARACTERS, VENDOR_RISK_SPACE_CHARACTERS]) {
      for (let i = 0; i < list.length; i += 1) {
        const [lo, hi] = list[i]!;
        expect(lo).toBeLessThanOrEqual(hi);
        if (i > 0) expect(lo).toBeGreaterThan(list[i - 1]![1]);
      }
    }
    for (const [lo, hi] of VENDOR_RISK_SPACE_CHARACTERS) {
      for (let cp = lo; cp <= hi; cp += 1)
        expect(inRanges(VENDOR_RISK_HIDDEN_CHARACTERS, cp)).toBe(false);
    }
  });

  it('names the characters the review found let through, and the other kinds the rule is for', () => {
    const named = [
      // word joiner and the invisible operators; soft hyphen; combining grapheme joiner; the Hangul fillers;
      // Mongolian vowel separator; halfwidth Hangul filler; tag characters (the first, the language tag, A, cancel)
      0x2060,
      0x2061, 0x2062, 0x2063, 0x2064, 0x00ad, 0x034f, 0x115f, 0x1160, 0x180e, 0x3164, 0xffa0,
      0xe0000, 0xe0001, 0xe0041, 0xe007f,
      // controls (C0 but tab and line breaks, delete, C1); zero width space, non-joiner, joiner; direction marks,
      // embeddings, overrides and isolates; line and paragraph separators; byte order mark; variation selectors;
      // the Arabic letter mark; interlinear annotation; the variation selectors supplement
      0x0001,
      0x000b, 0x000c, 0x001b, 0x007f, 0x0085, 0x009f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
      0x202a, 0x202e, 0x2066, 0x2069, 0x2028, 0x2029, 0xfeff, 0xfe00, 0xfe0f, 0x061c, 0xfff9,
      0xfffb, 0xe0100, 0xe01ef,
    ];
    for (const cp of named) {
      expect(inRanges(VENDOR_RISK_HIDDEN_CHARACTERS, cp), cp.toString(16)).toBe(true);
    }
    for (const cp of [0x09, 0x0a, 0x0d, 0x20, 0xa0, 0x3000, 0x202f]) {
      expect(inRanges(VENDOR_RISK_SPACE_CHARACTERS, cp), cp.toString(16)).toBe(true);
    }
  });

  it('refuses exactly the hidden characters, at every code point', () => {
    let wrong = 0;
    for (let cp = 1; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ok = vendorRiskTextOk(`Ab${String.fromCodePoint(cp)}`, 1, 20);
      if (ok === inRanges(VENDOR_RISK_HIDDEN_CHARACTERS, cp)) wrong += 1;
    }
    expect(wrong).toBe(0);
  }, 60_000);

  it('takes no text made of spaces of any kind, and takes a space of any kind between words', () => {
    for (const [lo, hi] of VENDOR_RISK_SPACE_CHARACTERS) {
      for (let cp = lo; cp <= hi; cp += 1) {
        const sp = String.fromCodePoint(cp);
        expect(vendorRiskTextOk(sp.repeat(3), 1, 20), cp.toString(16)).toBe(false);
        expect(vendorRiskTextOk(`a${sp}b`, 1, 20), cp.toString(16)).toBe(true);
      }
    }
  });

  it('refuses a note, a finding, an action or a reason with a hidden character', () => {
    expect(vendorRiskTextOk('Signed\u2060 by both', 1, 1000)).toBe(false);
    expect(vendorRiskTextOk('Ask for the \u{E0041}report', 1, 500)).toBe(false);
    expect(
      vendorRiskAnswersProblem(
        'staff',
        { insurance: { answer: 'no', note: 'On\u00ADfile' } },
        false,
      ),
    ).toBe('answer_bad_note');
    expect(vendorRiskOverrideReasonOk('The vendor fixed it all\u3164')).toBe(false);
  });

  it('counts a reason over what can be seen: one letter and 19 invisible or space characters is not a reason', () => {
    for (const pad of [
      '\u2060',
      '\u2061',
      '\u00AD',
      '\u3164',
      '\u115F',
      '\u{E0020}',
      '\u00A0',
      ' ',
      '\u3000',
    ]) {
      expect(vendorRiskOverrideReasonOk(`a${pad.repeat(19)}`), JSON.stringify(pad)).toBe(false);
      expect(vendorRiskOverrideReasonOk(`abcde${pad.repeat(30)}`), JSON.stringify(pad)).toBe(false);
    }
  });

  it('collapses each run of spaces to one before counting 20, and needs 5 different characters', () => {
    expect(VENDOR_RISK_OVERRIDE_REASON_MIN_DIFFERENT).toBe(5);
    const cases: Array<[string, boolean]> = [
      ['abcde fghij klmno pq', true], // 20
      ['abcde fghij klmno p', false], // 19
      ['abcde   fghij\t\tklmno\n\np', false], // 19 once collapsed
      ['abcde\u00A0\u00A0\u00A0fghij\t\tklmno\n\npqrs', true], // 22 once collapsed
      [' \u3000abcde fghij klmno pq\u3000 ', true], // 20 once trimmed
      ['ab   cd   ef   gh   ij', false], // 14 once collapsed
      ['abcd'.repeat(5), false], // 20, four different
      ['abcde'.repeat(4), true], // 20, five different
      ['aaaaa bbbbb ccccc ddddd', false], // the space is not one of the five
      ['aaaaa bbbbb ccccc ddddd e', true],
      ['\u{10400}\u{10401}\u{10402}\u{10403}\u{10404}'.repeat(4), true], // letters outside the basic plane
      ['\u00E9\u00E8\u00EA\u00EB\u00E0'.repeat(4), true],
    ];
    for (const [s, want] of cases)
      expect(vendorRiskOverrideReasonOk(s), JSON.stringify(s)).toBe(want);
  });
});

describe('round 2 (R2-S2): a Yes on the security report or insurance needs its date, and never one in the future', () => {
  const T = { utcToday: '2026-06-30' };

  it('refuses a finished Yes without its date on either question, and takes it in a draft', () => {
    for (const key of ['security_report', 'insurance'] as const) {
      const a = datedAnswers('staff', '2026-06-30');
      for (const missing of [{ answer: 'yes' }, { answer: 'yes', date: null }]) {
        const without = { ...a, [key]: missing };
        expect(vendorRiskAnswersProblem('staff', without, true, T), key).toBe(
          'answer_date_missing',
        );
        expect(vendorRiskAnswersProblem('staff', without, true), key).toBe('answer_date_missing');
        expect(vendorRiskAnswersProblem('staff', without, false, T), key).toBeNull();
      }
      // No and Not shown need no date.
      for (const other of ['no', 'not_shown'] as const) {
        expect(
          vendorRiskAnswersProblem('staff', { ...a, [key]: { answer: other } }, true, T),
        ).toBeNull();
      }
    }
    // The data agreement keeps a date but needs none.
    const agreement = { ...datedAnswers('staff', '2026-06-30'), data_agreement: { answer: 'yes' } };
    expect(vendorRiskAnswersProblem('staff', agreement, true, T)).toBeNull();
  });

  it('refuses a date later than tomorrow in UTC on either question, whatever the answer, draft or finish', () => {
    for (const key of ['security_report', 'insurance'] as const) {
      for (const answer of ['yes', 'no', 'not_shown'] as const) {
        const at = (date: string) => ({ [key]: { answer, date } });
        expect(vendorRiskAnswersProblem('staff', at('2026-07-01'), false, T), key).toBeNull();
        expect(vendorRiskAnswersProblem('staff', at('2026-06-30'), false, T), key).toBeNull();
        for (const final of [false, true]) {
          expect(
            vendorRiskAnswersProblem(
              'staff',
              { ...datedAnswers('staff', '2026-06-30'), ...at('2026-07-02') },
              final,
              T,
            ),
            key,
          ).toBe('answer_date_in_future');
        }
      }
    }
    // A leap day and the turn of a year are tomorrow like any other day.
    const ins = (date: string) => ({ insurance: { answer: 'yes', date } });
    expect(
      vendorRiskAnswersProblem('staff', ins('2028-02-29'), false, { utcToday: '2028-02-28' }),
    ).toBeNull();
    expect(
      vendorRiskAnswersProblem('staff', ins('2028-03-01'), false, { utcToday: '2028-02-28' }),
    ).toBe('answer_date_in_future');
    expect(
      vendorRiskAnswersProblem('staff', ins('2027-01-01'), false, { utcToday: '2026-12-31' }),
    ).toBeNull();
    expect(
      vendorRiskAnswersProblem('staff', ins('2027-01-02'), false, { utcToday: '2026-12-31' }),
    ).toBe('answer_date_in_future');
    // Without today, no date is judged in the future; the data agreement's date never is.
    expect(vendorRiskAnswersProblem('staff', ins('2030-01-01'), false)).toBeNull();
    expect(
      vendorRiskAnswersProblem(
        'staff',
        { data_agreement: { answer: 'yes', date: '2030-01-01' } },
        false,
        T,
      ),
    ).toBeNull();
    expect(() => vendorRiskAnswersProblem('staff', {}, false, { utcToday: '2026-02-30' })).toThrow(
      RangeError,
    );
  });

  it('asks for the date on the certificate, not the end of the cover, and the rules say a Yes needs its date', () => {
    const insurance = VENDOR_RISK_QUESTIONS.find((q) => q.key === 'insurance')!;
    expect(insurance.date?.label).toBe('Date on the certificate');
    expect(JSON.stringify(insurance)).not.toMatch(/cover ends/i);
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
