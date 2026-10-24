/**
 * The scanner behind migration-grants.guard.test.ts (D1, explicit grants).
 *
 * It reads one migration file the way Postgres runs it and reports every
 * table, partitioned table, partition, view, materialized view, foreign table
 * and sequence the file creates in schema public, with the privileges that
 * Supabase's 2026-10-30 change takes out of the default privileges (see
 * requiredPrivileges) and that no later GRANT or REVOKE in the same file
 * names for anon, authenticated or service_role. The guard's header has the
 * rules, the evidence behind them and what to do when it fails.
 *
 * How it reads SQL, so that prose never counts as a statement:
 *   - comments (`--`, nested block comments), string constants ('...', E'...',
 *     U&'...', $tag$...$tag$) and quoted identifiers ("...", U&"...") are
 *     tokens, never code; escapes are decoded as Postgres decodes them;
 *   - a file is split into statements at `;` outside parentheses (and outside
 *     a BEGIN ATOMIC body);
 *   - a DO block's body runs at migration time, so it is scanned as code, one
 *     PL/pgSQL statement after another; a function or procedure body runs
 *     later, if ever, and stays a string;
 *   - a statement EXPLAIN ANALYZE runs is read like the statement itself, and a
 *     parenthesized SELECT like the bare one;
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

/** The privileges the guard asks a migration to name. */
export type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'USAGE';

const TABLE_PRIVILEGES: readonly Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const SEQUENCE_PRIVILEGES: readonly Privilege[] = ['USAGE', 'SELECT'];

/**
 * What Supabase's change (changelog 45329) takes out of the default
 * privileges of a new object of this kind:
 *   revoke select, insert, update, delete on tables (tables, partitions,
 *     views, materialized views and foreign tables alike), and
 *   revoke usage, select on sequences.
 * The local stack and CI keep the old defaults (ALL), production loses these
 * on 2026-10-30, so an object ends with the same ACL in both only when every
 * one of these privileges is named, for each role, by a GRANT or a REVOKE
 * after it is created. TRUNCATE, REFERENCES, TRIGGER, MAINTAIN and a
 * sequence's UPDATE stay in both defaults, so they cannot differ.
 */
export function requiredPrivileges(kind: ObjectKind): readonly Privilege[] {
  return kind === 'sequence' ? SEQUENCE_PRIVILEGES : TABLE_PRIVILEGES;
}

/** The serial column whose implicit sequence this is. */
export interface SerialSource {
  table: string;
  column: string;
  type: string;
}

/** The required privileges no GRANT or REVOKE names for one role. */
export interface RoleGap {
  role: ApiRole;
  privileges: Privilege[];
}

/** A public object the file creates and that is in public at its end. */
export interface CreatedObject {
  schema: string;
  name: string;
  /** `schema.name`, quoted where Postgres would need quotes. */
  qualified: string;
  kind: ObjectKind;
  /** The line of the statement (or column) that creates it. */
  line: number;
  serial?: SerialSource;
  /** The roles for which a GRANT or REVOKE after the creation names every
   *  required privilege, in API_ROLES order. */
  decided: ApiRole[];
  /** Every other role, with the required privileges nothing names for it. */
  missing: RoleGap[];
}

export interface Finding {
  file: string;
  line: number;
  kind: ObjectKind;
  object: string;
  serial?: SerialSource;
  missing: RoleGap[];
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
  /** A U&"..." or U&'...' token whose escapes are still to be decoded (they
   *  depend on a UESCAPE clause that may follow it). */
  unicode?: boolean;
  /** A string whose decoded value has a different number of line breaks
   *  than the file (an escaped \n, say): lines inside it are not file lines. */
  linesMoved?: boolean;
}

const lineBreaks = (s: string): number => s.split('\n').length - 1;

const HEX = /[0-9A-Fa-f]/;
const isHex = (ch: string): boolean => ch.length === 1 && HEX.test(ch);

/** UTF-8 bytes back to text; a decoded constant is UTF-8, as the database. */
const utf8 = (bytes: number[]): string => new TextDecoder().decode(Uint8Array.from(bytes));
const utf8Bytes = (s: string): number[] => [...new TextEncoder().encode(s)];

const isHighSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdbff;
const isLowSurrogate = (cp: number): boolean => cp >= 0xdc00 && cp <= 0xdfff;

/**
 * Where decoded text goes, one escape at a time. A code point must be 1 to
 * 0x10FFFF (Postgres's check_unicode_value), and a UTF-16 surrogate pair (two
 * escapes in a row) joins into one character; a surrogate anywhere else is an
 * error, as in Postgres's lexer and str_udeescape.
 */
function decodedText(line: number, emit: (text: string) => void) {
  let high: number | null = null;
  const fail = (what: string): never => {
    throw new MigrationScanError(what, line);
  };
  const settled = (): void => {
    if (high !== null) fail('an invalid Unicode surrogate pair');
  };
  return {
    codePoint(cp: number): void {
      if (cp === 0 || cp > 0x10ffff) fail('an invalid Unicode escape value');
      if (isHighSurrogate(cp)) {
        settled();
        high = cp;
      } else if (isLowSurrogate(cp)) {
        if (high === null) fail('an invalid Unicode surrogate pair');
        emit(String.fromCodePoint(0x10000 + ((high! - 0xd800) << 10) + (cp - 0xdc00)));
        high = null;
      } else {
        settled();
        emit(String.fromCodePoint(cp));
      }
    },
    /** Anything that is not a code point escape; also checks no pair is open. */
    other(text: string): void {
      settled();
      emit(text);
    },
  };
}

/**
 * The value of an E'...' body, with Postgres's backslash escapes: \b \f \n \r
 * \t, \o \oo \ooo (octal byte), \xh \xhh (hex byte), \uXXXX and \UXXXXXXXX,
 * and \c for any other c.
 */
function decodeEscapeString(body: string, line: number): string {
  const bytes: number[] = [];
  const out = decodedText(line, (text) => bytes.push(...utf8Bytes(text)));
  const run = (from: number, max: number, digit: RegExp): string => {
    let k = from;
    while (k < body.length && k - from < max && digit.test(body.charAt(k))) k += 1;
    return body.slice(from, k);
  };
  const simple: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  for (let k = 0; k < body.length;) {
    const ch = body.charAt(k);
    if (ch !== '\\') {
      const text = String.fromCodePoint(body.codePointAt(k)!);
      out.other(text);
      k += text.length;
      continue;
    }
    const next = body.charAt(k + 1);
    const octal = run(k + 1, 3, /[0-7]/);
    const hex = next === 'x' ? run(k + 2, 2, HEX) : '';
    if (next in simple) {
      out.other(simple[next]!);
      k += 2;
    } else if (octal.length > 0) {
      out.other('');
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      k += 1 + octal.length;
    } else if (hex.length > 0) {
      out.other('');
      bytes.push(Number.parseInt(hex, 16));
      k += 2 + hex.length;
    } else if (next === 'u' || next === 'U') {
      const width = next === 'u' ? 4 : 8;
      const digits = run(k + 2, width, HEX);
      if (digits.length !== width) throw new MigrationScanError('an invalid Unicode escape', line);
      out.codePoint(Number.parseInt(digits, 16));
      k += 2 + width;
    } else {
      out.other(next);
      k += 2;
    }
  }
  out.other('');
  return utf8(bytes);
}

/**
 * The value of a U&"..." or U&'...' body: <escape><escape> is the escape
 * character itself, <escape>XXXX and <escape>+XXXXXX are code points. The
 * escape is a backslash unless a UESCAPE 'c' clause follows the token
 * (Postgres's str_udeescape).
 */
function decodeUnicodeEscapes(body: string, escape: string, line: number): string {
  if (escape.length !== 1 || /[0-9A-Fa-f+'"\s]/.test(escape)) {
    throw new MigrationScanError('an invalid UESCAPE character', line);
  }
  let text = '';
  const out = decodedText(line, (t) => (text += t));
  for (let k = 0; k < body.length;) {
    if (body.charAt(k) !== escape) {
      out.other(body.charAt(k));
      k += 1;
    } else if (body.charAt(k + 1) === escape) {
      out.other(escape);
      k += 2;
    } else {
      const plus = body.charAt(k + 1) === '+';
      const width = plus ? 6 : 4;
      const from = k + (plus ? 2 : 1);
      const digits = body.slice(from, from + width);
      if (digits.length !== width || ![...digits].every(isHex)) {
        throw new MigrationScanError('an invalid Unicode escape', line);
      }
      out.codePoint(Number.parseInt(digits, 16));
      k = from + width;
    }
  }
  out.other('');
  return text;
}

/** Decode each U& token, with the escape its UESCAPE clause names (the
 *  clause's two tokens are dropped) or a backslash. */
function resolveUnicodeTokens(tokens: Lexeme[]): Lexeme[] {
  const out: Lexeme[] = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k]!;
    if (!t.unicode) {
      out.push(t);
      continue;
    }
    let escape = '\\';
    const clause = tokens[k + 1];
    if (clause?.kind === 'word' && clause.text.toUpperCase() === 'UESCAPE') {
      const value = tokens[k + 2];
      if (value?.kind !== 'string') {
        throw new MigrationScanError('UESCAPE without a string constant', clause.line);
      }
      escape = value.text;
      k += 2;
    }
    const decoded = decodeUnicodeEscapes(t.text, escape, t.line);
    out.push({
      kind: t.kind,
      text: decoded,
      line: t.line,
      ...(lineBreaks(decoded) !== lineBreaks(t.text) ? { linesMoved: true } : {}),
    });
  }
  return out;
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

  /** A '...' constant opening at `at`; E'...' resolves backslash escapes. A
   *  U&'...' one (`unicode`) is decoded once its UESCAPE clause is known. */
  const readString = (at: number, backslashEscapes: boolean, unicode = false): void => {
    const startLine = line;
    let k = at + 1;
    let out = '';
    for (;;) {
      if (k >= n) throw new MigrationScanError('an unterminated string constant', startLine);
      const ch = text.charAt(k);
      if (backslashEscapes && ch === '\\') {
        // Kept as written: decodeEscapeString reads the pair.
        out += ch + text.charAt(k + 1);
        k += 2;
        continue;
      }
      if (ch === "'") {
        if (text.charAt(k + 1) === "'") {
          out += backslashEscapes ? "\\'" : "'";
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
    const value = backslashEscapes ? decodeEscapeString(out, startLine) : out;
    tokens.push({
      kind: 'string',
      text: value,
      line: startLine,
      ...(unicode ? { unicode } : {}),
      ...(lineBreaks(value) !== lineBreaks(out) ? { linesMoved: true } : {}),
    });
  };

  /** A "..." identifier opening at `at` (U&"..." when `unicode`). */
  const readQuotedIdent = (at: number, unicode = false): void => {
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
    tokens.push({ kind: 'ident', text: out, line: startLine, ...(unicode ? { unicode } : {}) });
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
      // U&'...' and U&"...": unicode-escape forms, decoded below.
      if ((word === 'u' || word === 'U') && after === '&') {
        const quote = text.charAt(k + 1);
        if (quote === "'") {
          readString(k + 1, false, true);
          continue;
        }
        if (quote === '"') {
          readQuotedIdent(k + 1, true);
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
  return resolveUnicodeTokens(tokens);
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

/** The table (as a key) and column of an `OWNED BY [schema.]table.column` at
 *  `start`; null for OWNED BY NONE. */
function ownerOf(stmt: Lexeme[], start: number): { owner: string; ownerColumn: string } | null {
  const dotted = parseDottedName(stmt, start);
  if (!dotted || dotted.parts.length < 2 || dotted.parts.length > 3) return null;
  const { parts } = dotted;
  const table = parts[parts.length - 2]!;
  const schema = parts.length === 3 ? parts[0]! : 'public';
  return { owner: qualify(schema, table), ownerColumn: parts[parts.length - 1]! };
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
  /** Where it is now: an object made in public stays tracked while a SET
   *  SCHEMA has it elsewhere, since it can come back. */
  schema: string;
  name: string;
  kind: ObjectKind;
  line: number;
  /** For a sequence a column owns: the key of the table, and the column
   *  (dropping either drops the sequence). */
  owner?: string;
  ownerColumn?: string;
  /** For a partition: the key of its parent (dropping it drops them). */
  partitionOf?: string;
  /** Made with PARTITION BY: a partitioned table, or a partition that is
   *  partitioned too. */
  partitioned?: boolean;
  serial?: SerialSource;
  /** Per role, the table-level privileges a GRANT or REVOKE after the
   *  creation named (ALL names each one). */
  named: Map<ApiRole, Set<string>>;
}

/** What a file's statements have built so far (newScanState). */
export interface ScanState {
  objects: Map<string, Tracked>;
  schemaWideGrant: boolean;
}
type State = ScanState;

const API_ROLE_SET: ReadonlySet<string> = new Set(API_ROLES);
const isApiRole = (role: string): role is ApiRole => API_ROLE_SET.has(role);

function track(state: State, object: Omit<Tracked, 'named'>, keepExisting: boolean): void {
  const key = qualify(object.schema, object.name);
  if (keepExisting && state.objects.has(key)) return;
  state.objects.set(key, { ...object, named: new Map() });
}

/** DROP: the object goes, with the sequences its columns own and, for a
 *  partitioned table, its partitions (and theirs). */
function forget(state: State, key: string): void {
  state.objects.delete(key);
  for (const [k, o] of [...state.objects]) {
    if (!state.objects.has(k)) continue;
    if (o.owner === key) state.objects.delete(k);
    else if (o.partitionOf === key) forget(state, k);
  }
}

/** ALTER ... SET SCHEMA: the object, and the sequences its columns own (as
 *  Postgres moves them), now live in `schema` under the same names. */
function move(state: State, key: string, schema: string): void {
  const object = state.objects.get(key);
  if (!object) return;
  const newKey = qualify(schema, object.name);
  state.objects.delete(key);
  state.objects.set(newKey, { ...object, schema });
  for (const [k, o] of [...state.objects]) {
    if (o.partitionOf === key) o.partitionOf = newKey;
    if (o.owner !== key) continue;
    state.objects.delete(k);
    state.objects.set(qualify(schema, o.name), { ...o, schema, owner: newKey });
  }
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
      ownerColumn: serial.column,
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
  let partitionOf: string | null = null;
  let partitioned = false;
  if (kind === 'table') {
    let after = ref.end;
    if (isWord(stmt[after], 'PARTITION') && isWord(stmt[after + 1], 'OF')) {
      kind = 'partition';
      const parent = parseRelation(stmt, after + 2);
      if (parent) {
        partitionOf = qualify(parent.schema, parent.name);
        after = parent.end;
      }
    } else if (isOpen(stmt[after])) {
      const close = closingBracket(stmt, after);
      for (const element of splitAtCommas(stmt, after + 1, close)) {
        const serial = serialColumn(element);
        if (serial) serials.push(serial);
      }
      after = close + 1;
    }
    let depth = 0;
    for (let j = after; j < stmt.length; j += 1) {
      if (isOpen(stmt[j])) depth += 1;
      else if (isClose(stmt[j])) depth -= 1;
      else if (depth === 0 && isWord(stmt[j], 'PARTITION') && isWord(stmt[j + 1], 'BY')) {
        partitioned = true;
        if (kind === 'table') kind = 'partitioned table';
        break;
      }
    }
  }
  let owner: { owner: string; ownerColumn: string } | null = null;
  if (kind === 'sequence') {
    const ownedBy = ownedByAt(stmt, ref.end);
    if (ownedBy >= 0) owner = ownerOf(stmt, ownedBy);
  }
  track(
    state,
    {
      schema: ref.schema,
      name: ref.name,
      kind,
      line: stmt[at]!.line,
      ...(owner ?? {}),
      ...(partitionOf ? { partitionOf } : {}),
      ...(partitioned ? { partitioned } : {}),
    },
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

/** Every table-level privilege a GRANT or REVOKE can name; ALL names each. */
const PRIVILEGE_NAMES = [
  'select',
  'insert',
  'update',
  'delete',
  'truncate',
  'references',
  'trigger',
  'maintain',
  'usage',
];

/** The table-level privileges in a GRANT's or REVOKE's privilege list, the
 *  tokens in [from, to), upper-cased. An item with a column list
 *  (`select (a, b)`, `all (a)`) is a column privilege: it leaves the
 *  table-level one, which is what the default privileges set, where it was. */
function tablePrivileges(stmt: Lexeme[], from: number, to: number): Set<string> {
  const named = new Set<string>();
  for (const item of splitAtCommas(stmt, from, to)) {
    if (item.some(isOpen)) continue;
    const first = item[0];
    if (isWord(first, 'ALL')) {
      PRIVILEGE_NAMES.forEach((p) => named.add(p.toUpperCase()));
      continue;
    }
    // A keyword folds; a quoted name is compared as written, so "select" is
    // SELECT and "SELECT" is no privilege at all (Postgres rejects it).
    const name =
      first?.kind === 'word' ? foldAscii(first.text) : first?.kind === 'ident' ? first.text : '';
    if (PRIVILEGE_NAMES.includes(name)) named.add(name.toUpperCase());
  }
  return named;
}

/** GRANT privileges ON [TABLE|SEQUENCE] names TO roles, and REVOKE [GRANT
 *  OPTION FOR] privileges ON ... FROM roles: each named role now has a
 *  decided value for each table-level privilege listed. REVOKE GRANT OPTION
 *  FOR decides nothing: it leaves the privilege. */
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
  const listStart = k;
  let depth = 0;
  for (; k < stmt.length; k += 1) {
    if (isOpen(stmt[k])) depth += 1;
    else if (isClose(stmt[k])) depth -= 1;
    else if (depth === 0 && isWord(stmt[k], 'ON')) break;
  }
  if (k >= stmt.length) return;
  const privileges = tablePrivileges(stmt, listStart, k);
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
    for (const role of roles) {
      if (!isApiRole(role)) continue;
      const named = object.named.get(role) ?? new Set<string>();
      privileges.forEach((p) => named.add(p));
      object.named.set(role, named);
    }
  }
}

/** DROP {TABLE|VIEW|MATERIALIZED VIEW|SEQUENCE|FOREIGN TABLE} [IF EXISTS]
 *  names: the objects (with the sequences their columns own, and a
 *  partitioned table's partitions) are gone. DROP SCHEMA names: everything
 *  in them is (Postgres refuses a schema that is not empty without CASCADE).
 *  A view or other object that only CASCADE drops, through a dependency
 *  Postgres records but this scanner does not follow, stays listed. */
function onDrop(stmt: Lexeme[], at: number, state: State): void {
  if (isWord(stmt[at + 1], 'SCHEMA')) {
    let k = skipIfExists(stmt, at + 2);
    for (;;) {
      const schema = identOf(stmt[k]);
      if (schema === null) return;
      for (const [key, o] of [...state.objects]) if (o.schema === schema) forget(state, key);
      k += 1;
      if (!isPunct(stmt[k], ',')) return;
      k += 1;
    }
  }
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

/** ALTER TABLE actions on a table: ADD [COLUMN] col serial makes a sequence
 *  (only in public do new sequences get public's default privileges); DROP
 *  [COLUMN] col drops the sequences the column owns; ATTACH and DETACH
 *  PARTITION make a table a partition and back. */
function onTableActions(stmt: Lexeme[], from: number, ref: RelationRef, state: State): void {
  const key = qualify(ref.schema, ref.name);
  for (const action of splitAtCommas(stmt, from, stmt.length)) {
    if (isWord(action[0], 'ADD') && ref.schema === 'public') {
      let j = 1;
      if (isWord(action[j], 'COLUMN')) j += 1;
      const ifNotExists = skipIfNotExists(action, j);
      const serial = serialColumn(action.slice(ifNotExists.next));
      if (serial) trackSerialSequence(state, ref, serial, ifNotExists.present);
    } else if (isWord(action[0], 'DROP') && !isWord(action[1], 'CONSTRAINT')) {
      let j = 1;
      if (isWord(action[j], 'COLUMN')) j += 1;
      j = skipIfExists(action, j);
      const column = identOf(action[j]);
      if (column === null) continue;
      for (const [k, o] of [...state.objects]) {
        if (o.owner === key && o.ownerColumn === column) forget(state, k);
      }
    } else if (isWord(action[0], 'ATTACH', 'DETACH') && isWord(action[1], 'PARTITION')) {
      const child = parseRelation(action, 2);
      const object = child ? state.objects.get(qualify(child.schema, child.name)) : undefined;
      if (!object) continue;
      if (isWord(action[0], 'ATTACH')) {
        object.kind = 'partition';
        object.partitionOf = key;
      } else {
        object.kind = object.partitioned ? 'partitioned table' : 'table';
        delete object.partitionOf;
      }
    }
  }
}

/** ALTER ... RENAME TO and SET SCHEMA follow the object, RENAME [COLUMN] the
 *  column that owns a sequence, OWNED BY a sequence's owner; ALTER TABLE
 *  actions as onTableActions reads them. */
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
    for (const o of state.objects.values()) {
      if (o.owner === key) o.owner = newKey;
      if (o.partitionOf === key) o.partitionOf = newKey;
    }
    return;
  }
  if (isWord(stmt[k], 'RENAME') && !isWord(stmt[k + 1], 'CONSTRAINT')) {
    // RENAME [COLUMN] a TO b: a sequence the column owns keeps its own name.
    const j = isWord(stmt[k + 1], 'COLUMN') ? k + 2 : k + 1;
    const from = identOf(stmt[j]);
    const to = isWord(stmt[j + 1], 'TO') ? identOf(stmt[j + 2]) : null;
    if (from === null || to === null) return;
    for (const o of state.objects.values()) {
      if (o.owner === key && o.ownerColumn === from) o.ownerColumn = to;
    }
    return;
  }
  if (isWord(stmt[k], 'SET') && isWord(stmt[k + 1], 'SCHEMA')) {
    const to = identOf(stmt[k + 2]);
    if (to === null || to === ref.schema) return;
    // An object made in public moves, with the sequences its columns own, and
    // is a public object again if it comes back. One made in another schema
    // is not tracked: it never had public's default privileges, so moving it
    // in changes nothing the defaults decide.
    move(state, key, to);
    return;
  }
  if (relation.kind === 'sequence') {
    const ownedBy = ownedByAt(stmt, k);
    const object = state.objects.get(key);
    if (ownedBy < 0 || !object) return;
    const owner = ownerOf(stmt, ownedBy);
    if (owner) {
      object.owner = owner.owner;
      object.ownerColumn = owner.ownerColumn;
    } else {
      delete object.owner;
      delete object.ownerColumn;
    }
    return;
  }
  if (relation.kind === 'table') onTableActions(stmt, k, ref, state);
}

/** A top-level SELECT ... INTO [TEMP|UNLOGGED] [TABLE] name creates a table.
 *  `start` is the SELECT (or WITH) after any opening brackets, since
 *  `(select ... into t)` creates t too; the INTO belongs to that first
 *  SELECT, so the search ends where its brackets close. (Inside PL/pgSQL,
 *  SELECT INTO sets variables and is not passed here.) */
function onSelectInto(stmt: Lexeme[], start: number, state: State): void {
  let depth = 0;
  for (let k = start; k < stmt.length; k += 1) {
    const t = stmt[k];
    if (isOpen(t)) depth += 1;
    else if (isClose(t)) {
      depth -= 1;
      if (depth < 0) return;
    } else if (depth === 0 && isWord(t, 'INTO')) {
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
  const tokens = tokenize(body.text, body.line);
  // An escaped line break is not a line of the file: point at the DO.
  if (body.linesMoved) tokens.forEach((t) => (t.line = body.line));
  scanStatements(splitStatements(tokens), state, true);
}

/** EXPLAIN [ANALYZE] [VERBOSE] statement, or EXPLAIN (option [value], ...)
 *  statement. Only ANALYZE runs the statement, so only then does a CREATE
 *  TABLE AS, CREATE MATERIALIZED VIEW or SELECT INTO under it create
 *  anything. An option's value reads as Postgres's defGetBoolean reads it
 *  (none, 1, true or on is true; 0, false or off is false, in any case), and
 *  the last ANALYZE option counts. */
function onExplain(stmt: Lexeme[], at: number, state: State): void {
  let k = at + 1;
  let analyze = false;
  const isAnalyze = (t: Lexeme | undefined): boolean =>
    isWord(t, 'ANALYZE', 'ANALYSE') ||
    (t?.kind === 'ident' && (t.text === 'analyze' || t.text === 'analyse'));
  if (isPunct(stmt[k], '(')) {
    const close = closingBracket(stmt, k);
    for (const option of splitAtCommas(stmt, k + 1, close)) {
      if (!isAnalyze(option[0])) continue;
      const value = option[1];
      analyze = value === undefined || !['0', 'false', 'off'].includes(value.text.toLowerCase());
    }
    k = close + 1;
  } else {
    if (isAnalyze(stmt[k])) {
      analyze = true;
      k += 1;
    }
    if (isWord(stmt[k], 'VERBOSE')) k += 1;
  }
  if (analyze) onStatement(stmt, k, state, true);
}

/** In a PL/pgSQL body a statement starts a chunk, or follows one of these
 *  (or a <<label>>). */
const PLPGSQL_STATEMENT_LEADS = ['BEGIN', 'THEN', 'ELSE', 'LOOP'];

function onStatement(stmt: Lexeme[], at: number, state: State, topLevel: boolean): void {
  // `(select ... into t)` creates t as the bare SELECT does.
  if (topLevel && isPunct(stmt[at], '(')) {
    let k = at;
    while (isPunct(stmt[k], '(')) k += 1;
    if (isWord(stmt[k], 'SELECT', 'WITH')) onSelectInto(stmt, k, state);
    return;
  }
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
      if (topLevel) onSelectInto(stmt, at, state);
      break;
    case 'EXPLAIN':
      if (topLevel) onExplain(stmt, at, state);
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

/** The objects made in public that are in public at the end, each with the
 *  required privileges nothing named for each role. */
export function createdObjects(state: ScanState): CreatedObject[] {
  return [...state.objects.values()]
    .filter((o) => o.schema === 'public')
    .map((o) => {
      const required = requiredPrivileges(o.kind);
      const missing: RoleGap[] = [];
      for (const role of API_ROLES) {
        const named = o.named.get(role);
        const privileges = required.filter((p) => !named?.has(p));
        if (privileges.length > 0) missing.push({ role, privileges });
      }
      return {
        schema: o.schema,
        name: o.name,
        qualified: qualify(o.schema, o.name),
        kind: o.kind,
        line: o.line,
        ...(o.serial ? { serial: o.serial } : {}),
        decided: API_ROLES.filter((r) => !missing.some((m) => m.role === r)),
        missing,
      };
    })
    .sort((a, b) => a.line - b.line || (a.qualified < b.qualified ? -1 : 1));
}

/** One migration file: what it creates in public, and each object with a
 *  required privilege no GRANT or REVOKE names for some of the three roles. */
export function scanMigration(sql: string, file: string): FileScan {
  const state = newScanState();
  scanInto(state, sql);
  const objects = createdObjects(state);
  const findings: Finding[] = objects
    .filter((o) => o.missing.length > 0)
    .map((o) => ({
      file,
      line: o.line,
      kind: o.kind,
      object: o.qualified,
      ...(o.serial ? { serial: o.serial } : {}),
      missing: o.missing,
    }));
  return { file, objects, findings, schemaWideGrant: state.schemaWideGrant };
}

/** `file:line: <kind> <object> leaves to the default privileges: <privileges>
 *  for <roles>[; ...]`, roles that miss the same privileges together. */
export function formatFinding(f: Finding): string {
  const what = f.serial
    ? `sequence ${f.object} (made by the ${f.serial.type} column ${f.serial.table}.${f.serial.column})`
    : `${f.kind} ${f.object}`;
  const groups = new Map<string, ApiRole[]>();
  for (const gap of f.missing) {
    const key = gap.privileges.join(', ');
    groups.set(key, [...(groups.get(key) ?? []), gap.role]);
  }
  const gaps = [...groups].map(([privileges, roles]) => `${privileges} for ${roles.join(', ')}`);
  return `${f.file}:${f.line}: ${what} leaves to the default privileges: ${gaps.join('; ')}`;
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
