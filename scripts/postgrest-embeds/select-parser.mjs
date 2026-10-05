/**
 * A parser for PostgREST `select=` strings, as supabase-js sends them.
 *
 * supabase-js removes every whitespace character outside double quotes before
 * it sends a select (PostgrestQueryBuilder.select), so a select written over
 * several lines reaches PostgREST as one line. normalizeSelect() does the
 * same, and parseSelect() reads the result with PostgREST's grammar:
 *
 *   field   = "*"
 *           | "..." embed                               (spread)
 *           | [alias ":"] embed
 *           | [alias ":"] column
 *   embed   = target { "!" token } "(" [ field { "," field } ] ")"
 *             a token is a hint (a foreign key name, a foreign key column or
 *             a junction table) or a join type ("inner", "left"), in
 *             either order; the target is a table, a view, a foreign key
 *             column of the parent or a foreign key constraint name
 *   column  = name { "->" key | "->>" key } [ "::" type ]
 *             [ "." aggregate "()" [ "::" type ] ]
 *           | "count()"
 *
 * Only what decides an embed's relationship matters here: its target, its
 * hint and its children. Anything else that parses is a column.
 *
 * `placeholder` names (see PLACEHOLDER_RE) stand for parts of a select the
 * static scanner could not resolve; they parse as ordinary names.
 */

export const PLACEHOLDER_RE = /^__dyn\d+__$/;
const JOIN_TYPES = new Set(['inner', 'left']);
const AGGREGATES = new Set(['count', 'sum', 'avg', 'max', 'min']);

export class SelectParseError extends Error {
  /** @param {string} message @param {string} input @param {number} at */
  constructor(message, input, at) {
    super(`${message} at ${at} in "${input.length > 160 ? `${input.slice(0, 160)}...` : input}"`);
    this.name = 'SelectParseError';
    this.input = input;
    this.at = at;
  }
}

/** Mirror supabase-js: drop whitespace outside double quotes. */
export function normalizeSelect(raw) {
  let quoted = false;
  let out = '';
  for (const ch of raw) {
    if (/\s/.test(ch) && !quoted) continue;
    if (ch === '"') quoted = !quoted;
    out += ch;
  }
  return out;
}

/**
 * @typedef {{ type: 'star' }} StarField
 * @typedef {{ type: 'column', alias: string | null, name: string }} ColumnField
 * @typedef {{
 *   type: 'embed',
 *   alias: string | null,
 *   target: string,
 *   hints: string[],
 *   joinType: string | null,
 *   spread: boolean,
 *   children: Field[],
 *   text: string,
 * }} EmbedField
 * @typedef {StarField | ColumnField | EmbedField} Field
 */

/**
 * Parse a select string. Throws SelectParseError when it is not one.
 * @param {string} raw
 * @returns {Field[]}
 */
export function parseSelect(raw) {
  const s = normalizeSelect(raw);
  let i = 0;

  const fail = (msg) => {
    throw new SelectParseError(msg, s, i);
  };

  function name() {
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) fail('unterminated quoted name');
      const n = s.slice(i + 1, end);
      i = end + 1;
      return n;
    }
    const m = /^[A-Za-z0-9_$]+/.exec(s.slice(i));
    if (!m) fail('expected a name');
    i += m[0].length;
    return m[0];
  }

  function fieldList(close) {
    /** @type {Field[]} */
    const fields = [];
    if (s[i] === close || (close === null && i >= s.length)) return fields;
    for (;;) {
      fields.push(field());
      if (s[i] === ',') {
        i += 1;
        continue;
      }
      break;
    }
    return fields;
  }

  function field() {
    const start = i;
    if (s[i] === '*') {
      i += 1;
      return /** @type {StarField} */ ({ type: 'star' });
    }
    let spread = false;
    if (s.startsWith('...', i)) {
      spread = true;
      i += 3;
    }
    let alias = null;
    let first = name();
    if (s[i] === ':' && s[i + 1] !== ':') {
      i += 1;
      alias = first;
      if (s.startsWith('...', i)) fail('a spread cannot be aliased');
      first = name();
    }
    // Embed: target { !token } ( ... )
    const tokens = [];
    let j = i;
    while (s[j] === '!') {
      i = j + 1;
      tokens.push(name());
      j = i;
    }
    if (s[i] === '(' && !(first === 'count' && s[i + 1] === ')' && tokens.length === 0)) {
      i += 1;
      const children = fieldList(')');
      if (s[i] !== ')') fail('expected ")"');
      i += 1;
      let joinType = null;
      const hints = [];
      // PostgREST takes the join type before or after the hint
      // (`x!fk!inner` and `x!inner!fk` both answer 200 on PostgREST 14).
      for (const t of tokens) {
        if (JOIN_TYPES.has(t)) {
          if (joinType) fail('two join types');
          joinType = t;
        } else {
          hints.push(t);
        }
      }
      if (hints.length > 1) fail('more than one hint');
      return /** @type {EmbedField} */ ({
        type: 'embed',
        alias,
        target: first,
        hints,
        joinType,
        spread,
        children,
        text: s.slice(start, i),
      });
    }
    if (tokens.length > 0) fail('"!" outside an embed');
    if (spread) fail('a spread must be an embed');
    // count()
    if (first === 'count' && s[i] === '(' && s[i + 1] === ')') {
      i += 2;
      castOpt();
      return /** @type {ColumnField} */ ({ type: 'column', alias, name: 'count()' });
    }
    // JSON path
    while (s.startsWith('->', i)) {
      i += s.startsWith('->>', i) ? 3 : 2;
      if (/^[0-9]/.test(s.slice(i))) {
        const m = /^[0-9]+/.exec(s.slice(i));
        i += m[0].length;
      } else {
        name();
      }
    }
    castOpt();
    // Aggregate: .sum() etc.
    if (s[i] === '.') {
      i += 1;
      const agg = name();
      if (!AGGREGATES.has(agg) || s[i] !== '(' || s[i + 1] !== ')') fail('expected an aggregate');
      i += 2;
      castOpt();
    }
    return /** @type {ColumnField} */ ({ type: 'column', alias, name: first });
  }

  function castOpt() {
    if (s.startsWith('::', i)) {
      i += 2;
      name();
    }
  }

  const fields = fieldList(null);
  if (i !== s.length) fail('unexpected character');
  return fields;
}

/**
 * Every embed in a parsed select, depth first, with its parent embed.
 * @param {Field[]} fields
 * @returns {Array<{ embed: EmbedField, parent: EmbedField | null, depth: number }>}
 */
export function listEmbeds(fields) {
  const out = [];
  const walk = (list, parent, depth) => {
    for (const f of list) {
      if (f.type !== 'embed') continue;
      out.push({ embed: f, parent, depth });
      walk(f.children, f, depth + 1);
    }
  };
  walk(fields, null, 0);
  return out;
}
