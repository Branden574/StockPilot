import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant (docket T24): a pgTAP pin that says a database function
 * writes nothing, or writes only what the pin names, reads the write forms of
 * the security invariant suite.
 *
 * The suite (supabase/tests/security_invariants.test.sql) keeps one pattern
 * for a write statement in a function body, the row of _sec_inv_writer_re:
 * INSERT INTO, MERGE INTO, DELETE FROM, TRUNCATE, and UPDATE [ONLY] of a
 * table in any schema, unqualified or quoted. Its control INV-30b proves the
 * pattern form by form on every database run. A per-migration test cannot
 * read that row (each pgTAP file is its own session), so it carries a copy.
 * This guard keeps the copies equal to the row, and refuses a new pin that
 * carries a narrower list of its own.
 *
 * What is read: every regular expression that follows `!~` or `!~*` on the
 * same line, in supabase/tests, other than in the suite itself. One that
 * names a write verb (insert, update, delete, merge, truncate) must be one
 * of:
 *   - the suite's whole pattern, or its UPDATE arm, byte for byte;
 *   - the bare word list of all five verbs, byte for byte (stricter: it
 *     refuses the word wherever it appears). Anything after the list makes it
 *     another pattern, which is listed below or refused;
 *   - a row-lock pin (FOR UPDATE and its relatives), which is not about
 *     writes;
 *   - a pattern listed below with its reason.
 * The UPDATE arm is also used through regexp_matches, to count statements;
 * the named files are checked for the form they are expected to carry.
 *
 * A pin written another way is refused, so that no pin goes unread: a write
 * verb in a pattern under `not (... ~ ...)`, `not like` and its relatives,
 * pgTAP's doesnt_match, doesnt_imatch, unalike or unialike, a regexp_matches
 * or regexp_count compared with zero, or `!~` with its pattern on a later
 * line. Write the pin with `!~` or `!~*` and the pattern on the same line.
 * The controls at the end plant one of each.
 *
 * The suite's UPDATE form reads a statement as far as its SET. The five named
 * files also keep the form they held before they took it, which refuses an
 * UPDATE that names public whatever follows the table; the last check keeps
 * the two side by side.
 */

const TESTS_DIR = path.resolve(__dirname, '../../../../supabase/tests');
const SUITE = 'security_invariants.test.sql';

function read(name: string): string {
  return readFileSync(path.join(TESTS_DIR, name), 'utf8');
}

const suiteRow = /insert into _sec_inv_writer_re \(re\) values\n {2}\(\$re\$(.*?)\$re\$\);/.exec(
  read(SUITE),
);
const FULL = suiteRow?.[1] ?? '';
const ARM = FULL.slice(FULL.indexOf('\\mupdate\\s+'));
const BARE = '\\m(insert|update|delete|merge|truncate)\\M';
/** The five bare verbs followed by whitespace: 0377's pin (LISTED). */
const BARE_THEN_SPACE = `${BARE}\\s`;

/** Files that carry the suite's whole pattern in a "writes nothing" pin. */
const WHOLE_PATTERN_FILES = [
  '0379_book_order_totals.test.sql',
  '0380_report_rpcs_caller_scope.test.sql',
  '0382_book_order_totals_charter_dates.test.sql',
];

/** Files that pin "these writes and nothing else" with the UPDATE arm. */
const UPDATE_ARM_FILES = ['0378_order_hold_stock.test.sql', '0383_revise_order_needed_by.test.sql'];

/** Files that refuse the five verbs as bare words. */
const BARE_WORD_FILES = [
  '0351_platform_member_activity.test.sql',
  '0377_order_readiness_facts.test.sql',
];

/**
 * The public-qualified form each of the five files held before it took the
 * suite's, kept beside it. `text` is exact.
 */
const EARLIER_FORMS: ReadonlyArray<{ file: string; text: string }> = [
  ...WHOLE_PATTERN_FILES.map((file) => ({
    file,
    text: "and p.prosrc !~* '\\mupdate\\s+public\\M'",
  })),
  {
    file: '0378_order_hold_stock.test.sql',
    text: "and p.prosrc !~* '\\mupdate\\s+(public\\.|only\\M)'",
  },
  {
    file: '0383_revise_order_needed_by.test.sql',
    text: "and (select count(*) from regexp_matches(p.prosrc, '\\mupdate\\s+public\\.', 'gi')) = 2",
  },
];

const EARLIER_FORM_WHY =
  'the form this pin held before it took the suite’s, kept beside it: it refuses an UPDATE that names public whatever follows the table, where the suite’s form reads an UPDATE as far as its SET';

/**
 * Patterns that name a write verb and are none of the shared forms, each with
 * the reason it may stay. `file` and `pattern` are exact.
 */
const LISTED: ReadonlyArray<{ file: string; pattern: string; why: string }> = [
  {
    file: '0378_order_hold_stock.test.sql',
    pattern: '\\m(delete\\s+from|truncate|merge\\s+into)\\M',
    why: 'the rest of a "these writes and nothing else" pin: the same assertion counts the one INSERT and refuses every UPDATE with the UPDATE arm',
  },
  {
    file: '0383_revise_order_needed_by.test.sql',
    pattern: '\\m(insert\\s+into|delete\\s+from|truncate|merge\\s+into)\\M',
    why: 'the rest of a "these writes and nothing else" pin: the same assertion counts the two UPDATEs with the UPDATE arm',
  },
  {
    file: '0372_exception_recount.test.sql',
    pattern: 'insert\\s+into\\s+public\\.cycle_count',
    why: 'pins one statement (the function starts a count through start_cycle_count, not by its own INSERT); it does not say the function writes nothing',
  },
  {
    file: '0378_order_hold_stock.test.sql',
    pattern: '\\mupdate\\s+(public\\.|only\\M)',
    why: EARLIER_FORM_WHY,
  },
  ...WHOLE_PATTERN_FILES.map((file) => ({
    file,
    pattern: '\\mupdate\\s+public\\M',
    why: EARLIER_FORM_WHY,
  })),
  {
    file: '0377_order_readiness_facts.test.sql',
    pattern: BARE_THEN_SPACE,
    why: 'the five bare verbs, each followed by whitespace: it refuses every write statement whose verb is followed by a space or a line end. Kept as the file wrote it; named here because a pattern that only begins with the bare list is its own pattern',
  },
];

const WRITE_VERB = /(?<![a-z_])(insert|update|delete|merge|truncate)(?![a-z_])/i;
const NOT_MATCH_OPERAND = /!~\*?\s*(?:\$(\w*)\$(.*?)\$\1\$|'((?:[^']|'')*)')/g;

/** A test file's name and text. The guard reads the real files; its controls plant their own. */
interface Source {
  file: string;
  text: string;
}

function testSources(): Source[] {
  return readdirSync(TESTS_DIR)
    .sort()
    .filter((file) => file.endsWith('.sql') && file !== SUITE)
    .map((file) => ({ file, text: read(file) }));
}

interface Pin {
  file: string;
  line: number;
  pattern: string;
}

/** Whether a pattern names a write verb. A class escape (\m, \s, \M) is not part of the word beside it. */
function namesWriteVerb(pattern: string): boolean {
  return WRITE_VERB.test(pattern.replace(/\\[A-Za-z]/g, ' '));
}

function writePins(sources: readonly Source[]): Pin[] {
  const pins: Pin[] = [];
  for (const { file, text } of sources) {
    text.split('\n').forEach((lineText, i) => {
      for (const m of lineText.matchAll(NOT_MATCH_OPERAND)) {
        const pattern = m[2] ?? m[3] ?? '';
        if (namesWriteVerb(pattern)) pins.push({ file, line: i + 1, pattern });
      }
    });
  }
  return pins;
}

function isSharedForm(pattern: string): boolean {
  return pattern === FULL || pattern === ARM || pattern === BARE;
}

function isRowLockPin(pattern: string): boolean {
  return /^for\b/i.test(pattern);
}

function unlistedPins(sources: readonly Source[]): string[] {
  return writePins(sources)
    .filter(
      (p) =>
        !isSharedForm(p.pattern) &&
        !isRowLockPin(p.pattern) &&
        !LISTED.some((l) => l.file === p.file && l.pattern === p.pattern),
    )
    .map((p) => `${p.file}:${p.line}: ${p.pattern}`);
}

// ── Pins written another way ────────────────────────────────────────────

/** The SQL with `--` comments blanked (lengths and line numbers kept), string literals left as they are. */
function withoutLineComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      // A quoted literal: '' is a quote inside it.
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '$') {
      const tag = /^\$\w*\$/.exec(text.slice(i))?.[0];
      const end = tag ? text.indexOf(tag, i + tag.length) : -1;
      if (tag && end !== -1) {
        out += text.slice(i, end + tag.length);
        i = end + tag.length;
      } else {
        out += ch;
        i += 1;
      }
    } else if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The text of every string literal ('...' or $tag$...$tag$) in a piece of SQL. */
function literalsIn(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(/\$(\w*)\$([\s\S]*?)\$\1\$|'((?:[^']|'')*)'/g)) {
    out.push(m[2] ?? m[3] ?? '');
  }
  return out;
}

/**
 * The text between the parenthesis at `open` and its match, literals skipped
 * over, or as far as `limit` characters when it never closes.
 */
function parenthesized(sql: string, open: number, limit = 4000): string {
  let depth = 0;
  let i = open;
  const stop = Math.min(sql.length, open + limit);
  while (i < stop) {
    const ch = sql[i]!;
    if (ch === "'") {
      i += 1;
      while (i < stop && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
    } else if (ch === '$') {
      const tag = /^\$\w*\$/.exec(sql.slice(i))?.[0];
      const end = tag ? sql.indexOf(tag, i + tag.length) : -1;
      if (tag && end !== -1) i = end + tag.length - 1;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
    i += 1;
  }
  return sql.slice(open + 1, stop);
}

const HOW_TO_WRITE_A_PIN =
  'write the pin as `<body> !~* <pattern>` (or `!~`) with the pattern on the same line, using the write forms of _sec_inv_writer_re (security_invariants.test.sql) or the five bare verbs, so this guard reads it';

/**
 * Write pins this guard does not read as `!~` operands, by spelling. Each is
 * a pattern naming a write verb under a negation other than `!~` on one line.
 */
function otherSpellings(sources: readonly Source[]): string[] {
  const found: string[] = [];
  for (const { file, text } of sources) {
    const sql = withoutLineComments(text);
    const lineOf = (index: number) => sql.slice(0, index).split('\n').length;
    const add = (index: number, spelling: string, pattern: string) =>
      found.push(`${file}:${lineOf(index)}: ${spelling}: ${pattern}`);

    // pgTAP's negative matchers: doesnt_match, doesnt_imatch, unalike, unialike.
    for (const m of sql.matchAll(/\b(doesnt_i?match|uni?alike)\s*\(/gi)) {
      const open = m.index + m[0].length - 1;
      for (const lit of literalsIn(parenthesized(sql, open))) {
        if (namesWriteVerb(lit)) add(m.index, m[1]!.toLowerCase(), lit);
      }
    }

    // not ( ... ~ pattern ... ): a positive match under NOT.
    for (const m of sql.matchAll(/\bnot\s*\(/gi)) {
      const inner = parenthesized(sql, m.index + m[0].length - 1);
      for (const op of inner.matchAll(/(?<![!~])~\*?\s*(\$(\w*)\$[\s\S]*?\$\2\$|'(?:[^']|'')*')/g)) {
        for (const lit of literalsIn(op[1]!)) {
          if (namesWriteVerb(lit)) add(m.index, 'not (... ~ ...)', lit);
        }
      }
    }

    // not like, not ilike, not similar to, and the operators !~~ and !~~*.
    for (const m of sql.matchAll(
      /(\bnot\s+(?:i?like|similar\s+to)\b|!~~\*?)\s*(\$(\w*)\$[\s\S]*?\$\3\$|'(?:[^']|'')*')/gi,
    )) {
      for (const lit of literalsIn(m[2]!)) {
        if (namesWriteVerb(lit)) add(m.index, m[1]!.toLowerCase().replace(/\s+/g, ' '), lit);
      }
    }

    // regexp_matches or regexp_count compared with zero (or under NOT EXISTS).
    for (const m of sql.matchAll(/\bregexp_(matches|count)\s*\(/gi)) {
      const open = m.index + m[0].length - 1;
      const call = parenthesized(sql, open);
      const after = sql.slice(open + call.length + 2, open + call.length + 80);
      const before = sql.slice(Math.max(0, m.index - 200), m.index);
      const isZero =
        /^[\s)]*(=\s*0|<\s*1|<=\s*0)(?![\d.])/.test(after) ||
        /\bnot\s+exists\s*\(\s*select\b[^;]*$/i.test(before);
      if (!isZero) continue;
      for (const lit of literalsIn(call)) {
        if (namesWriteVerb(lit)) add(m.index, `regexp_${m[1]!.toLowerCase()} of zero`, lit);
      }
    }

    // !~ or !~* with nothing after it on its line: the pattern is on a later one.
    for (const m of sql.matchAll(/!~\*?[ \t]*\n\s*(\$(\w*)\$[\s\S]*?\$\2\$|'(?:[^']|'')*')/g)) {
      for (const lit of literalsIn(m[1]!)) {
        if (namesWriteVerb(lit)) add(m.index, '!~ with its pattern on a later line', lit);
      }
    }
  }
  return found;
}

describe('pgTAP write pins read the security invariant suite’s write forms', () => {
  it('finds the suite’s pattern and its UPDATE arm', () => {
    expect(FULL).toMatch(
      /^\\m\(insert\\s\+into\|merge\\s\+into\|delete\\s\+from\|truncate\)\\M\|\\mupdate\\s\+/,
    );
    expect(ARM).toMatch(/^\\mupdate\\s\+\(only\\s\*\\\(\?\\s\*\)\?/);
    expect(ARM.endsWith('\\s+set\\M')).toBe(true);
  });

  it('the named files carry the form they are expected to carry', () => {
    const missing: string[] = [];
    for (const f of WHOLE_PATTERN_FILES) {
      if (!read(f).includes(`!~* $w$${FULL}$w$`)) missing.push(`${f}: the whole pattern after !~*`);
    }
    for (const f of UPDATE_ARM_FILES) {
      if (!read(f).includes(`$w$${ARM}$w$`)) missing.push(`${f}: the UPDATE arm`);
    }
    for (const f of BARE_WORD_FILES) {
      const text = read(f);
    if (!text.includes(`!~* '${BARE}'`) && !text.includes(`!~* '${BARE_THEN_SPACE}'`)) {
      missing.push(`${f}: the five bare verbs after !~*`);
    }
    }
    expect(missing).toEqual([]);
  });

  it('no pin carries a narrower list of write forms of its own', () => {
    const sources = testSources();
    // The census is not empty: the named files alone hold five such operands.
    expect(writePins(sources).length).toBeGreaterThanOrEqual(5);
    expect(
      unlistedPins(sources),
      'use the write forms of _sec_inv_writer_re (security_invariants.test.sql), or list the pattern in LISTED with its reason',
    ).toEqual([]);
  });

  it('no pin is written in a spelling this guard does not read', () => {
    expect(otherSpellings(testSources()), HOW_TO_WRITE_A_PIN).toEqual([]);
  });

  it('every listed pattern is still in its file', () => {
    const pins = writePins(testSources());
    const stale = LISTED.filter(
      (l) => !pins.some((p) => p.file === l.file && p.pattern === l.pattern),
    ).map((l) => `${l.file}: ${l.pattern}`);
    expect(stale).toEqual([]);
  });

  it('the five named files keep the public-qualified form beside the suite’s', () => {
    const missing = EARLIER_FORMS.filter((e) => !read(e.file).includes(e.text)).map(
      (e) => `${e.file}: ${e.text}`,
    );
    expect(missing).toEqual([]);
  });
});

/**
 * Controls: one planted pin per case, in a file of its own that exists only
 * here. Each must be named; the forms the guard accepts must not be.
 */
describe('controls: a planted pin of each kind is named', () => {
  const planted = (sql: string): Source[] => [{ file: 'planted.test.sql', text: sql }];
  const BODY = "(select p.prosrc from pg_proc p where p.proname = 'sample_fn')";

  it('the shared forms and a row-lock pin are accepted', () => {
    for (const pattern of [FULL, ARM, BARE]) {
      const sql = `select ok(${BODY} !~* $w$${pattern}$w$, 'writes nothing');`;
      expect(unlistedPins(planted(sql)), pattern).toEqual([]);
      expect(otherSpellings(planted(sql)), pattern).toEqual([]);
    }
    const lock = `select ok(${BODY} !~* 'for\\s+update', 'takes no row lock');`;
    expect(unlistedPins(planted(lock))).toEqual([]);
  });

  it.each([
    ['the bare list followed by whitespace', `${BARE}\\s`],
    ['the bare list followed by INTO', `${BARE}\\s+into`],
    ['the bare list narrowed to one schema', `${BARE}\\s+public\\.`],
    ['the bare list with a lookahead', `${BARE}(?=\\s+into)`],
  ])('a pattern that only begins with the five bare verbs is its own pattern: %s', (_l, pattern) => {
    const sql = `select ok(${BODY} !~* '${pattern}', 'writes nothing');`;
    expect(unlistedPins(planted(sql))).toEqual([`planted.test.sql:1: ${pattern}`]);
  });

  it('the one listed pattern of that kind is accepted in its own file only', () => {
    const sql = `select ok(${BODY} !~* '${BARE_THEN_SPACE}', 'writes nothing');`;
    expect(unlistedPins([{ file: '0377_order_readiness_facts.test.sql', text: sql }])).toEqual([]);
    expect(unlistedPins(planted(sql))).toHaveLength(1);
  });

  const NARROW = '\\minsert\\s+into\\s+public\\.';
  it.each([
    ['doesnt_match', `select doesnt_match(${BODY}, '${NARROW}', 'writes nothing');`],
    ['doesnt_imatch', `select doesnt_imatch(\n  ${BODY},\n  '${NARROW}',\n  'writes nothing');`],
    ['unalike', `select unalike(${BODY}, '%insert into%', 'writes nothing');`],
    ['unialike', `select unialike(${BODY}, '%UPDATE %', 'writes nothing');`],
    ['not (... ~ ...)', `select ok(not (${BODY} ~ '${NARROW}'), 'writes nothing');`],
    ['not (... ~* ...)', `select ok(not (\n  ${BODY} ~* $re$${NARROW}$re$\n), 'writes nothing');`],
    ['not like', `select ok(${BODY} not like '%delete from%', 'writes nothing');`],
    ['not ilike', `select ok(${BODY} not ilike '%truncate%', 'writes nothing');`],
    ['!~~', `select ok(${BODY} !~~ '%merge into%', 'writes nothing');`],
    [
      'regexp_matches of zero',
      `select ok((select count(*) from regexp_matches(${BODY}, '${NARROW}', 'gi')) = 0, 'writes nothing');`,
    ],
    [
      'regexp_matches under not exists',
      `select ok(not exists (select 1 from regexp_matches(${BODY}, '${NARROW}', 'gi')), 'writes nothing');`,
    ],
    ['regexp_count of zero', `select ok(regexp_count(${BODY}, '${NARROW}') = 0, 'writes nothing');`],
    [
      '!~ with its pattern on a later line',
      `select ok(${BODY} !~*\n  '${NARROW}', 'writes nothing');`,
    ],
  ])('a pin written with %s is named, with how to write it', (_l, sql) => {
    const found = otherSpellings(planted(sql));
    expect(found.length, sql).toBeGreaterThanOrEqual(1);
    expect(found[0]).toMatch(/^planted\.test\.sql:\d+: /);
  });

  it('what is not a write pin is left alone', () => {
    for (const sql of [
      // A count of statements that is not zero: the UPDATE arm, counted.
      `select ok((select count(*) from regexp_matches(${BODY}, '\\mupdate\\s+public\\.', 'gi')) = 2, 'two updates');`,
      // A negation over something that names no write verb.
      `select ok(not (${BODY} ~ 'R0380-B'), 'no row of the other organization');`,
      `select unalike(${BODY}, '%secret%', 'no secret');`,
      // A positive match that names a verb.
      `select ok(${BODY} ~* '\\minsert\\s+into\\s+public\\.audit_logs', 'writes its audit row');`,
      // The spelling named only in a comment.
      `-- doesnt_match(prosrc, 'insert into') would not be read\nselect ok(true, 'placeholder');`,
      // An INSERT statement of the test itself beside a NOT LIKE on a value.
      `insert into _sc values (p.name, v not like 'ERR:%');`,
    ]) {
      expect(otherSpellings(planted(sql)), sql).toEqual([]);
    }
  });
});
