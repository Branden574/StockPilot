/**
 * TEST HELPER: a small model of the ClickHouse functions the refused sign-ins
 * reader's two queries use (server/security/auth-logs.ts), so a test can run
 * a query's OWN TEXT on one made-up log line: whether its WHERE keeps the
 * line, and what its SELECT answers for the kind, the caller class, the
 * network class and the country.
 *
 * Only row-level functions are modelled, with ClickHouse's rules where they
 * matter here: a map answers '' for a missing key; position counts from 1
 * and answers 0 when the needle is absent; decodeURLComponent decodes %XX and
 * leaves a malformed escape and a '+' as they are; match is a search and
 * extract answers its first group, or '' when nothing matches (the patterns
 * used mean the same in RE2 and in JavaScript); WITH and SELECT aliases can
 * be used anywhere in the query. Aggregates are not evaluated. Any other
 * function, operator or syntax is an error, so a query that grows something
 * this model does not know fails its tests instead of passing them untested.
 *
 * Nothing here runs against Supabase: the first real run of the reader is
 * what proves the queries against ClickHouse itself.
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

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IN', 'AS']);

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

  parseAll(): Node {
    const e = this.expr();
    if (this.at !== this.toks.length) throw new Error(`model: unread ${this.peek()?.v}`);
    return e;
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

/** `items` cut at top-level commas, each `<expression> AS <alias>`. */
function aliasedItems(text: string): Array<{ alias: string; node: Node }> {
  const parts: Tok[][] = [[]];
  let depth = 0;
  for (const t of tokenize(text)) {
    if (t.t === 'op' && (t.v === '(' || t.v === '[')) depth += 1;
    if (t.t === 'op' && (t.v === ')' || t.v === ']')) depth -= 1;
    if (depth === 0 && t.t === 'op' && t.v === ',') parts.push([]);
    else parts[parts.length - 1]!.push(t);
  }
  return parts.map((p) => {
    const as = p[p.length - 2];
    const alias = p[p.length - 1];
    if (as?.t !== 'id' || as.v !== 'AS' || alias?.t !== 'id') {
      throw new Error('model: an item without AS');
    }
    return { alias: alias.v, node: new Parser(p.slice(0, -2)).parseAll() };
  });
}

/** The WITH, SELECT and WHERE parts of one of the reader's queries. */
export function parseReaderQuery(sql: string) {
  const selectAt = sql.indexOf('\nSELECT\n');
  const fromAt = sql.indexOf('\nFROM logs\n');
  const whereAt = sql.indexOf('\nWHERE ');
  const groupAt = sql.indexOf('\nGROUP BY ');
  if (!sql.startsWith('WITH\n') || selectAt === -1 || fromAt === -1 || whereAt === -1) {
    throw new Error('model: not a query of the shape WITH .. SELECT .. FROM logs WHERE ..');
  }
  if (groupAt === -1 || !(selectAt < fromAt && fromAt < whereAt && whereAt < groupAt)) {
    throw new Error('model: the parts are not in the order WITH, SELECT, FROM, WHERE, GROUP BY');
  }
  return {
    withItems: aliasedItems(sql.slice('WITH\n'.length, selectAt)),
    selectItems: aliasedItems(sql.slice(selectAt + '\nSELECT\n'.length, fromAt)),
    where: new Parser(tokenize(sql.slice(whereAt + '\nWHERE '.length, groupAt))).parseAll(),
  };
}

/** Aggregates and time functions: never evaluated on one line. */
const NOT_ROW_LEVEL = new Set(['count', 'min', 'max', 'toString', 'toStartOfMinute']);

function decodeUrlComponent(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length;) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 3;
    } else {
      for (const b of new TextEncoder().encode(s[i]!)) bytes.push(b);
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const truthy = (v: Value) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : !!v);

/**
 * Runs one of the reader's queries on one log line: whether the WHERE keeps
 * it, and the value of each SELECT or WITH alias in `aliases` (row-level
 * ones only).
 */
export function runReaderQueryOnLine(
  sql: string,
  line: ModelLogLine,
  aliases: readonly string[],
): { kept: boolean; values: Record<string, Value> } {
  const q = parseReaderQuery(sql);
  const named = new Map<string, Node>();
  for (const item of [...q.withItems, ...q.selectItems]) {
    if (named.has(item.alias)) throw new Error(`model: alias ${item.alias} defined twice`);
    named.set(item.alias, item.node);
  }
  const memo = new Map<string, Value>();

  const text = (v: Value, fn: string) => {
    if (typeof v !== 'string') throw new Error(`model: ${fn} expects text`);
    return v;
  };

  const evaluate = (n: Node): Value => {
    switch (n.k) {
      case 'str':
        return n.v;
      case 'num':
        return n.v;
      case 'ref': {
        if (n.name === 'log_attributes') return line.attributes;
        if (n.name === 'source') return line.source;
        if (!named.has(n.name)) throw new Error(`model: unknown name ${n.name}`);
        if (!memo.has(n.name)) memo.set(n.name, evaluate(named.get(n.name)!));
        return memo.get(n.name)!;
      }
      case 'index': {
        const target = evaluate(n.target);
        const key = text(evaluate(n.index), 'a map key');
        if (typeof target !== 'object') throw new Error('model: index into something else');
        return Object.prototype.hasOwnProperty.call(target, key) ? target[key]! : '';
      }
      case 'call': {
        if (NOT_ROW_LEVEL.has(n.name)) throw new Error(`model: ${n.name} is not row-level`);
        const a = n.args;
        switch (n.name) {
          case 'if':
            return truthy(evaluate(a[0]!)) ? evaluate(a[1]!) : evaluate(a[2]!);
          case 'multiIf': {
            for (let i = 0; i + 1 < a.length; i += 2) {
              if (truthy(evaluate(a[i]!))) return evaluate(a[i + 1]!);
            }
            return evaluate(a[a.length - 1]!);
          }
          case 'match':
            return new RegExp(text(evaluate(a[1]!), 'match')).test(text(evaluate(a[0]!), 'match'));
          case 'extract': {
            const m = new RegExp(text(evaluate(a[1]!), 'extract')).exec(
              text(evaluate(a[0]!), 'extract'),
            );
            if (!m) return '';
            return m.length > 1 ? (m[1] ?? '') : m[0];
          }
          case 'position':
            return text(evaluate(a[0]!), 'position').indexOf(text(evaluate(a[1]!), 'position')) + 1;
          case 'startsWith':
            return text(evaluate(a[0]!), 'startsWith').startsWith(
              text(evaluate(a[1]!), 'startsWith'),
            );
          case 'decodeURLComponent':
            return decodeUrlComponent(text(evaluate(a[0]!), 'decodeURLComponent'));
          default:
            throw new Error(`model: function ${n.name} is not modelled`);
        }
      }
      case 'bin': {
        if (n.op === 'AND') return truthy(evaluate(n.l)) && truthy(evaluate(n.r));
        if (n.op === 'OR') return truthy(evaluate(n.l)) || truthy(evaluate(n.r));
        const l = evaluate(n.l);
        const r = evaluate(n.r);
        if (n.op === '=') return l === r;
        if (n.op === '!=') return l !== r;
        if (n.op === '>') return Number(l) > Number(r);
        throw new Error(`model: operator ${n.op}`);
      }
      case 'in': {
        const l = evaluate(n.l);
        return n.list.some((x) => evaluate(x) === l);
      }
      case 'not':
        return !truthy(evaluate(n.e));
    }
  };

  const kept = truthy(evaluate(q.where));
  const values: Record<string, Value> = {};
  for (const alias of aliases) {
    if (!named.has(alias)) throw new Error(`model: no alias ${alias}`);
    values[alias] = evaluate({ k: 'ref', name: alias });
  }
  return { kept, values };
}
