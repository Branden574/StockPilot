/**
 * TEST HELPER: a small model of the ClickHouse functions the refused sign-ins
 * reader's two queries use (server/security/auth-logs.ts), so a test can run
 * a query's OWN TEXT on one made-up log line: whether its WHERE parts keep
 * the line, and what its SELECTs answer for the kind, the form, the caller
 * class, the network class and the country.
 *
 * THE SHAPE IT READS is the one the logs endpoint was seen to accept: an
 * optional leading block comment, then nested selects,
 *   SELECT <items> FROM ( SELECT <items> FROM ( SELECT <items> FROM logs
 *   WHERE .. ) ) [WHERE ..] [GROUP BY ..] [ORDER BY ..] [LIMIT n]
 * A `WITH` list (which the endpoint's own parser refuses) is an error here
 * too. A level's expressions see only the columns of the select it reads
 * FROM (the innermost: the table's), never a name defined beside them, so a
 * query that leans on anything else fails its tests.
 *
 * Only row-level functions are modelled, with ClickHouse's rules where they
 * matter here: a map answers '' for a missing key; position counts from 1
 * and answers 0 when the needle is absent; lower changes ASCII letters only;
 * decodeURLComponent decodes %XX to a byte and leaves a malformed escape and
 * a '+' as they are; match is a search, extract answers its first group, or
 * '' when nothing matches, and replaceRegexpAll replaces every match (the
 * patterns used mean the same in RE2 and in JavaScript, with the two
 * differences written at re2Pattern below). Aggregates and time functions
 * are not evaluated. Any other function, operator or syntax is an error, so
 * a query that grows something this model does not know fails its tests
 * instead of passing them untested.
 *
 * Nothing here runs against Supabase: a run of the final text against the
 * real endpoint is what proves the queries against ClickHouse itself.
 */

type Tok = { t: 'str' | 'num' | 'id' | 'op'; v: string };

type Node =
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: 'ref'; name: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'index'; target: Node; index: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'in'; l: Node; list: Node[] }
  | { k: 'not'; e: Node };

type Value = string | number | boolean | Record<string, string>;

/** A log line as the reader's queries read it: the top-level source and the string map. */
export interface ModelLogLine {
  source: string;
  attributes: Record<string, string>;
}

/** One `<expression> AS <alias>` (a bare column name is its own alias). */
export interface ModelItem {
  alias: string;
  node: Node;
}

/** One SELECT of a nested query; `from` is the select it reads, or null for the table. */
export interface ModelSelect {
  items: ModelItem[];
  from: ModelSelect | null;
  where: Node | null;
  groupBy: string[];
  orderBy: Array<{ name: string; desc: boolean }>;
  limit: number | null;
}

/** Words of the statement: never a column or a function name. */
const KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IN',
  'AS',
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'ORDER',
  'BY',
  'LIMIT',
  'DESC',
  'ASC',
  'WITH',
]);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i += 1;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('model: unterminated comment');
      i = end + 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new Error('model: unterminated string');
      const text = src.slice(i + 1, end);
      if (text.includes('\\')) throw new Error('model: escapes in strings are not modelled');
      out.push({ t: 'str', v: text });
      i = end + 1;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+/.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if (src.startsWith('!=', i)) {
      out.push({ t: 'op', v: '!=' });
      i += 2;
    } else if ('()[],=>'.includes(c)) {
      out.push({ t: 'op', v: c });
      i += 1;
    } else {
      throw new Error(`model: character ${JSON.stringify(c)} is not modelled`);
    }
  }
  return out;
}

class Parser {
  private at = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.at];
  }
  private isOp(v: string) {
    const t = this.peek();
    return t?.t === 'op' && t.v === v;
  }
  private isKw(v: string) {
    const t = this.peek();
    return t?.t === 'id' && t.v === v;
  }
  private take(): Tok {
    const t = this.toks[this.at];
    if (!t) throw new Error('model: unexpected end');
    this.at += 1;
    return t;
  }
  private expectOp(v: string) {
    const t = this.take();
    if (t.t !== 'op' || t.v !== v) throw new Error(`model: expected ${v}, got ${t.v}`);
  }
  private expectKw(v: string) {
    const t = this.take();
    if (t.t !== 'id' || t.v !== v) throw new Error(`model: expected ${v}, got ${t.v}`);
  }
  private name(): string {
    const t = this.take();
    if (t.t !== 'id' || KEYWORDS.has(t.v)) throw new Error(`model: expected a name, got ${t.v}`);
    return t.v;
  }

  /** The whole statement: one (nested) select and nothing after it. */
  parseStatement(): ModelSelect {
    if (!this.isKw('SELECT')) {
      throw new Error(`model: a query starts with SELECT, not ${this.peek()?.v ?? 'nothing'}`);
    }
    const select = this.select();
    if (this.at !== this.toks.length) throw new Error(`model: unread ${this.peek()?.v}`);
    return select;
  }

  private select(): ModelSelect {
    this.expectKw('SELECT');
    const items: ModelItem[] = [this.item()];
    while (this.isOp(',')) {
      this.take();
      items.push(this.item());
    }
    this.expectKw('FROM');
    let from: ModelSelect | null = null;
    if (this.isOp('(')) {
      this.take();
      from = this.select();
      this.expectOp(')');
    } else if (this.name() !== 'logs') {
      throw new Error('model: the only table is logs');
    }
    const where = this.isKw('WHERE') ? (this.take(), this.expr()) : null;
    const groupBy: string[] = [];
    if (this.isKw('GROUP')) {
      this.take();
      this.expectKw('BY');
      groupBy.push(this.name());
      while (this.isOp(',')) {
        this.take();
        groupBy.push(this.name());
      }
    }
    const orderBy: ModelSelect['orderBy'] = [];
    if (this.isKw('ORDER')) {
      this.take();
      this.expectKw('BY');
      const one = () => {
        const name = this.name();
        const desc = this.isKw('DESC');
        if (desc) this.take();
        orderBy.push({ name, desc });
      };
      one();
      while (this.isOp(',')) {
        this.take();
        one();
      }
    }
    let limit: number | null = null;
    if (this.isKw('LIMIT')) {
      this.take();
      const t = this.take();
      if (t.t !== 'num') throw new Error('model: LIMIT takes a number');
      limit = Number(t.v);
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.alias)) throw new Error(`model: alias ${item.alias} defined twice`);
      seen.add(item.alias);
    }
    return { items, from, where, groupBy, orderBy, limit };
  }

  private item(): ModelItem {
    const node = this.expr();
    if (this.isKw('AS')) {
      this.take();
      return { alias: this.name(), node };
    }
    if (node.k !== 'ref') throw new Error('model: an expression without AS');
    return { alias: node.name, node };
  }

  private expr(): Node {
    let l = this.and();
    while (this.isKw('OR')) {
      this.take();
      l = { k: 'bin', op: 'OR', l, r: this.and() };
    }
    return l;
  }
  private and(): Node {
    let l = this.not();
    while (this.isKw('AND')) {
      this.take();
      l = { k: 'bin', op: 'AND', l, r: this.not() };
    }
    return l;
  }
  private not(): Node {
    if (this.isKw('NOT')) {
      this.take();
      return { k: 'not', e: this.not() };
    }
    return this.cmp();
  }
  private cmp(): Node {
    const l = this.postfix();
    const t = this.peek();
    if (t?.t === 'op' && ['=', '!=', '>'].includes(t.v)) {
      this.take();
      return { k: 'bin', op: t.v, l, r: this.postfix() };
    }
    if (this.isKw('IN')) {
      this.take();
      this.expectOp('(');
      const list = [this.expr()];
      while (this.isOp(',')) {
        this.take();
        list.push(this.expr());
      }
      this.expectOp(')');
      return { k: 'in', l, list };
    }
    return l;
  }
  private postfix(): Node {
    let e = this.primary();
    while (this.isOp('[')) {
      this.take();
      const index = this.expr();
      this.expectOp(']');
      e = { k: 'index', target: e, index };
    }
    return e;
  }
  private primary(): Node {
    const t = this.take();
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'num') return { k: 'num', v: Number(t.v) };
    if (t.t === 'op' && t.v === '(') {
      const e = this.expr();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'id' && !KEYWORDS.has(t.v)) {
      if (!this.isOp('(')) return { k: 'ref', name: t.v };
      this.take();
      const args: Node[] = [];
      if (!this.isOp(')')) {
        args.push(this.expr());
        while (this.isOp(',')) {
          this.take();
          args.push(this.expr());
        }
      }
      this.expectOp(')');
      return { k: 'call', name: t.v, args };
    }
    throw new Error(`model: unexpected ${t.v}`);
  }
}

/**
 * One of the reader's queries, read: its selects from the outermost
 * (`levels[0]`, whose items are what the query returns) to the innermost
 * (the one that reads the table). Every GROUP BY and ORDER BY name must be a
 * column the level returns or reads.
 */
export function parseReaderQuery(sql: string): {
  levels: ModelSelect[];
  /** What the query returns: the outermost select's items. */
  selectItems: ModelItem[];
} {
  const levels: ModelSelect[] = [];
  for (let s: ModelSelect | null = new Parser(tokenize(sql)).parseStatement(); s; s = s.from) {
    levels.push(s);
  }
  for (const level of levels) {
    const known = new Set([
      ...level.items.map((i) => i.alias),
      ...(level.from?.items.map((i) => i.alias) ?? []),
    ]);
    for (const name of [...level.groupBy, ...level.orderBy.map((o) => o.name)]) {
      if (!known.has(name)) throw new Error(`model: GROUP BY or ORDER BY names no column: ${name}`);
    }
  }
  return { levels, selectItems: levels[0]!.items };
}

/** Aggregates and time functions: never evaluated on one line. */
const NOT_ROW_LEVEL = new Set(['count', 'min', 'max', 'toString', 'toStartOfMinute']);

/** A byte that is not part of valid UTF-8 text is kept as one of these (U+DC80 to U+DCFF). */
const STRAY_BYTE_BASE = 0xdc00;
const STRAY_BYTES = '\\uDC80-\\uDCFF';

/**
 * Bytes as text: valid UTF-8 as its characters, and every byte that is not
 * part of valid UTF-8 as one stray-byte mark (never U+FFFD: ClickHouse keeps
 * the byte, it does not replace it).
 */
function textOfBytes(bytes: number[]): string {
  const strict = new TextDecoder('utf-8', { fatal: true });
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i]!;
    const length = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
    let char: string | null = null;
    if (length > 0 && i + length <= bytes.length) {
      try {
        char = strict.decode(new Uint8Array(bytes.slice(i, i + length)));
      } catch {
        char = null;
      }
    }
    if (char !== null && char.length > 0) {
      out += char;
      i += length;
    } else {
      out += String.fromCharCode(STRAY_BYTE_BASE + lead);
      i += 1;
    }
  }
  return out;
}

function decodeUrlComponent(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length;) {
    const hex = s.slice(i + 1, i + 3);
    const code = s.charCodeAt(i);
    if (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 3;
    } else if (code >= STRAY_BYTE_BASE + 0x80 && code <= STRAY_BYTE_BASE + 0xff) {
      bytes.push(code - STRAY_BYTE_BASE);
      i += 1;
    } else {
      const point = String.fromCodePoint(s.codePointAt(i)!);
      for (const b of new TextEncoder().encode(point)) bytes.push(b);
      i += point.length;
    }
  }
  return textOfBytes(bytes);
}

/**
 * An RE2 pattern as the JavaScript pattern that means the same on this
 * model's text. Two differences are written in:
 *   - RE2 reads the text as UTF-8, and no character class and no `.` of it
 *     matches a byte that is not part of valid UTF-8, so a match can never
 *     run across one. (Believed of RE2, and it fits what the real endpoint
 *     answered for a grant followed by such a byte on 2026-11-21; not proven
 *     beyond that.) Here every negated class and every `.` leaves the
 *     stray-byte marks out.
 *   - in ClickHouse a `.` also matches a line break.
 * The queries' patterns hold no backslash (the tokenizer refuses one), so a
 * `[` always opens a class and a `.` outside a class is always the wildcard.
 */
function re2Pattern(pattern: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (inClass) {
      out += c;
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
      if (pattern[i + 1] === '^') {
        out += `[^${STRAY_BYTES}`;
        i += 1;
      } else {
        out += c;
      }
    } else if (c === '.') {
      out += `[^${STRAY_BYTES}]`;
    } else {
      out += c;
    }
  }
  return out;
}

const truthy = (v: Value) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : !!v);

/**
 * Runs one of the reader's queries on one log line: whether every WHERE of
 * its selects keeps the line, and the value of each alias in `aliases`
 * (row-level ones only), read from the outermost select that defines it.
 */
export function runReaderQueryOnLine(
  sql: string,
  line: ModelLogLine,
  aliases: readonly string[],
): { kept: boolean; values: Record<string, Value> } {
  const { levels } = parseReaderQuery(sql);
  const memo = levels.map(() => new Map<string, Value>());

  const text = (v: Value, fn: string) => {
    if (typeof v !== 'string') throw new Error(`model: ${fn} expects text`);
    return v;
  };

  /** The value of the column `name` that the select at `depth` returns. */
  const column = (depth: number, name: string): Value => {
    const level = levels[depth]!;
    const item = level.items.find((i) => i.alias === name);
    if (!item) throw new Error(`model: unknown name ${name}`);
    const known = memo[depth]!;
    if (!known.has(name)) known.set(name, evaluate(item.node, depth));
    return known.get(name)!;
  };

  /** An expression of the select at `depth`: its names are the columns of the select it reads. */
  const evaluate = (n: Node, depth: number): Value => {
    const ev = (x: Node) => evaluate(x, depth);
    switch (n.k) {
      case 'str':
        return n.v;
      case 'num':
        return n.v;
      case 'ref': {
        if (depth + 1 < levels.length) return column(depth + 1, n.name);
        if (n.name === 'log_attributes') return line.attributes;
        if (n.name === 'source') return line.source;
        throw new Error(`model: unknown name ${n.name}`);
      }
      case 'index': {
        const target = ev(n.target);
        const key = text(ev(n.index), 'a map key');
        if (typeof target !== 'object') throw new Error('model: index into something else');
        return Object.prototype.hasOwnProperty.call(target, key) ? target[key]! : '';
      }
      case 'call': {
        if (NOT_ROW_LEVEL.has(n.name)) throw new Error(`model: ${n.name} is not row-level`);
        const a = n.args;
        switch (n.name) {
          case 'if':
            return truthy(ev(a[0]!)) ? ev(a[1]!) : ev(a[2]!);
          case 'multiIf': {
            for (let i = 0; i + 1 < a.length; i += 2) {
              if (truthy(ev(a[i]!))) return ev(a[i + 1]!);
            }
            return ev(a[a.length - 1]!);
          }
          case 'match':
            return new RegExp(re2Pattern(text(ev(a[1]!), 'match'))).test(text(ev(a[0]!), 'match'));
          case 'extract': {
            const m = new RegExp(re2Pattern(text(ev(a[1]!), 'extract'))).exec(
              text(ev(a[0]!), 'extract'),
            );
            if (!m) return '';
            return m.length > 1 ? (m[1] ?? '') : m[0];
          }
          case 'replaceRegexpAll': {
            const replacement = text(ev(a[2]!), 'replaceRegexpAll');
            if (/[$\\]/.test(replacement)) {
              throw new Error('model: a replacement that refers to the match is not modelled');
            }
            return text(ev(a[0]!), 'replaceRegexpAll').replace(
              new RegExp(re2Pattern(text(ev(a[1]!), 'replaceRegexpAll')), 'g'),
              () => replacement,
            );
          }
          case 'lower':
            return text(ev(a[0]!), 'lower').replace(/[A-Z]/g, (c) => c.toLowerCase());
          case 'position':
            return text(ev(a[0]!), 'position').indexOf(text(ev(a[1]!), 'position')) + 1;
          case 'startsWith':
            return text(ev(a[0]!), 'startsWith').startsWith(text(ev(a[1]!), 'startsWith'));
          case 'decodeURLComponent':
            return decodeUrlComponent(text(ev(a[0]!), 'decodeURLComponent'));
          default:
            throw new Error(`model: function ${n.name} is not modelled`);
        }
      }
      case 'bin': {
        if (n.op === 'AND') return truthy(ev(n.l)) && truthy(ev(n.r));
        if (n.op === 'OR') return truthy(ev(n.l)) || truthy(ev(n.r));
        const l = ev(n.l);
        const r = ev(n.r);
        if (n.op === '=') return l === r;
        if (n.op === '!=') return l !== r;
        if (n.op === '>') return Number(l) > Number(r);
        throw new Error(`model: operator ${n.op}`);
      }
      case 'in': {
        const l = ev(n.l);
        return n.list.some((x) => ev(x) === l);
      }
      case 'not':
        return !truthy(ev(n.e));
    }
  };

  // Innermost first, as the rows flow: a line a select drops reaches no outer one.
  let kept = true;
  for (let depth = levels.length - 1; depth >= 0 && kept; depth--) {
    const where = levels[depth]!.where;
    if (where) kept = truthy(evaluate(where, depth));
  }
  const values: Record<string, Value> = {};
  for (const alias of aliases) {
    const depth = levels.findIndex((level) => level.items.some((i) => i.alias === alias));
    if (depth === -1) throw new Error(`model: no alias ${alias}`);
    values[alias] = column(depth, alias);
  }
  return { kept, values };
}
