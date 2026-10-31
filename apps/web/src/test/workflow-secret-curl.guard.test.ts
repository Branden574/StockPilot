import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant (docket S16 review): a workflow that calls a server with
 * a secret never prints the answer.
 *
 * The repository is public, and so are its Actions logs. The deploy hook
 * (prewarm-on-deploy.yml) called the prewarm route with BACKFILL_ADMIN_SECRET
 * after every production deploy, and curl printed the 200's body into the
 * run's log: every warmed organization's id and its warehouses' ids, their
 * item, book and charter counts and timings, and the text of any read that
 * failed (the loaders keep a failure's own text in those results). GitHub
 * masks the secret in a log, never the answer. The step decides by curl's
 * exit status alone, so the body is discarded and only the status printed.
 *
 * What the census reads: every workflow's `run:` blocks, and every shell
 * script they run: `bash x.sh`, `./x.sh`, `source x.sh`, `bash -c '...'`, and
 * a package.json script run with pnpm, npm or yarn (`pnpm security:test` runs
 * scripts/security-test.sh). Each is split into single commands on the
 * shell's own separators (; && || | & and new lines, outside quotes), and a
 * $(...) or backquoted substitution is read as commands too.
 *
 * A curl sends a secret when it has an Authorization, Proxy-Authorization or
 * Cookie header, -u/--user, --oauth2-bearer, a cookie, netrc, config or
 * client-certificate option, or a word that uses a secret: ${{ secrets.* }}
 * or ${{ github.token }}, a variable a workflow `env:` maps from one, a
 * variable the script assigned from one, or a variable named like SECRET,
 * TOKEN, KEY or PASSWORD.
 *
 * Such a curl must write every answer to exactly /dev/null (-o /dev/null for
 * each URL); must not print headers or a trace (-v, --trace*, -i, --libcurl,
 * -D to the log); must not write out headers or a URL with -w; and must not
 * pipe its output into another command. A step decides by curl's exit
 * status, or by a status code captured with -w '%{http_code}'.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');

/** A variable named like a credential is treated as one. */
const SECRET_NAME = /SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL/i;
/** A GitHub expression that yields a secret. */
const SECRET_EXPRESSION = /\$\{\{\s*(?:secrets\.|github\.token\b)/;
const AUTH_HEADER = /^\s*(?:(?:proxy-)?authorization|cookie)\s*:/i;
/** curl options that send a credential of some kind. */
const CREDENTIAL_OPTIONS = [
  'user',
  'proxy-user',
  'oauth2-bearer',
  'netrc',
  'netrc-file',
  'netrc-optional',
  'config',
  'cookie',
  'cert',
  'key',
  'pass',
];
/** -w variables that print a header or a URL (a URL can carry a token). */
const PRINTING_WRITE_OUT =
  /%\{(?:header_json|json|url|url_effective|redirect_url|referer|certs)\}|%header\{/;
/** Where a -D (dump-header) target lands in the log. */
const LOG_TARGETS = new Set(['-', '/dev/stdout', '/dev/stderr', '/dev/fd/1', '/dev/fd/2']);

// ─── The shell, as far as the census needs it ──────────────────────────────

interface Word {
  /** As written, quotes included. */
  raw: string;
  /** As the command receives it: quotes removed, variables left as written. */
  value: string;
}

interface Command {
  words: Word[];
  /** 1-based line in its script. */
  line: number;
  /** Its standard output goes into the next command of a pipeline. */
  piped: boolean;
  /** $(...) and `...` substitutions inside it, each a script of its own. */
  nested: Array<{ script: string; line: number }>;
  /** Here-document bodies fed to it. */
  heredocs: string[];
}

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

/** Index of the quote that closes the single-quoted string opening at `open`. */
function singleQuoteEnd(s: string, open: number): number {
  const end = s.indexOf("'", open + 1);
  return end === -1 ? s.length - 1 : end;
}

/** Index of the quote that closes the double-quoted string opening at `open`. */
function doubleQuoteEnd(s: string, open: number): number {
  let j = open + 1;
  while (j < s.length && s.charAt(j) !== '"') {
    if (s.charAt(j) === '\\') j += 2;
    else if (s.charAt(j) === '$' && s.charAt(j + 1) === '(') j = closeOf(s, j + 1, '(', ')') + 1;
    else j++;
  }
  return Math.min(j, s.length - 1);
}

/** Index of the backquote that closes the substitution opening at `open`. */
function backquoteEnd(s: string, open: number): number {
  let j = open + 1;
  while (j < s.length && s.charAt(j) !== '`') j += s.charAt(j) === '\\' ? 2 : 1;
  return Math.min(j, s.length - 1);
}

/** Index of the `closeCh` that closes the `openCh` at `open`, skipping quotes. */
function closeOf(s: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const ch = s.charAt(j);
    if (ch === '\\') j++;
    else if (ch === "'" && openCh === '(') j = singleQuoteEnd(s, j);
    else if (ch === '"') j = doubleQuoteEnd(s, j);
    else if (ch === openCh) depth++;
    else if (ch === closeCh && --depth === 0) return j;
  }
  return s.length - 1;
}

function parseShell(s: string): Command[] {
  const commands: Command[] = [];
  let line = 1;
  const blank = (): Command => ({ words: [], line, piped: false, nested: [], heredocs: [] });
  let cur = blank();
  // In an object, so what the helpers below assign is not narrowed away.
  const state: { word: Word | null; heredocNext: { strip: boolean } | null } = {
    word: null,
    heredocNext: null,
  };
  let pendingHeredocs: Array<{ delimiter: string; strip: boolean; into: string[] }> = [];

  const add = (raw: string, value = raw) => {
    const word = (state.word ??= { raw: '', value: '' });
    word.raw += raw;
    word.value += value;
  };
  const endWord = () => {
    const word = state.word;
    if (!word) return;
    if (state.heredocNext) {
      pendingHeredocs.push({ delimiter: word.value, ...state.heredocNext, into: cur.heredocs });
      state.heredocNext = null;
    } else {
      cur.words.push(word);
    }
    state.word = null;
  };
  const endCommand = (piped = false) => {
    endWord();
    if (cur.words.length > 0 || cur.nested.length > 0) {
      cur.piped = piped;
      commands.push(cur);
    }
    cur = blank();
  };

  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    const d = s.charAt(i + 1);
    if (c === '\\' && d === '\n') {
      // A continuation line: one command.
      i += 2;
      line++;
    } else if (c === '\\') {
      add(c + d, d);
      i += 2;
    } else if (c === "'") {
      const end = singleQuoteEnd(s, i);
      const body = s.slice(i + 1, end);
      add(s.slice(i, end + 1), body);
      line += count(body, '\n');
      i = end + 1;
    } else if (c === '$' && d === "'") {
      let j = i + 2;
      while (j < s.length && s.charAt(j) !== "'") j += s.charAt(j) === '\\' ? 2 : 1;
      add(s.slice(i, j + 1), s.slice(i + 2, j));
      i = j + 1;
    } else if (c === '"') {
      const end = doubleQuoteEnd(s, i);
      let value = '';
      for (let j = i + 1; j < end;) {
        if (s.charAt(j) === '\\') {
          value += s.charAt(j + 1);
          j += 2;
        } else if ((s.charAt(j) === '$' && s.charAt(j + 1) === '(') || s.charAt(j) === '`') {
          const close = s.charAt(j) === '`' ? backquoteEnd(s, j) : closeOf(s, j + 1, '(', ')');
          const inner = s.charAt(j) === '`' ? s.slice(j + 1, close) : s.slice(j + 2, close);
          if (!inner.startsWith('(')) {
            cur.nested.push({ script: inner, line: line + count(s.slice(i, j), '\n') });
          }
          value += s.slice(j, close + 1);
          j = close + 1;
        } else {
          value += s.charAt(j);
          j++;
        }
      }
      const raw = s.slice(i, end + 1);
      add(raw, value);
      line += count(raw, '\n');
      i = end + 1;
    } else if ((c === '$' && d === '(') || c === '`') {
      const close = c === '`' ? backquoteEnd(s, i) : closeOf(s, i + 1, '(', ')');
      const inner = c === '`' ? s.slice(i + 1, close) : s.slice(i + 2, close);
      // $(( ... )) is arithmetic, not a command.
      if (!inner.startsWith('(')) cur.nested.push({ script: inner, line });
      const raw = s.slice(i, close + 1);
      add(raw);
      line += count(raw, '\n');
      i = close + 1;
    } else if (c === '$' && d === '{') {
      const close = closeOf(s, i + 1, '{', '}');
      add(s.slice(i, close + 1));
      i = close + 1;
    } else if (c === '#' && !state.word) {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
    } else if (c === '\n') {
      endCommand();
      line++;
      i++;
      for (const heredoc of pendingHeredocs) {
        const body: string[] = [];
        while (i < s.length) {
          const end = s.indexOf('\n', i);
          const stop = end === -1 ? s.length : end;
          const text = s.slice(i, stop);
          i = stop + 1;
          line++;
          if ((heredoc.strip ? text.replace(/^\t+/, '') : text) === heredoc.delimiter) break;
          body.push(text);
        }
        heredoc.into.push(body.join('\n'));
      }
      pendingHeredocs = [];
      cur.line = line;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === ';') {
      endCommand();
      i += d === ';' ? 2 : 1;
    } else if (c === '&') {
      if (d === '&') {
        endCommand();
        i += 2;
      } else if (d === '>' || /[<>]$/.test(state.word?.raw ?? '')) {
        // &>file, 2>&1, >&2: a redirection, not a separator.
        add(c);
        i++;
      } else {
        endCommand();
        i++;
      }
    } else if (c === '|') {
      if (d === '|') {
        endCommand();
        i += 2;
      } else {
        endCommand(true);
        i += d === '&' ? 2 : 1;
      }
    } else if (c === '(' || c === ')') {
      endCommand();
      i++;
    } else if (c === '<' && d === '<') {
      endWord();
      if (s.charAt(i + 2) === '<') {
        // A here-string: the next word is data on standard input.
        i += 3;
      } else {
        const strip = s.charAt(i + 2) === '-';
        state.heredocNext = { strip };
        i += strip ? 3 : 2;
      }
    } else {
      add(c);
      i++;
    }
  }
  endCommand();
  return commands;
}

/** Words that come before the command itself. */
const PREFIX_WORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  '!',
  'time',
  '{',
  '}',
  'exec',
  'command',
  'builtin',
  'nohup',
]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/** The command's own words: keywords, wrappers and assignments before it removed. */
function commandWords(words: Word[]): Word[] {
  let k = 0;
  const at = (index: number) => words[index] ?? { raw: '', value: '' };
  while (k < words.length) {
    const { raw, value } = at(k);
    if (PREFIX_WORDS.has(value) || ASSIGNMENT.test(raw)) {
      k++;
    } else if (value === 'sudo' || value === 'env' || value === 'timeout') {
      k++;
      while (k < words.length && at(k).value.startsWith('-')) k++;
      if (value === 'timeout') k++;
    } else {
      break;
    }
  }
  return words.slice(k);
}

function usesSecret(raw: string, secretVars: ReadonlySet<string>): boolean {
  if (SECRET_EXPRESSION.test(raw)) return true;
  for (const m of raw.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[1] ?? '';
    if (secretVars.has(name) || SECRET_NAME.test(name)) return true;
  }
  return false;
}

/** A variable assigned from a secret is one too. */
function taint(words: Word[], secretVars: Set<string>): void {
  const declares = ['export', 'local', 'declare', 'readonly', 'typeset'];
  const list = declares.includes(words[0]?.value ?? '') ? words.slice(1) : words;
  for (const word of list) {
    const m = ASSIGNMENT.exec(word.raw);
    if (m?.[1] && usesSecret(m[2] ?? '', secretVars)) secretVars.add(m[1]);
  }
}

// ─── curl ──────────────────────────────────────────────────────────────────

/** Short options that take a value (curl 8). */
const CURL_SHORT_WITH_VALUE = new Set([...'AbcCdDeEFHKmoPQrtTuUwxXyYz']);
const CURL_SHORT_NAMES: Record<string, string> = {
  b: 'cookie',
  c: 'cookie-jar',
  d: 'data',
  D: 'dump-header',
  E: 'cert',
  F: 'form',
  H: 'header',
  i: 'include',
  K: 'config',
  n: 'netrc',
  o: 'output',
  O: 'remote-name',
  u: 'user',
  U: 'proxy-user',
  v: 'verbose',
  w: 'write-out',
};
/** Long options that take a value. An unknown one is read as a flag. */
const CURL_LONG_WITH_VALUE = new Set([
  'output',
  'output-dir',
  'write-out',
  'header',
  'proxy-header',
  'user',
  'proxy-user',
  'oauth2-bearer',
  'data',
  'data-raw',
  'data-binary',
  'data-urlencode',
  'data-ascii',
  'json',
  'form',
  'form-string',
  'dump-header',
  'trace',
  'trace-ascii',
  'trace-config',
  'libcurl',
  'stderr',
  'url',
  'url-query',
  'cookie',
  'cookie-jar',
  'config',
  'netrc-file',
  'request',
  'max-time',
  'connect-timeout',
  'retry',
  'retry-delay',
  'retry-max-time',
  'user-agent',
  'referer',
  'cacert',
  'capath',
  'cert',
  'cert-type',
  'key',
  'key-type',
  'pass',
  'upload-file',
  'range',
  'continue-at',
  'proxy',
  'resolve',
  'connect-to',
  'interface',
  'limit-rate',
  'max-filesize',
  'max-redirs',
  'variable',
  'aws-sigv4',
  'unix-socket',
  'speed-limit',
  'speed-time',
  'time-cond',
  'etag-save',
  'etag-compare',
]);

interface Curl {
  outputs: string[];
  urls: string[];
  headers: string[];
  writeOuts: string[];
  dumpHeaders: string[];
  /** Every other option, by its long name. */
  options: Set<string>;
}

function readCurl(args: Word[]): Curl {
  const curl: Curl = {
    outputs: [],
    urls: [],
    headers: [],
    writeOuts: [],
    dumpHeaders: [],
    options: new Set(),
  };
  const option = (name: string, value: string) => {
    if (name === 'output') curl.outputs.push(value);
    else if (name === 'remote-name' || name === 'remote-name-all')
      curl.outputs.push('(the remote name)');
    else if (name === 'write-out') curl.writeOuts.push(value);
    else if (name === 'dump-header') curl.dumpHeaders.push(value);
    else if (name === 'header' || name === 'proxy-header') curl.headers.push(value);
    else if (name === 'url') curl.urls.push(value);
    else curl.options.add(name);
  };
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]?.value ?? '';
    if (/^\d*(?:>>?|<|&>)/.test(arg)) {
      // A redirection; its target is the next word when it stands alone.
      if (/^\d*(?:>>?|<|&>)$/.test(arg)) k++;
    } else if (arg.startsWith('--') && arg.length > 2) {
      const name = arg.slice(2);
      option(name, CURL_LONG_WITH_VALUE.has(name) ? (args[++k]?.value ?? '') : '');
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let p = 1; p < arg.length; p++) {
        const letter = arg.charAt(p);
        const name = CURL_SHORT_NAMES[letter] ?? letter;
        if (CURL_SHORT_WITH_VALUE.has(letter)) {
          option(name, p + 1 < arg.length ? arg.slice(p + 1) : (args[++k]?.value ?? ''));
          break;
        }
        option(name, '');
      }
    } else {
      curl.urls.push(arg);
    }
  }
  return curl;
}

function sendsSecret(args: Word[], curl: Curl, secretVars: ReadonlySet<string>): boolean {
  return (
    curl.headers.some((header) => AUTH_HEADER.test(header)) ||
    CREDENTIAL_OPTIONS.some((name) => curl.options.has(name)) ||
    args.some((word) => usesSecret(word.raw, secretVars))
  );
}

/** Why the curl's answer, or its headers, would reach the log. */
function printsAnswer(curl: Curl, piped: boolean): string[] {
  const why: string[] = [];
  if (curl.outputs.length < Math.max(1, curl.urls.length)) {
    why.push('an answer is printed (no -o /dev/null for it)');
  }
  for (const output of curl.outputs) {
    if (output !== '/dev/null') why.push(`-o ${output}, not /dev/null`);
  }
  for (const name of curl.options) {
    if (
      name === 'verbose' ||
      name === 'include' ||
      name === 'libcurl' ||
      name.startsWith('trace')
    ) {
      why.push(`--${name}`);
    }
  }
  for (const target of curl.dumpHeaders) {
    if (LOG_TARGETS.has(target)) why.push(`--dump-header ${target}`);
  }
  for (const format of curl.writeOuts) {
    if (format.startsWith('@') || PRINTING_WRITE_OUT.test(format)) {
      why.push(`--write-out ${format}`);
    }
  }
  if (piped) why.push('its output is piped into another command');
  return why;
}

// ─── The census ────────────────────────────────────────────────────────────

interface Io {
  /** A repository-relative file's text, or null when there is none. */
  read(path: string): string | null;
}

interface CurlFound {
  where: string;
  command: string;
  sendsSecret: boolean;
  prints: string[];
}

interface Census {
  curls: CurlFound[];
  /** Every script the census read, besides the workflows. */
  scripts: string[];
  /** A script a run block calls that the census could not find. */
  unresolved: string[];
}

interface Scope {
  secretVars: Set<string>;
  cwd: string;
  depth: number;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** pnpm commands that are not a package.json script. */
const PNPM_BUILTINS = new Set([
  'add',
  'approve-builds',
  'audit',
  'bin',
  'config',
  'create',
  'deploy',
  'dlx',
  'env',
  'exec',
  'fetch',
  'i',
  'import',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'ls',
  'outdated',
  'pack',
  'patch',
  'patch-commit',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'rm',
  'root',
  'setup',
  'store',
  'unlink',
  'up',
  'update',
  'why',
]);
const MAX_DEPTH = 5;

function noteScript(out: Census, name: string): void {
  if (!out.scripts.includes(name)) out.scripts.push(name);
}

function runFile(path: string, from: string, scope: Scope, out: Census, io: Io): void {
  if (/[$`*?]/.test(path) || path.startsWith('/')) {
    out.unresolved.push(`${from}: ${path}`);
    return;
  }
  const found = [posix.join(scope.cwd, path), posix.normalize(path)].find(
    (candidate) => io.read(candidate) !== null,
  );
  if (!found) {
    out.unresolved.push(`${from}: ${path}`);
    return;
  }
  noteScript(out, found);
  walk(io.read(found) ?? '', (line) => `${found}:${line}`, scope, out, io);
}

function runPackageScript(
  manager: string,
  args: Word[],
  from: string,
  scope: Scope,
  out: Census,
  io: Io,
): void {
  let cwd = scope.cwd;
  const positional: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]?.value ?? '';
    // A workspace fan-out runs each package's own script: not followed.
    if (
      ['--filter', '-F', '-r', '--recursive', '--workspace', '--workspaces', '-w'].includes(arg)
    ) {
      return;
    }
    if (['-C', '--dir', '--prefix', '--cwd'].includes(arg))
      cwd = posix.join(cwd, args[++k]?.value ?? '');
    else if (!arg.startsWith('-')) positional.push(arg);
  }
  const [first, second] = positional;
  if (first === undefined) return;
  let name: string | undefined;
  if (first === 'run' || first === 'run-script') name = second;
  else if (manager === 'npm')
    name = ['test', 'start', 'stop', 'restart'].includes(first) ? first : undefined;
  else if (!(manager === 'pnpm' && PNPM_BUILTINS.has(first))) name = first;
  if (!name) return;
  const packageJson = posix.join(cwd, 'package.json');
  const text = io.read(packageJson);
  if (text === null) {
    out.unresolved.push(`${from}: ${manager} ${name} (no ${packageJson})`);
    return;
  }
  const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
  // A name that is not a script runs a package's binary: nothing to read.
  for (const script of [`pre${name}`, name, `post${name}`]) {
    if (typeof scripts[script] !== 'string') continue;
    const where = `${packageJson} scripts["${script}"]`;
    noteScript(out, where);
    walk(scripts[script], () => where, { ...scope, cwd }, out, io);
  }
}

function walk(
  script: string,
  at: (line: number) => string,
  scope: Scope,
  out: Census,
  io: Io,
): void {
  const secretVars = new Set(scope.secretVars);
  for (const command of parseShell(script)) {
    taint(command.words, secretVars);
    const inner: Scope = { ...scope, secretVars, depth: scope.depth + 1 };
    const from = at(command.line);
    for (const nested of command.nested) {
      if (inner.depth <= MAX_DEPTH) walk(nested.script, () => at(nested.line), inner, out, io);
    }
    const words = commandWords(command.words);
    if (words.length === 0) continue;
    const program = words[0]?.value ?? '';
    const name = program.split('/').pop() ?? '';
    if (name === 'curl') {
      const args = words.slice(1);
      const curl = readCurl(args);
      out.curls.push({
        where: from,
        command: command.words.map((word) => word.raw).join(' '),
        sendsSecret: sendsSecret(args, curl, secretVars),
        prints: printsAnswer(curl, command.piped),
      });
      continue;
    }
    if (inner.depth > MAX_DEPTH) continue;
    if (SHELLS.has(name)) {
      const rest = words.slice(1);
      let file: string | undefined;
      let inline: string | undefined;
      for (let k = 0; k < rest.length; k++) {
        const arg = rest[k]?.value ?? '';
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
          inline = rest[k + 1]?.value ?? '';
          break;
        }
        if (arg === '-o' || arg === '+o') k++;
        else if (/^[-+]/.test(arg) || /^\d*[<>]/.test(arg)) continue;
        else {
          file = arg;
          break;
        }
      }
      if (inline !== undefined) walk(inline, () => from, inner, out, io);
      else if (file !== undefined) runFile(file, from, inner, out, io);
      else for (const body of command.heredocs) walk(body, () => from, inner, out, io);
    } else if (name === 'source' || name === '.') {
      const file = words[1]?.value;
      if (file) runFile(file, from, inner, out, io);
    } else if (/\.(?:ba|z)?sh$/.test(program)) {
      runFile(program, from, inner, out, io);
    } else if (name === 'pnpm' || name === 'npm' || name === 'yarn') {
      runPackageScript(name, words.slice(1), from, inner, out, io);
    }
  }
}

// ─── Workflows ─────────────────────────────────────────────────────────────

interface RunBlock {
  /** 1-based line of the block's first script line. */
  line: number;
  script: string;
  cwd: string;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The column of a mapping key, after a `- ` list marker when there is one. */
function keyColumn(line: string): number {
  const m = /^(\s*)(-\s+)?/.exec(line);
  return (m?.[1]?.length ?? 0) + (m?.[2]?.length ?? 0);
}

const YAML_ESCAPES: Record<string, string> = { n: '\n', t: '\t' };

function yamlScalar(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, (_, ch: string) => YAML_ESCAPES[ch] ?? ch);
  }
  return value.replace(/\s+#.*$/, '');
}

/** A `defaults: run: working-directory:` anywhere in the file. */
function defaultsWorkingDirectory(lines: string[]): string | undefined {
  for (const [i, line] of lines.entries()) {
    const m = /^(\s*)working-directory:\s*(.+)$/.exec(line);
    if (!m) continue;
    const column = m[1]?.length ?? 0;
    const parents = lines
      .slice(0, i)
      .filter((above) => above.trim() !== '' && !above.trim().startsWith('#'))
      .reverse();
    const run = parents.find((above) => indentOf(above) < column);
    const defaults = run && parents.find((above) => indentOf(above) < indentOf(run));
    if (run?.trim() === 'run:' && defaults?.trim() === 'defaults:') {
      return yamlScalar((m[2] ?? '').trim());
    }
  }
  return undefined;
}

/** The step's own `working-directory:`, beside its `run:`. */
function stepWorkingDirectory(
  lines: string[],
  runLine: number,
  column: number,
): string | undefined {
  const lineAt = (index: number) => lines[index] ?? '';
  let start = runLine;
  while (start > 0 && !(/^\s*-\s/.test(lineAt(start)) && keyColumn(lineAt(start)) === column)) {
    start--;
  }
  for (let i = start; i < lines.length; i++) {
    const line = lineAt(i);
    if (i > start && line.trim() !== '' && indentOf(line) < column) break;
    const m = /^\s*(?:-\s+)?working-directory:\s*(.+)$/.exec(line);
    if (m && keyColumn(line) === column) return yamlScalar((m[1] ?? '').trim());
  }
  return undefined;
}

function runBlocks(text: string): RunBlock[] {
  const lines = text.split('\n');
  const defaultCwd = defaultsWorkingDirectory(lines) ?? '.';
  const blocks: RunBlock[] = [];
  const lineAt = (index: number) => lines[index] ?? '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(-\s+)?run:[ \t]*(.*)$/.exec(lineAt(i));
    if (!m) continue;
    const column = keyColumn(lineAt(i));
    const value = (m[3] ?? '').trim();
    const cwd = stepWorkingDirectory(lines, i, column) ?? defaultCwd;
    if (/^[|>]/.test(value)) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lineAt(j).trim() !== '' && indentOf(lineAt(j)) <= column) break;
        body.push(lineAt(j));
      }
      while (body.length > 0 && (body.at(-1) ?? '').trim() === '') body.pop();
      const strip = Math.min(...body.filter((line) => line.trim() !== '').map(indentOf));
      const scriptLines = body.map((line) => line.slice(strip));
      const script = value.startsWith('>')
        ? scriptLines
            .join('\n')
            .split(/\n\s*\n/)
            .map((paragraph) => paragraph.replace(/\n/g, ' '))
            .join('\n')
        : scriptLines.join('\n');
      blocks.push({ line: i + 2, script, cwd });
      i = j - 1;
    } else if (value !== '') {
      // An empty `run:` opens a mapping (defaults.run), not a script.
      blocks.push({ line: i + 1, script: yamlScalar(value), cwd });
    }
  }
  return blocks;
}

/** Names a workflow maps from a secret: `NAME: ${{ secrets.X }}`. */
function secretEnvNames(text: string): Set<string> {
  const names = new Set<string>();
  // [ \t], not \s: a key's value never runs on to the next line.
  for (const m of text.matchAll(/^[ \t]*-?[ \t]*([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/gm)) {
    if (m[1] && SECRET_EXPRESSION.test(m[2] ?? '')) names.add(m[1]);
  }
  return names;
}

function census(workflows: Array<{ file: string; text: string }>, io: Io): Census {
  const out: Census = { curls: [], scripts: [], unresolved: [] };
  for (const { file, text } of workflows) {
    const secretVars = secretEnvNames(text);
    for (const block of runBlocks(text)) {
      walk(
        block.script,
        (line) => `${file}:${block.line + line - 1}`,
        { secretVars, cwd: block.cwd, depth: 0 },
        out,
        io,
      );
    }
  }
  return out;
}

const repoIo: Io = {
  read(path) {
    const abs = resolve(REPO_ROOT, path);
    if (!abs.startsWith(REPO_ROOT + sep)) return null;
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
  },
};

function repoWorkflows(): Array<{ file: string; text: string }> {
  const dirs = ['.github/workflows'];
  const actions = join(REPO_ROOT, '.github', 'actions');
  if (existsSync(actions)) {
    for (const name of readdirSync(actions)) dirs.push(`.github/actions/${name}`);
  }
  return dirs.flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => ({
        file: `${dir}/${name}`,
        text: readFileSync(join(REPO_ROOT, dir, name), 'utf8'),
      })),
  );
}

/** Every curl that sends a secret and prints its answer, with the reasons. */
function violations(result: Census): string[] {
  return result.curls
    .filter((curl) => curl.sendsSecret && curl.prints.length > 0)
    .map((curl) => `${curl.where}: ${curl.command} (${curl.prints.join('; ')})`);
}

// ─── Plants ────────────────────────────────────────────────────────────────

/** A one-step workflow running `script`, with `env` on the step. */
function workflow(script: string, env: Record<string, string> = {}): string {
  const envLines = Object.entries(env).map(([name, value]) => `          ${name}: ${value}`);
  return [
    'on: push',
    'jobs:',
    '  plant:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Plant',
    ...(envLines.length > 0 ? ['        env:', ...envLines] : []),
    '        run: |',
    ...script.split('\n').map((line) => (line === '' ? '' : `          ${line}`)),
  ].join('\n');
}

function plant(
  script: string,
  env: Record<string, string> = {},
  files: Record<string, string> = {},
): Census {
  return census([{ file: 'plant.yml', text: workflow(script, env) }], {
    read: (path) => files[path] ?? null,
  });
}

const HOOK_ENV = { HOOK_TOKEN: '${{ secrets.HOOK_TOKEN }}' };
const AUTH = '-H "Authorization: Bearer ${HOOK_TOKEN}"';
const API = 'https://example.com/api/report';

describe('workflows never print the answer of a call that sends a secret', () => {
  const real = census(repoWorkflows(), repoIo);

  it('no curl that sends a secret prints its answer', () => {
    expect(violations(real)).toEqual([]);
  });

  it('the census sees the deploy hook and the scripts the workflows run (control: it does not pass on nothing)', () => {
    const hook = real.curls.filter((curl) =>
      curl.where.startsWith('.github/workflows/prewarm-on-deploy.yml:'),
    );
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({ sendsSecret: true, prints: [] });
    expect(real.scripts).toEqual(
      expect.arrayContaining([
        'scripts/check-no-committed-env.sh',
        'package.json scripts["security:test"]',
        'scripts/security-test.sh',
      ]),
    );
    expect(real.unresolved).toEqual([]);
  });

  it('control: the known-bad samples fail, and the safe forms pass', () => {
    const result = plant(
      [
        '# we curl the route with a secret: a comment, not a command',
        'if curl -fsS --max-time 90 \\',
        `  ${AUTH} \\`,
        '  "${URL}"; then',
        '  echo ok',
        'fi',
        `curl -fsS -o /dev/null -w "HTTP %{http_code}\\n" ${AUTH} "\${URL}"`,
        'curl -sSfL -o tool.tar.gz "https://example.com/tool.tar.gz"',
        'curl --output /dev/null -H "Authorization: Bearer ${{ secrets.TOKEN }}" "${URL}"',
        'curl -H "X-Key: ${{ secrets.TOKEN }}" "${URL}"',
        `code="$(curl -sS -o /dev/null -w '%{http_code}' ${AUTH} ${API})"`,
        `curl -fsS -o "/dev/null" ${AUTH} ${API}`,
        `echo "curl ${AUTH} ${API}"`,
        "cat <<'EOF'",
        `curl ${AUTH} ${API}`,
        'EOF',
      ].join('\n'),
      HOOK_ENV,
    );
    expect(result.curls.map((curl) => curl.sendsSecret && curl.prints.length > 0)).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(violations(result)[0]).toMatch(/^plant\.yml:11: if curl -fsS --max-time 90 -H/);
  });

  // Review of 4a8bb0850: the guard saw a secret only as an Authorization
  // header or a literal secrets expression, judged a whole joined line at
  // once, took any `-o /dev/null` on the line as a discard, and read no
  // script. The earlier guard passed every plant below.
  describe('one plant per gap the review found', () => {
    it('gap 1: a secret sent other than in an Authorization header', () => {
      const plants = [
        plant('curl -fsS -X POST "$DEPLOY_HOOK"', {
          DEPLOY_HOOK: '${{ secrets.DEPLOY_HOOK_URL }}',
        }),
        plant(`curl -fsS -u "ci:\${CI_PASSWORD}" ${API}`),
        plant(`curl -fsS --data "token=\${UPLOAD_TOKEN}" ${API}`),
        plant(`curl -fsS -H "X-Api-Key: \${SERVICE_KEY}" ${API}`),
        plant(`AUTH_HEADER="X-Hook: \${HOOK_TOKEN}"\ncurl -fsS -H "\${AUTH_HEADER}" ${API}`, {
          HOOK_TOKEN: '${{ secrets.HOOK_VALUE }}',
        }),
      ];
      expect(plants.map((result) => violations(result).length)).toEqual([1, 1, 1, 1, 1]);
    });

    it('gap 2: the commands on one line are judged one by one', () => {
      const plants = [
        plant(
          `curl -fsS -o /dev/null https://example.com/health; curl -fsS ${AUTH} ${API}`,
          HOOK_ENV,
        ),
        plant(
          `curl -fsS ${AUTH} ${API} && curl -fsS -o /dev/null https://example.com/health`,
          HOOK_ENV,
        ),
        plant(
          `curl -fsS ${AUTH} ${API} & curl -fsS -o /dev/null https://example.com/health`,
          HOOK_ENV,
        ),
      ];
      expect(plants.map((result) => violations(result).length)).toEqual([1, 1, 1]);
    });

    it('gap 3: -o /dev/null alone is not enough', () => {
      const plants = [
        `curl -v -o /dev/null ${AUTH} ${API}`,
        `curl -sSv -o /dev/null ${AUTH} ${API}`,
        `curl --trace-ascii - -o /dev/null ${AUTH} ${API}`,
        `curl -i -o /dev/null ${AUTH} ${API}`,
        `curl -sS -D - -o /dev/null ${AUTH} ${API}`,
        `curl -sS -o /dev/null -w '%{header_json}' ${AUTH} ${API}`,
        `curl -sS -o /dev/null -w '%{url_effective}' ${AUTH} ${API}`,
        `curl -sS -o /dev/null -w '%{redirect_url}' ${AUTH} ${API}`,
        `curl -sS -o /dev/null -w '%{http_code}' ${AUTH} ${API} | tee status.txt`,
        `curl -sS -o /dev/null ${AUTH} ${API} https://example.com/api/other`,
      ].map((script) => plant(script, HOOK_ENV));
      expect(plants.map((result) => violations(result).length)).toEqual([
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      ]);
    });

    it('the scripts a run block calls are read too', () => {
      const hookScript =
        '#!/usr/bin/env bash\nset -eu\ncurl -fsS -H "X-Hook: ${HOOK_TOKEN}" "$HOOK_URL"\n';
      const direct = plant('bash scripts/plant-hook.sh', HOOK_ENV, {
        'scripts/plant-hook.sh': hookScript,
      });
      expect(violations(direct)).toEqual([
        'scripts/plant-hook.sh:3: curl -fsS -H "X-Hook: ${HOOK_TOKEN}" "$HOOK_URL" (an answer is printed (no -o /dev/null for it))',
      ]);
      const viaPnpm = plant('pnpm plant:hook', HOOK_ENV, {
        'package.json': JSON.stringify({ scripts: { 'plant:hook': 'bash scripts/plant-hook.sh' } }),
        'scripts/plant-hook.sh': hookScript,
      });
      expect(violations(viaPnpm)).toHaveLength(1);
      expect(viaPnpm.scripts).toEqual([
        'package.json scripts["plant:hook"]',
        'scripts/plant-hook.sh',
      ]);
      const inline = plant(`bash -c 'curl -fsS -H "X-Hook: \${HOOK_TOKEN}" ${API}'`, HOOK_ENV);
      expect(violations(inline)).toHaveLength(1);
      const captured = plant(`BODY="$(curl -fsS ${AUTH} ${API})"`, HOOK_ENV);
      expect(violations(captured)).toHaveLength(1);
      const missing = plant('bash scripts/not-there.sh', HOOK_ENV);
      expect(missing.unresolved).toEqual(['plant.yml:10: scripts/not-there.sh']);
    });
  });
});
