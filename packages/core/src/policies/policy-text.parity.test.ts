import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  POLICY_REMINDER_DAYS,
  POLICY_REMINDER_MIN_GAP_DAYS,
  POLICY_REMIND_NOW_EVERY_HOURS,
} from './policy-reminders';
import { POLICY_ADMIN_COPY } from './policy-copy';
import {
  FORBIDDEN_POLICY_CODE_POINTS,
  POLICY_ACK_METHODS,
  POLICY_BODY_MAX,
  POLICY_BODY_MAX_LINES,
  POLICY_CHANGES,
  POLICY_COMBINING_MARK_RANGES,
  POLICY_KINDS,
  POLICY_MARK_RUN_MAX,
  POLICY_STATUSES,
  POLICY_TITLE_MAX,
} from './policy-text';

/**
 * The core and migration 0482 hold the same rules: read the migration and
 * compare. A change to one side only fails here.
 */
const SQL = readFileSync(
  fileURLToPath(new URL('../../../../supabase/migrations/0482_org_policies.sql', import.meta.url)),
  'utf8',
);
const TEST_SQL = readFileSync(
  fileURLToPath(new URL('../../../../supabase/tests/0482_org_policies.test.sql', import.meta.url)),
  'utf8',
);
const fnBody = (name: string) => {
  const start = SQL.indexOf(`create function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const open = SQL.indexOf('$$', start);
  const close = SQL.indexOf('$$', open + 2);
  return SQL.slice(open + 2, close);
};

/** The ranges of a Postgres bracket expression made of \uXXXX and \UXXXXXXXX escapes. */
function bracketRanges(re: string): Array<[number, number]> {
  const cps = /\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})|(-)/g;
  const items: Array<number | '-'> = [];
  for (const m of re.matchAll(cps)) items.push(m[3] ? '-' : parseInt(m[1] ?? m[2]!, 16));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < items.length; i += 1) {
    const a = items[i] as number;
    if (items[i + 1] === '-') {
      out.push([a, items[i + 2] as number]);
      i += 2;
    } else out.push([a, a]);
  }
  return out;
}

describe('core and migration 0482 agree', () => {
  it('on the refused characters (both helpers use one bracket; NUL cannot be in Postgres text)', () => {
    for (const fn of ['_org_policy_title_problem', '_org_policy_body_problem']) {
      const m = fnBody(fn).match(/~ '\[([^\]]+)\]'/);
      expect(m, fn).not.toBeNull();
      const sqlRanges = bracketRanges(m![1]!);
      const core = FORBIDDEN_POLICY_CODE_POINTS.map(([lo, hi]) => [lo === 0 ? 1 : lo, hi]);
      expect(sqlRanges, fn).toEqual(core);
    }
  });

  it('on the combining marks: the same ranges in both helpers and in the core, more than 30 in a row refused', () => {
    for (const fn of ['_org_policy_title_problem', '_org_policy_body_problem']) {
      // One bracket written as string constants on consecutive lines (Postgres joins them).
      const m = fnBody(fn).match(/~ \(((?:'[^']*'\s*)+)\)\s*then 'too_many_marks'/);
      expect(m, fn).not.toBeNull();
      const pattern = [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]).join('');
      expect(pattern.startsWith('['), fn).toBe(true);
      expect(pattern.endsWith(`]{${POLICY_MARK_RUN_MAX + 1}}`), fn).toBe(true);
      expect(bracketRanges(pattern.slice(1, pattern.lastIndexOf(']'))), fn).toEqual(
        POLICY_COMBINING_MARK_RANGES.map(([lo, hi]) => [lo, hi]),
      );
    }
    // The pgTAP test's own copy (0482/141 and 142 check each range's ends in the database).
    const block = TEST_SQL.match(/regexp_split_to_table\(btrim\(((?:\s*'[^']*')+)\s*\), '\\s\+'\)/);
    expect(block).not.toBeNull();
    const tokens = [...block![1]!.matchAll(/'([^']*)'/g)]
      .map((x) => x[1])
      .join('')
      .trim()
      .split(/\s+/);
    expect(
      tokens.map((tok) => {
        const [lo, hi] = tok.split('-');
        return [parseInt(lo!, 16), parseInt(hi ?? lo!, 16)];
      }),
    ).toEqual(POLICY_COMBINING_MARK_RANGES.map(([lo, hi]) => [lo, hi]));
  });

  it('on the limits', () => {
    expect(fnBody('_org_policy_title_problem')).toContain(
      `char_length(p_title) > ${POLICY_TITLE_MAX} then 'too_long'`,
    );
    expect(fnBody('_org_policy_body_problem')).toContain(
      `char_length(p_body) > ${POLICY_BODY_MAX} then 'too_long'`,
    );
    const body = fnBody('_org_policy_body_problem');
    expect(body).toContain(
      `pg_catalog.char_length(p_body) - pg_catalog.char_length(pg_catalog.replace(p_body, E'\\n', '')) + 1 > ${POLICY_BODY_MAX_LINES}\n      then 'too_many_lines'`,
    );
    // The same order as policyBodyProblem: empty, too_long, too_many_lines, forbidden_character,
    // too_many_marks, not_normal_form; and policyTitleProblem's, without the lines.
    const at = (text: string, w: string) => text.indexOf(`then '${w}'`);
    const order = (text: string, words: string[]) => {
      for (let i = 1; i < words.length; i += 1) {
        expect(at(text, words[i - 1]!), words[i - 1]).toBeGreaterThan(-1);
        expect(at(text, words[i - 1]!), words[i]).toBeLessThan(at(text, words[i]!));
      }
    };
    order(body, [
      'empty',
      'too_long',
      'too_many_lines',
      'forbidden_character',
      'too_many_marks',
      'not_normal_form',
    ]);
    order(fnBody('_org_policy_title_problem'), [
      'empty',
      'too_long',
      'forbidden_character',
      'too_many_marks',
      'not_normal_form',
    ]);
  });

  it('on the name kept for a deleted account that had none', () => {
    expect(SQL).toContain(`'${POLICY_ADMIN_COPY.formerMemberNoName}'`);
  });

  it('on the kinds, the states, the changes and the methods', () => {
    const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
    expect(SQL).toContain(`check (kind in (${q(POLICY_KINDS)}))`);
    expect(SQL).toContain(`check (status in (${q(POLICY_STATUSES)}))`);
    expect(SQL).toContain(`check (method in (${q(POLICY_ACK_METHODS)}))`);
    expect(fnBody('org_policy_publish')).toContain(`p_change not in (${q(POLICY_CHANGES)})`);
    expect(fnBody('org_policy_acknowledge')).toContain(
      `p_method not in (${q(POLICY_ACK_METHODS)})`,
    );
    expect(fnBody('org_policy_save_draft')).toContain(`p_kind not in (${q(POLICY_KINDS)})`);
  });

  it('on the reminder schedule and Remind now', () => {
    const claim = fnBody('org_policy_reminders_claim');
    expect(claim).toContain(
      `c_days    constant integer[] := array[${POLICY_REMINDER_DAYS.join(', ')}];`,
    );
    expect(claim).toContain(
      `c_min_gap constant interval := interval '${POLICY_REMINDER_MIN_GAP_DAYS} days';`,
    );
    expect(SQL).toContain(`check (sent_count between 0 and ${POLICY_REMINDER_DAYS.length}`);
    const now = fnBody('org_policy_remind_now');
    expect(now).toContain(
      `v_p.last_remind_now_at > v_now - interval '${POLICY_REMIND_NOW_EVERY_HOURS} hours'`,
    );
  });

  it('on what is hashed', () => {
    expect(SQL).toContain(
      "check (text_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(title || E'\\n\\n' || body, 'UTF8')), 'hex'))",
    );
    expect(fnBody('org_policy_save_draft')).toContain(
      "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_title || E'\\n\\n' || p_body, 'UTF8')), 'hex')",
    );
  });
});
