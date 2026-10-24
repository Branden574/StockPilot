/**
 * The scanner behind migration-grants.guard.test.ts (D1, explicit grants).
 *
 * It reads one migration file the way Postgres runs it and reports every
 * table, partitioned table, partition, view, materialized view, foreign table
 * and sequence the file creates in schema public, with the roles among anon,
 * authenticated and service_role that a later GRANT or REVOKE in the same
 * file names it for. The guard's header has the rules, the evidence behind
 * them and what to do when it fails.
 *
 * How it reads SQL, so that prose never counts as a statement:
 *   - comments (`--`, nested block comments), string constants ('...', E'...',
 *     $tag$...$tag$) and quoted identifiers are tokens, never code;
 *   - a file is split into statements at `;` outside parentheses (and outside
 *     a BEGIN ATOMIC body);
 *   - a DO block's body runs at migration time, so it is scanned as code, one
 *     PL/pgSQL statement after another; a function or procedure body runs
 *     later, if ever, and stays a string;
 *   - SQL inside a string (EXECUTE 'create table ...') is not seen. Dynamic
 *     SQL is the one creation form this scanner cannot check.
 *
 * Names follow Postgres: an unquoted identifier folds to lower case (ASCII
 * only, as in a UTF8 database), a quoted one keeps its case, both are cut to
 * 63 bytes, and an unqualified name is in public (the migration role's
 * search_path; a file that changes search_path is not modelled).
 */

export const API_ROLES = ['anon', 'authenticated', 'service_role'] as const;
export type ApiRole = (typeof API_ROLES)[number];

/** Migrations 0001-0401 predate the rule; every later file is checked. */
export const LAST_EXEMPT_MIGRATION = 401;

/** The Supabase CLI (2.117.0) applies a file in supabase/migrations only if
 *  its name matches this; it ignores every other file. */
export const MIGRATION_FILE = /^([0-9]+)_(.*)\.sql$/u;

/** True when the guard checks this file: the CLI applies it and it is not one
 *  of the four-digit 0001-0401 history files. A timestamped name such as
 *  `supabase migration new` writes is checked. */
export function isCheckedMigration(file: string): boolean {
  const match = MIGRATION_FILE.exec(file);
  if (!match) return false;
  const version = match[1]!;
  return !(version.length === 4 && Number(version) <= LAST_EXEMPT_MIGRATION);
}

export type ObjectKind =
  | 'table'
  | 'partitioned table'
  | 'partition'
  | 'view'
  | 'materialized view'
  | 'foreign table'
  | 'sequence';

/** The serial column whose implicit sequence this is. */
export interface SerialSource {
  table: string;
  column: string;
  type: string;
}

/** A public object the file creates and that still exists at its end. */
export interface CreatedObject {
  schema: string;
  name: string;
  /** `schema.name`, quoted where Postgres would need quotes. */
  qualified: string;
  kind: ObjectKind;
  /** The line of the statement (or column) that creates it. */
  line: number;
  serial?: SerialSource;
  /** The roles a GRANT or REVOKE after the creation names it for, sorted. */
  decided: ApiRole[];
}

export interface Finding {
  file: string;
  line: number;
  kind: ObjectKind;
  object: string;
  serial?: SerialSource;
  missing: ApiRole[];
}

export interface FileScan {
  file: string;
  objects: CreatedObject[];
  findings: Finding[];
  /** The file has a GRANT or REVOKE ... ON ALL TABLES|SEQUENCES IN SCHEMA,
   *  which names no object and so decides nothing here. */
  schemaWideGrant: boolean;
}

export class MigrationScanError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'MigrationScanError';
    this.line = line;
  }
}

/* ─── tokens ──────────────────────────────────────────────────────────── */

type LexemeKind = 'word' | 'ident' | 'string' | 'number' | 'punct' | 'op' | 'param';

interface Lexeme {
  kind: LexemeKind;
  /** word: as written; ident: the name between the quotes; string: the
   *  contents; anything else: as written. */
  text: string;
  line: number;
}

/** Postgres lets any non-ASCII character into an identifier or a $tag$. */
const nonAscii = (ch: string): boolean => ch.charCodeAt(0) >= 0x80;
const isIdentStart = (ch: string): boolean => /[A-Za-z_]/.test(ch) || nonAscii(ch);
const isIdentCont = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch) || nonAscii(ch);
const isTagStart = (ch: string): boolean => /[A-Za-z_]/.test(ch) || nonAscii(ch);
const isTagCont = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch) || nonAscii(ch);
const DIGIT = /[0-9]/;
const OPERATOR_CHARS = '+-*/<>=~!@#%^&|`?';
const PUNCTUATION = '(),;[].:';

/** The `$tag$` that opens a dollar-quoted string at `at`, or null. */
function dollarTag(text: string, at: number): string | null {
  let k = at + 1;
  if (text.charAt(k) === '$') return '$$';
  if (!isTagStart(text.charAt(k))) return null;
  k += 1;
  while (k < text.length && isTagCont(text.charAt(k))) k += 1;
  return text.charAt(k) === '$' ? text.slice(at, k + 1) : null;
}

function tokenize(text: string, firstLine: number): Lexeme[] {
  const tokens: Lexeme[] = [];
  const n = text.length;
  let i = 0;
  let line = firstLine;

  const moveTo = (end: number): void => {
    for (let k = i; k < end; k += 1) if (text.charCodeAt(k) === 10) line += 1;
    i = end;
  };

  /** A '...' constant opening at `at`; E'...' resolves backslash escapes. */
  const readString = (at: number, backslashEscapes: boolean): void => {
    const startLine = line;
    let k = at + 1;
    let out = '';
    for (;;) {
      if (k >= n) throw new MigrationScanError('an unterminated string constant', startLine);
      const ch = text.charAt(k);
      if (backslashEscapes && ch === '\\') {
        out += text.charAt(k + 1);
        k += 2;
        continue;
      }
      if (ch === "'") {
        if (text.charAt(k + 1) === "'") {
          out += "'";
          k += 2;
          continue;
        }
        break;
      }
      out += ch;
      k += 1;
    }
    i = at;
    moveTo(k + 1);
    tokens.push({ kind: 'string', text: out, line: startLine });
  };

  /** A "..." identifier opening at `at`. */
  const readQuotedIdent = (at: number): void => {
    const startLine = line;
    let k = at + 1;
    let out = '';
    for (;;) {
      if (k >= n) throw new MigrationScanError('an unterminated quoted identifier', startLine);
      const ch = text.charAt(k);
      if (ch === '"') {
        if (text.charAt(k + 1) === '"') {
          out += '"';
          k += 2;
          continue;
        }
        break;
      }
      out += ch;
      k += 1;
    }
    i = at;
    moveTo(k + 1);
    tokens.push({ kind: 'ident', text: out, line: startLine });
  };

  while (i < n) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i += 1;
      continue;
    }
    if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const startLine = line;
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (text.startsWith('/*', k)) {
          depth += 1;
          k += 2;
        } else if (text.startsWith('*/', k)) {
          depth -= 1;
          k += 2;
        } else {
          k += 1;
        }
      }
      if (depth > 0) throw new MigrationScanError('an unterminated /* comment', startLine);
      moveTo(k);
      continue;
    }
    if (c === "'") {
      readString(i, false);
      continue;
    }
    if (c === '"') {
      readQuotedIdent(i);
      continue;
    }
    if (c === '$') {
      if (DIGIT.test(next)) {
        let k = i + 1;
        while (k < n && DIGIT.test(text.charAt(k))) k += 1;
        tokens.push({ kind: 'param', text: text.slice(i, k), line });
        i = k;
        continue;
      }
      const tag = dollarTag(text, i);
      if (tag !== null) {
        const startLine = line;
        const end = text.indexOf(tag, i + tag.length);
        if (end < 0) throw new MigrationScanError(`an unterminated ${tag} string`, startLine);
        tokens.push({ kind: 'string', text: text.slice(i + tag.length, end), line: startLine });
        moveTo(end + tag.length);
        continue;
      }
    }
    if (isIdentStart(c)) {
      let k = i + 1;
      while (k < n && isIdentCont(text.charAt(k))) k += 1;
      const word = text.slice(i, k);
      const after = text.charAt(k);
      // E'...', B'...', X'...', N'...': a prefixed string constant.
      if (after === "'" && /^[eEbBxXnN]$/.test(word)) {
        readString(k, word === 'e' || word === 'E');
        continue;
      }
      // U&'...' and U&"...": unicode-escape forms.
      if ((word === 'u' || word === 'U') && after === '&') {
        const quote = text.charAt(k + 1);
        if (quote === "'") {
          readString(k + 1, false);
          continue;
        }
        if (quote === '"') {
          readQuotedIdent(k + 1);
          continue;
        }
      }
      tokens.push({ kind: 'word', text: word, line });
      i = k;
      continue;
    }
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(next))) {
      let k = i + 1;
      while (k < n && /[0-9A-Za-z_.]/.test(text.charAt(k))) {
        if (text.startsWith('..', k)) break; // a PL/pgSQL range, 1..10
        k += 1;
      }
      tokens.push({ kind: 'number', text: text.slice(i, k), line });
      i = k;
      continue;
    }
    if (PUNCTUATION.includes(c)) {
      tokens.push({ kind: 'punct', text: c, line });
      i += 1;
      continue;
    }
    if (OPERATOR_CHARS.includes(c)) {
      let k = i + 1;
      while (
        k < n &&
        OPERATOR_CHARS.includes(text.charAt(k)) &&
        !text.startsWith('--', k) &&
        !text.startsWith('/*', k)
      ) {
        k += 1;
      }
      tokens.push({ kind: 'op', text: text.slice(i, k), line });
      i = k;
      continue;
    }
    tokens.push({ kind: 'op', text: c, line });
    i += 1;
  }
  return tokens;
}

/* ─── token helpers ───────────────────────────────────────────────────── */

const keyword = (t: Lexeme | undefined): string => (t?.kind === 'word' ? t.text.toUpperCase() : '');
const isWord = (t: Lexeme | undefined, ...words: string[]): boolean => words.includes(keyword(t));
const isPunct = (t: Lexeme | undefined, p: string): boolean => t?.kind === 'punct' && t.text === p;
const isOpen = (t: Lexeme | undefined): boolean => isPunct(t, '(') || isPunct(t, '[');
const isClose = (t: Lexeme | undefined): boolean => isPunct(t, ')') || isPunct(t, ']');

/** Postgres folds unquoted identifiers with ASCII rules in a UTF8 database. */
const foldAscii = (s: string): string => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());

const utf8Length = (ch: string): number => {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
};

/** The longest prefix of `s` that fits in `max` bytes of UTF-8, never
 *  splitting a character (Postgres's pg_mbcliplen). */
function clipBytes(s: string, max: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const len = utf8Length(ch);
    if (bytes + len > max) break;
    bytes += len;
    out += ch;
  }
  return out;
}

const byteLength = (s: string): number => {
  let bytes = 0;
  for (const ch of s) bytes += utf8Length(ch);
  return bytes;
};

/** NAMEDATALEN - 1: Postgres cuts every identifier to this many bytes. */
const MAX_IDENTIFIER_BYTES = 63;

/** The identifier a word or quoted-identifier token names, or null. */
function identOf(t: Lexeme | undefined): string | null {
  if (t?.kind === 'ident') return clipBytes(t.text, MAX_IDENTIFIER_BYTES);
  if (t?.kind === 'word') return clipBytes(foldAscii(t.text), MAX_IDENTIFIER_BYTES);
  return null;
}

/** An identifier as Postgres would print it: bare when it is a plain
 *  lower-case name, in double quotes otherwise. */
export function displayIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

const qualify = (schema: string, name: string): string =>
  `${displayIdent(schema)}.${displayIdent(name)}`;

interface RelationRef {
  schema: string;
  name: string;
  /** Index of the first token after the name. */
  end: number;
}

/** The dotted identifiers at `start`, e.g. `a.b.c`. */
function parseDottedName(stmt: Lexeme[], start: number): { parts: string[]; end: number } | null {
  const parts: string[] = [];
  let k = start;
  for (;;) {
    const id = identOf(stmt[k]);
    if (id === null) return null;
    parts.push(id);
    k += 1;
    if (!isPunct(stmt[k], '.')) return { parts, end: k };
    k += 1;
  }
}

/** `name`, `schema.name` or `database.schema.name` at `start`. */
function parseRelation(stmt: Lexeme[], start: number): RelationRef | null {
  const dotted = parseDottedName(stmt, start);
  if (!dotted || dotted.parts.length > 3) return null;
  const { parts } = dotted;
  const name = parts[parts.length - 1]!;
  const schema = parts.length >= 2 ? parts[parts.length - 2]! : 'public';
  return { schema, name, end: dotted.end };
}

/** The table of an `OWNED BY [schema.]table.column` at `start`, as a key;
 *  null for OWNED BY NONE. */
function ownerTableKey(stmt: Lexeme[], start: number): string | null {
  const dotted = parseDottedName(stmt, start);
  if (!dotted || dotted.parts.length < 2 || dotted.parts.length > 3) return null;
  const { parts } = dotted;
  const table = parts[parts.length - 2]!;
  const schema = parts.length === 3 ? parts[0]! : 'public';
  return qualify(schema, table);
}

/** The index just after `OWNED BY` at bracket depth 0 from `from`, or -1. */
function ownedByAt(stmt: Lexeme[], from: number): number {
  let depth = 0;
  for (let k = from; k < stmt.length; k += 1) {
    if (isOpen(stmt[k])) depth += 1;
    else if (isClose(stmt[k])) depth -= 1;
    else if (depth === 0 && isWord(stmt[k], 'OWNED') && isWord(stmt[k + 1], 'BY')) return k + 2;
  }
  return -1;
}

/** Index of the bracket that closes the one opening at `open`. */
function closingBracket(stmt: Lexeme[], open: number): number {
  let depth = 0;
  for (let k = open; k < stmt.length; k += 1) {
    if (isOpen(stmt[k])) depth += 1;
    else if (isClose(stmt[k])) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return stmt.length;
}

/** The tokens in [from, to), split at commas outside brackets. */
function splitAtCommas(stmt: Lexeme[], from: number, to: number): Lexeme[][] {
  const parts: Lexeme[][] = [];
  let current: Lexeme[] = [];
  let depth = 0;
  for (let k = from; k < to; k += 1) {
    const t = stmt[k]!;
    if (isOpen(t)) depth += 1;
    else if (isClose(t)) depth -= 1;
    if (depth === 0 && isPunct(t, ',')) {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** Statements: split at `;` outside brackets and outside a BEGIN ATOMIC
 *  body (whose CASE ... END pairs nest inside it). */
function splitStatements(tokens: Lexeme[]): Lexeme[][] {
  const statements: Lexeme[][] = [];
  let current: Lexeme[] = [];
  let depth = 0;
  let atomic = 0;
  tokens.forEach((t, k) => {
    if (isOpen(t)) depth += 1;
    else if (isClose(t)) depth = Math.max(0, depth - 1);
    else if (atomic > 0 && isWord(t, 'CASE')) atomic += 1;
    else if (atomic > 0 && isWord(t, 'END')) atomic -= 1;
    else if (isWord(t, 'ATOMIC') && isWord(tokens[k - 1], 'BEGIN')) atomic = 1;
    if (isPunct(t, ';') && depth === 0 && atomic === 0) {
      if (current.length > 0) statements.push(current);
      current = [];
      return;
    }
    current.push(t);
  });
  if (current.length > 0) statements.push(current);
  return statements;
}

/* ─── names Postgres makes up ─────────────────────────────────────────── */

/** Postgres's makeObjectName: `name1_name2_label` in at most 63 bytes,
 *  shortening the longer of the two names first. */
export function makeObjectName(name1: string, name2: string, label: string): string {
  const available = MAX_IDENTIFIER_BYTES - (label.length + 2);
  let chars1 = byteLength(name1);
  let chars2 = byteLength(name2);
  while (chars1 + chars2 > available) {
    if (chars1 > chars2) chars1 -= 1;
    else chars2 -= 1;
  }
  return `${clipBytes(name1, chars1)}_${clipBytes(name2, chars2)}_${label}`;
}

const SERIAL_TYPES = new Set([
  'serial',
  'serial4',
  'bigserial',
  'serial8',
  'smallserial',
  'serial2',
]);
const TABLE_CONSTRAINT_STARTS = [
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'CHECK',
  'FOREIGN',
  'EXCLUDE',
  'LIKE',
];

/** `column serial ...` (or bigserial, smallserial, serial2/4/8): the column
 *  and its type. Postgres compares the unqualified type name exactly, so a
 *  quoted "serial" is one too and a qualified one is not. */
function serialColumn(element: Lexeme[]): { column: string; type: string; line: number } | null {
  const first = element[0];
  if (!first || isWord(first, ...TABLE_CONSTRAINT_STARTS)) return null;
  const column = identOf(first);
  const typeToken = element[1];
  if (column === null || typeToken === undefined || isPunct(element[2], '.')) return null;
  const type =
    typeToken.kind === 'word'
      ? foldAscii(typeToken.text)
      : typeToken.kind === 'ident'
        ? typeToken.text
        : null;
  return type !== null && SERIAL_TYPES.has(type) ? { column, type, line: first.line } : null;
}

/* ─── the model ───────────────────────────────────────────────────────── */

interface Tracked {
  schema: string;
  name: string;
  kind: ObjectKind;
  line: number;
  /** For a sequence a column owns: the key of the table. */
  owner?: string;
  serial?: SerialSource;
  decided: Set<ApiRole>;
}

/** What a file's statements have built so far (newScanState). */
export interface ScanState {
  objects: Map<string, Tracked>;
  schemaWideGrant: boolean;
}
type State = ScanState;

const API_ROLE_SET: ReadonlySet<string> = new Set(API_ROLES);
const isApiRole = (role: string): role is ApiRole => API_ROLE_SET.has(role);

function track(state: State, object: Omit<Tracked, 'decided'>, keepExisting: boolean): void {
  const key = qualify(object.schema, object.name);
  if (keepExisting && state.objects.has(key)) return;
  state.objects.set(key, { ...object, decided: new Set() });
}

function forget(state: State, key: string): void {
  state.objects.delete(key);
  for (const [k, o] of state.objects) if (o.owner === key) state.objects.delete(k);
}

/** The serial column's sequence: Postgres's ChooseRelationName, which adds
 *  1, 2, ... to the label while the name is taken. Only names this file
 *  created are known here. */
function trackSerialSequence(
  state: State,
  table: RelationRef,
  serial: { column: string; type: string; line: number },
  ifNotExists: boolean,
): void {
  const owner = qualify(table.schema, table.name);
  const base = makeObjectName(table.name, serial.column, 'seq');
  const existing = state.objects.get(qualify(table.schema, base));
  if (ifNotExists && existing?.owner === owner) return;
  let name = base;
  for (let pass = 1; state.objects.has(qualify(table.schema, name)); pass += 1) {
    name = makeObjectName(table.name, serial.column, `seq${pass}`);
  }
  track(
    state,
    {
      schema: table.schema,
      name,
      kind: 'sequence',
      line: serial.line,
      owner,
      serial: {
        table: displayIdent(table.name),
        column: displayIdent(serial.column),
        type: serial.type,
      },
    },
    false,
  );
}

/** TABLE, VIEW, MATERIALIZED VIEW, SEQUENCE or FOREIGN TABLE at `at`. */
function relationKeyword(stmt: Lexeme[], at: number): { kind: ObjectKind; next: number } | null {
  if (isWord(stmt[at], 'TABLE')) return { kind: 'table', next: at + 1 };
  if (isWord(stmt[at], 'VIEW')) return { kind: 'view', next: at + 1 };
  if (isWord(stmt[at], 'SEQUENCE')) return { kind: 'sequence', next: at + 1 };
  if (isWord(stmt[at], 'MATERIALIZED') && isWord(stmt[at + 1], 'VIEW'))
    return { kind: 'materialized view', next: at + 2 };
  if (isWord(stmt[at], 'FOREIGN') && isWord(stmt[at + 1], 'TABLE'))
    return { kind: 'foreign table', next: at + 2 };
  return null;
}

const skipIfNotExists = (stmt: Lexeme[], at: number): { next: number; present: boolean } =>
  isWord(stmt[at], 'IF') && isWord(stmt[at + 1], 'NOT') && isWord(stmt[at + 2], 'EXISTS')
    ? { next: at + 3, present: true }
    : { next: at, present: false };

const skipIfExists = (stmt: Lexeme[], at: number): number =>
  isWord(stmt[at], 'IF') && isWord(stmt[at + 1], 'EXISTS') ? at + 2 : at;

/** CREATE [OR REPLACE] [GLOBAL|LOCAL] [TEMP|TEMPORARY|UNLOGGED] [RECURSIVE]
 *  {TABLE|VIEW|MATERIALIZED VIEW|SEQUENCE|FOREIGN TABLE} [IF NOT EXISTS] name */
function onCreate(stmt: Lexeme[], at: number, state: State): void {
  let k = at + 1;
  let orReplace = false;
  if (isWord(stmt[k], 'OR') && isWord(stmt[k + 1], 'REPLACE')) {
    orReplace = true;
    k += 2;
  }
  let temporary = false;
  if (isWord(stmt[k], 'GLOBAL', 'LOCAL')) k += 1;
  if (isWord(stmt[k], 'TEMP', 'TEMPORARY')) {
    temporary = true;
    k += 1;
  } else if (isWord(stmt[k], 'UNLOGGED')) {
    k += 1;
  }
  if (isWord(stmt[k], 'RECURSIVE')) k += 1;
  const relation = relationKeyword(stmt, k);
  if (!relation || temporary) return;
  const ifNotExists = skipIfNotExists(stmt, relation.next);
  const ref = parseRelation(stmt, ifNotExists.next);
  if (!ref || ref.schema !== 'public') return;
  // CREATE OR REPLACE VIEW keeps an existing view and its grants; IF NOT
  // EXISTS leaves an existing object alone.
  const keepExisting = orReplace || ifNotExists.present;
  let kind = relation.kind;
  const serials: Array<{ column: string; type: string; line: number }> = [];
  if (kind === 'table') {
    let after = ref.end;
    if (isWord(stmt[after], 'PARTITION') && isWord(stmt[after + 1], 'OF')) {
      kind = 'partition';
    } else if (isOpen(stmt[after])) {
      const close = closingBracket(stmt, after);
      for (const element of splitAtCommas(stmt, after + 1, close)) {
        const serial = serialColumn(element);
        if (serial) serials.push(serial);
      }
      after = close + 1;
    }
    if (kind === 'table') {
      let depth = 0;
      for (let j = after; j < stmt.length; j += 1) {
        if (isOpen(stmt[j])) depth += 1;
        else if (isClose(stmt[j])) depth -= 1;
        else if (depth === 0 && isWord(stmt[j], 'PARTITION') && isWord(stmt[j + 1], 'BY')) {
          kind = 'partitioned table';
          break;
        }
      }
    }
  }
  let owner: string | null = null;
  if (kind === 'sequence') {
    const ownedBy = ownedByAt(stmt, ref.end);
    if (ownedBy >= 0) owner = ownerTableKey(stmt, ownedBy);
  }
  track(
    state,
    { schema: ref.schema, name: ref.name, kind, line: stmt[at]!.line, ...(owner ? { owner } : {}) },
    keepExisting,
  );
  for (const serial of serials) trackSerialSequence(state, ref, serial, ifNotExists.present);
}

/** After ON: TABLE, SEQUENCE or another object-kind word, unless the word is
 *  itself the relation's name (followed by TO, FROM, a comma or a dot), as
 *  Postgres's grammar reads `ON sequence TO anon`. */
const kindWordAt = (stmt: Lexeme[], at: number, ...words: string[]): boolean =>
  isWord(stmt[at], ...words) &&
  !isWord(stmt[at + 1], 'TO', 'FROM') &&
  !isPunct(stmt[at + 1], ',') &&
  !isPunct(stmt[at + 1], '.');

/** GRANT ... ON [TABLE|SEQUENCE] names TO roles, and REVOKE [GRANT OPTION
 *  FOR] ... ON ... FROM roles. Column privileges count: they name the
 *  object. REVOKE GRANT OPTION FOR does not: it leaves the privilege. */
function onPrivileges(stmt: Lexeme[], at: number, state: State, revoke: boolean): void {
  let k = at + 1;
  let grantOptionOnly = false;
  if (
    revoke &&
    isWord(stmt[k], 'GRANT') &&
    isWord(stmt[k + 1], 'OPTION') &&
    isWord(stmt[k + 2], 'FOR')
  ) {
    grantOptionOnly = true;
    k += 3;
  }
  // The privilege list (column lists in brackets) runs to ON. A GRANT with
  // no ON grants role membership.
  let depth = 0;
  for (; k < stmt.length; k += 1) {
    if (isOpen(stmt[k])) depth += 1;
    else if (isClose(stmt[k])) depth -= 1;
    else if (depth === 0 && isWord(stmt[k], 'ON')) break;
  }
  if (k >= stmt.length) return;
  k += 1;
  if (isWord(stmt[k], 'ALL') && isWord(stmt[k + 1], 'TABLES', 'SEQUENCES')) {
    state.schemaWideGrant = true;
    return;
  }
  if (kindWordAt(stmt, k, 'TABLE', 'SEQUENCE')) {
    k += 1;
  } else if (
    kindWordAt(
      stmt,
      k,
      'ALL',
      'FUNCTION',
      'PROCEDURE',
      'ROUTINE',
      'SCHEMA',
      'DATABASE',
      'DOMAIN',
      'TYPE',
      'LANGUAGE',
      'LARGE',
      'FOREIGN',
      'TABLESPACE',
      'PARAMETER',
    )
  ) {
    return;
  }
  const keys: string[] = [];
  for (;;) {
    const ref = parseRelation(stmt, k);
    if (!ref) return;
    keys.push(qualify(ref.schema, ref.name));
    k = ref.end;
    if (!isPunct(stmt[k], ',')) break;
    k += 1;
  }
  if (!isWord(stmt[k], revoke ? 'FROM' : 'TO')) return;
  k += 1;
  const roles: string[] = [];
  for (;;) {
    if (isWord(stmt[k], 'GROUP')) k += 1;
    const role = identOf(stmt[k]);
    if (role === null) break;
    roles.push(role);
    k += 1;
    if (!isPunct(stmt[k], ',')) break;
    k += 1;
  }
  if (grantOptionOnly) return;
  for (const key of keys) {
    const object = state.objects.get(key);
    if (!object) continue;
    for (const role of roles) if (isApiRole(role)) object.decided.add(role);
  }
}

/** DROP {TABLE|VIEW|MATERIALIZED VIEW|SEQUENCE|FOREIGN TABLE} [IF EXISTS]
 *  names: the objects (and the sequences their columns own) are gone. */
function onDrop(stmt: Lexeme[], at: number, state: State): void {
  const relation = relationKeyword(stmt, at + 1);
  if (!relation) return;
  let k = skipIfExists(stmt, relation.next);
  for (;;) {
    const ref = parseRelation(stmt, k);
    if (!ref) return;
    forget(state, qualify(ref.schema, ref.name));
    k = ref.end;
    if (!isPunct(stmt[k], ',')) return;
    k += 1;
  }
}

/** ALTER ... RENAME TO and SET SCHEMA follow the object; ALTER TABLE ... ADD
 *  [COLUMN] col serial makes a sequence. */
function onAlter(stmt: Lexeme[], at: number, state: State): void {
  const relation = relationKeyword(stmt, at + 1);
  if (!relation) return;
  let k = skipIfExists(stmt, relation.next);
  if (isWord(stmt[k], 'ONLY')) k += 1;
  const ref = parseRelation(stmt, k);
  if (!ref) return;
  k = ref.end;
  if (stmt[k]?.kind === 'op' && stmt[k]!.text === '*') k += 1;
  const key = qualify(ref.schema, ref.name);

  if (isWord(stmt[k], 'RENAME') && isWord(stmt[k + 1], 'TO')) {
    const to = identOf(stmt[k + 2]);
    const object = state.objects.get(key);
    if (to === null || !object) return;
    const newKey = qualify(ref.schema, to);
    state.objects.delete(key);
    state.objects.set(newKey, { ...object, name: to });
    for (const o of state.objects.values()) if (o.owner === key) o.owner = newKey;
    return;
  }
  if (isWord(stmt[k], 'SET') && isWord(stmt[k + 1], 'SCHEMA')) {
    const to = identOf(stmt[k + 2]);
    if (to === null || to === ref.schema || !state.objects.has(key)) return;
    // Out of public: no longer a public object. Owned sequences go along.
    forget(state, key);
    return;
  }
  if (relation.kind === 'sequence') {
    const ownedBy = ownedByAt(stmt, k);
    const object = state.objects.get(key);
    if (ownedBy < 0 || !object) return;
    const owner = ownerTableKey(stmt, ownedBy);
    if (owner) object.owner = owner;
    else delete object.owner;
    return;
  }
  if (relation.kind !== 'table' || ref.schema !== 'public') return;
  for (const action of splitAtCommas(stmt, k, stmt.length)) {
    if (!isWord(action[0], 'ADD')) continue;
    let j = 1;
    if (isWord(action[j], 'COLUMN')) j += 1;
    const ifNotExists = skipIfNotExists(action, j);
    const serial = serialColumn(action.slice(ifNotExists.next));
    if (serial) trackSerialSequence(state, ref, serial, ifNotExists.present);
  }
}

/** A top-level SELECT ... INTO [TEMP|UNLOGGED] [TABLE] name creates a table.
 *  (Inside PL/pgSQL, SELECT INTO sets variables and is not passed here.) */
function onSelectInto(stmt: Lexeme[], state: State): void {
  let depth = 0;
  for (let k = 0; k < stmt.length; k += 1) {
    const t = stmt[k];
    if (isOpen(t)) depth += 1;
    else if (isClose(t)) depth -= 1;
    else if (depth === 0 && isWord(t, 'INTO')) {
      if (isWord(stmt[k - 1], 'INSERT', 'MERGE')) return;
      let j = k + 1;
      if (isWord(stmt[j], 'GLOBAL', 'LOCAL')) j += 1;
      if (isWord(stmt[j], 'TEMP', 'TEMPORARY')) return;
      if (isWord(stmt[j], 'UNLOGGED')) j += 1;
      if (isWord(stmt[j], 'TABLE')) j += 1;
      const ref = parseRelation(stmt, j);
      if (!ref || ref.schema !== 'public') return;
      track(
        state,
        { schema: ref.schema, name: ref.name, kind: 'table', line: stmt[0]!.line },
        false,
      );
      return;
    }
  }
}

/** DO [LANGUAGE l] body [LANGUAGE l]: a plpgsql body runs now, so its
 *  statements count. */
function onDo(stmt: Lexeme[], at: number, state: State): void {
  let k = at + 1;
  const languageAt = (j: number): string => {
    const t = stmt[j];
    return t?.kind === 'string' ? foldAscii(t.text) : (identOf(t) ?? '');
  };
  let language = 'plpgsql';
  if (isWord(stmt[k], 'LANGUAGE')) {
    language = languageAt(k + 1);
    k += 2;
  }
  const body = stmt[k];
  if (body?.kind !== 'string') return;
  if (isWord(stmt[k + 1], 'LANGUAGE')) language = languageAt(k + 2);
  if (language !== 'plpgsql') return;
  scanStatements(splitStatements(tokenize(body.text, body.line)), state, true);
}

/** In a PL/pgSQL body a statement starts a chunk, or follows one of these
 *  (or a <<label>>). */
const PLPGSQL_STATEMENT_LEADS = ['BEGIN', 'THEN', 'ELSE', 'LOOP'];

function onStatement(stmt: Lexeme[], at: number, state: State, topLevel: boolean): void {
  switch (keyword(stmt[at])) {
    case 'CREATE':
      onCreate(stmt, at, state);
      break;
    case 'GRANT':
      onPrivileges(stmt, at, state, false);
      break;
    case 'REVOKE':
      onPrivileges(stmt, at, state, true);
      break;
    case 'DROP':
      onDrop(stmt, at, state);
      break;
    case 'ALTER':
      onAlter(stmt, at, state);
      break;
    case 'DO':
      onDo(stmt, at, state);
      break;
    case 'SELECT':
    case 'WITH':
      if (topLevel) onSelectInto(stmt, state);
      break;
    default:
      break;
  }
}

function scanStatements(statements: Lexeme[][], state: State, plpgsql: boolean): void {
  for (const stmt of statements) {
    if (!plpgsql) {
      onStatement(stmt, 0, state, true);
      continue;
    }
    stmt.forEach((_t, k) => {
      const previous = stmt[k - 1];
      const lead =
        k === 0 ||
        isWord(previous, ...PLPGSQL_STATEMENT_LEADS) ||
        (previous?.kind === 'op' && previous.text === '>>');
      if (lead) onStatement(stmt, k, state, false);
    });
  }
}

/* ─── entry points ────────────────────────────────────────────────────── */

/** The state a file's statements build. Pass the same state to several
 *  files to follow objects across them (the guard's history check). */
export function newScanState(): ScanState {
  return { objects: new Map(), schemaWideGrant: false };
}

export function scanInto(state: ScanState, sql: string): void {
  scanStatements(splitStatements(tokenize(sql, 1)), state, false);
}

export function createdObjects(state: ScanState): CreatedObject[] {
  return [...state.objects.values()]
    .map((o) => ({
      schema: o.schema,
      name: o.name,
      qualified: qualify(o.schema, o.name),
      kind: o.kind,
      line: o.line,
      ...(o.serial ? { serial: o.serial } : {}),
      decided: API_ROLES.filter((r) => o.decided.has(r)),
    }))
    .sort((a, b) => a.line - b.line || (a.qualified < b.qualified ? -1 : 1));
}

/** One migration file: what it creates in public, and each object some of
 *  anon, authenticated and service_role were never decided for. */
export function scanMigration(sql: string, file: string): FileScan {
  const state = newScanState();
  scanInto(state, sql);
  const objects = createdObjects(state);
  const findings: Finding[] = [];
  for (const o of objects) {
    const missing = API_ROLES.filter((r) => !o.decided.includes(r));
    if (missing.length === 0) continue;
    findings.push({
      file,
      line: o.line,
      kind: o.kind,
      object: o.qualified,
      ...(o.serial ? { serial: o.serial } : {}),
      missing,
    });
  }
  return { file, objects, findings, schemaWideGrant: state.schemaWideGrant };
}

/** `file:line: <kind> <object> has no GRANT or REVOKE for <roles>`. */
export function formatFinding(f: Finding): string {
  const what = f.serial
    ? `sequence ${f.object} (made by the ${f.serial.type} column ${f.serial.table}.${f.serial.column})`
    : `${f.kind} ${f.object}`;
  return `${f.file}:${f.line}: ${what} has no GRANT or REVOKE for ${f.missing.join(', ')}`;
}

/** What the guard prints for one file: a line per finding, and a pointer
 *  when the file has a schema-wide grant, which names no object. */
export function reportLines(scan: FileScan): string[] {
  const lines = scan.findings.map(formatFinding);
  if (lines.length > 0 && scan.schemaWideGrant) {
    lines.push(
      `${scan.file}: a GRANT or REVOKE ... ON ALL TABLES|SEQUENCES IN SCHEMA names no object, so it decides nothing here`,
    );
  }
  return lines;
}
