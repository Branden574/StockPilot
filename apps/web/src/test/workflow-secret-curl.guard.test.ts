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
 * What the census reads: every workflow's and local action's `run:` blocks,
 * and what they run: a shell script (`bash x.sh`, `./x.sh`, `source x.sh`,
 * `bash -c '...'`, an eval or trap string, find -exec), a package.json script
 * run with pnpm, npm or yarn, and a pnpm or turbo fan-out, read in every
 * workspace package that has the script (a filter only narrows that). Each is
 * split into single commands on the shell's own separators (; && || | & and
 * new lines, outside quotes); a $(...) or backquoted substitution is read as
 * commands too, and env, sudo, timeout, nice and the like (also by a path,
 * /usr/bin/env) are read through.
 *
 * What the census cannot read is unresolved, and the test fails until each is
 * read by hand and given a reason in READ_BY_HAND: an interpreter (node,
 * python, ...), make, xargs, a repository program that is not a shell script,
 * a program named by a variable, an HTTP client other than curl, an action
 * passed a secret (in its step, or by its job's or the workflow's env:), a
 * run block in another shell, an npm or yarn workspace fan-out, anything past
 * the depth limit, and a program that has a curl command among its arguments
 * (a wrapper WRAPPERS does not list). Any other program (jq, tar, a CLI that
 * pnpm dlx fetches) is taken for what it is: the census does not read it.
 *
 * A secret is ${{ secrets }} in any form or github.token; an env., inputs.,
 * vars., steps.<id>.outputs. or needs.<job>.outputs. name that a workflow maps
 * from one (env:, with:, outputs:, an input's default, a line written to
 * $GITHUB_ENV or $GITHUB_OUTPUT) or that is named like SECRET, TOKEN, KEY or
 * PASSWORD; a shell variable mapped, assigned or named that way; a curl
 * variable imported from one; and the arguments of a script or function
 * called with one.
 *
 * A curl sends a secret when one of its words uses a secret, or it has an
 * Authorization, Proxy-Authorization or Cookie header, headers read from a
 * file, or a credential, cookie, netrc, config or client-certificate option.
 * Such a curl must:
 * - write every answer to exactly /dev/null: one -o /dev/null per URL, after
 *   each --next too. A URL that may expand to several transfers (a {..} or
 *   [..] glob, or an expansion whose text the census cannot see) needs
 *   --globoff; an unquoted expansion fails outright, since the shell can
 *   split it into several URLs;
 * - not print headers, a trace or a URL: no -v, -i, --show-headers, --trace*
 *   or --libcurl, no -D, -c, --etag-save or a trace to anything but
 *   /dev/null, no -w variable outside the safe list, no --output-dir, and no
 *   -K (options from a file the census cannot see);
 * - not pipe its output into another command;
 * - use only options curl's manual lists. An unknown one fails, since the
 *   census cannot tell what it prints. A long option's value may follow it
 *   (--output -) or be inline (--output=-).
 * A step decides by curl's exit status, or by a status code captured with
 * -w '%{http_code}'.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');

// ─── What a secret looks like ──────────────────────────────────────────────

/** A name that reads like a credential is treated as one. */
const SECRET_NAME = /SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL/i;
/** A GitHub expression. The runner pastes its value into the script. */
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
/** A context read whole, as toJSON(secrets) or toJSON(env) do. */
const WHOLE_CONTEXT =
  /\b(?:secrets|github|env|inputs|vars|steps|needs|jobs|matrix)\b(?!\s*[.[\w-])/;
/** A shell variable or positional parameter: $X, ${X...}, ${#X}, ${!X}, $1, $@. */
const SHELL_VARIABLE = /\$\{?[#!]?([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*])/g;
/** A curl variable, which an --expand-* option reads: {{X}}. */
const CURL_VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/g;
/** The parameters of a script or function called with a secret ($0 too, for bash -c). */
const POSITIONAL = ['@', '*', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const AUTH_HEADER = /^\s*(?:(?:proxy-)?authorization|cookie)\s*:/i;

function expressionUsesSecret(expression: string, names: ReadonlySet<string>): boolean {
  // A property named in brackets is a name too: env['HOOK_TOKEN'].
  const indexed = [...expression.matchAll(/\[\s*'((?:[^']|'')*)'\s*\]/g)].map((m) => m[1] ?? '');
  const code = expression.replace(/'(?:[^']|'')*'/g, "''");
  const words: string[] = code.match(/[A-Za-z_][\w-]*/g) ?? [];
  return (
    words.includes('secrets') ||
    WHOLE_CONTEXT.test(code) ||
    // An index the census cannot read, as in env[format('{0}_KEY', x)].
    /\[\s*(?![\d'\s])/.test(code) ||
    [...words, ...indexed].some((name) => SECRET_NAME.test(name) || names.has(name))
  );
}

/** Whether a word, a line or a YAML value uses a secret. */
function usesSecret(raw: string, names: ReadonlySet<string>): boolean {
  for (const m of raw.matchAll(EXPRESSION)) {
    if (expressionUsesSecret(m[1] ?? '', names)) return true;
  }
  const shell = raw.replace(EXPRESSION, '');
  for (const m of [...shell.matchAll(SHELL_VARIABLE), ...shell.matchAll(CURL_VARIABLE)]) {
    const name = m[1] ?? '';
    if (names.has(name) || (/^[A-Za-z_]/.test(name) && SECRET_NAME.test(name))) return true;
    // ${10} and on, when the parameters hold a secret.
    if (/^\d{2,}$/.test(name) && names.has('9')) return true;
  }
  return false;
}

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

/** Index of the quote that closes the $'...' string whose quote is at `open`. */
function ansiQuoteEnd(s: string, open: number): number {
  let j = open + 1;
  while (j < s.length && s.charAt(j) !== "'") j += s.charAt(j) === '\\' ? 2 : 1;
  return Math.min(j, s.length - 1);
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

/** Index of the `)` that closes the array NAME=( ... ) opening at `open`. */
function arrayEnd(s: string, open: number): number {
  let wordStart = true;
  for (let j = open + 1; j < s.length; j++) {
    const ch = s.charAt(j);
    if (ch === ')') return j;
    if (ch === '#' && wordStart) {
      // A comment inside the array: its quotes and parentheses are text.
      const end = s.indexOf('\n', j);
      if (end === -1) return s.length - 1;
      j = end;
      continue;
    }
    if (ch === '\\') j++;
    else if (ch === "'") j = singleQuoteEnd(s, j);
    else if (ch === '"') j = doubleQuoteEnd(s, j);
    else if (ch === '$' && s.charAt(j + 1) === '(') j = closeOf(s, j + 1, '(', ')');
    else if (ch === '$' && s.charAt(j + 1) === '{') j = closeOf(s, j + 1, '{', '}');
    wordStart = /\s/.test(ch);
  }
  return s.length - 1;
}

/** An assignment word: NAME=value, NAME+=value, NAME[i]=value. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/;
/** Reserved words that can come before a command's first word. */
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{', 'time']);

/** Index of the `)` that ends the case pattern starting at `open`: a|b) or (a|b). */
function patternEnd(s: string, open: number): number {
  for (let j = s.charAt(open) === '(' ? open + 1 : open; j < s.length; j++) {
    const ch = s.charAt(j);
    if (ch === '\\') j++;
    else if (ch === "'") j = singleQuoteEnd(s, j);
    else if (ch === '"') j = doubleQuoteEnd(s, j);
    else if (ch === ')') return j;
  }
  return s.length - 1;
}

function parseShell(s: string): Command[] {
  const commands: Command[] = [];
  let line = 1;
  const blank = (): Command => ({ words: [], line, piped: false, nested: [], heredocs: [] });
  let cur = blank();
  // In an object, so what the helpers below assign is not narrowed away.
  const state: {
    word: Word | null;
    heredocNext: { strip: boolean } | null;
    /** Inside [[ ... ]], where && || ( ) are the test's own words. */
    test: boolean;
    /** case WORD read, `in` not yet. */
    casePending: boolean;
    /** `in` read: a pattern comes next, not a command. */
    afterIn: boolean;
    /** A case pattern (a|b) or esac comes next. */
    pattern: boolean;
    caseDepth: number;
  } = {
    word: null,
    heredocNext: null,
    test: false,
    casePending: false,
    afterIn: false,
    pattern: false,
    caseDepth: 0,
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
      const first = cur.words.every((before) => RESERVED.has(before.value));
      if (first && word.raw === '[[') state.test = true;
      else if (state.test && word.raw === ']]') state.test = false;
      else if (first && word.raw === 'case') state.casePending = true;
      else if (state.casePending && word.raw === 'in') {
        state.casePending = false;
        state.afterIn = true;
      } else if (first && word.raw === 'esac' && state.caseDepth > 0) state.caseDepth--;
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
    if (state.afterIn) {
      // case WORD in: what follows is a pattern.
      endCommand();
      state.afterIn = false;
      state.caseDepth++;
      state.pattern = true;
    }
    if (state.pattern && !state.word) {
      const blank = /^[ \t\r\n;]+/.exec(s.slice(i))?.[0] ?? '';
      line += count(blank, '\n');
      i += blank.length;
      cur.line = line;
      if (s.charAt(i) === '#') {
        const end = s.indexOf('\n', i);
        i = end === -1 ? s.length : end;
        continue;
      }
      state.pattern = false;
      if (i >= s.length || /^esac(?![\w-])/.test(s.slice(i))) continue;
      // The pattern is not a command: skip to its `)`.
      const close = patternEnd(s, i);
      line += count(s.slice(i, close), '\n');
      i = close + 1;
      cur.line = line;
      continue;
    }
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
      const end = ansiQuoteEnd(s, i + 1);
      add(s.slice(i, end + 1), s.slice(i + 2, end));
      i = end + 1;
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
      // ;; ;& ;;& end a case item: a pattern or esac comes next.
      const end = /^;;&|^;;|^;&/.exec(s.slice(i))?.[0];
      if (end && state.caseDepth > 0) state.pattern = true;
      i += end?.length ?? 1;
    } else if (state.test && (c === '&' || c === '|') && d === c) {
      // [[ a && b ]]: the test's own operator.
      add(c + d);
      endWord();
      i += 2;
    } else if (state.test && (c === '(' || c === ')')) {
      endWord();
      add(c);
      endWord();
      i++;
    } else if (
      c === '(' &&
      d === '(' &&
      !state.word &&
      cur.words.every((before) => RESERVED.has(before.value))
    ) {
      // (( ... )): arithmetic, not a command.
      const close = closeOf(s, i, '(', ')');
      line += count(s.slice(i, close), '\n');
      i = close + 1;
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
    } else if (
      c === '(' &&
      /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/.test(state.word?.raw ?? '')
    ) {
      // An array, NAME=(a b c): its elements are words, not commands.
      const close = arrayEnd(s, i);
      const raw = s.slice(i, close + 1);
      add(raw);
      line += count(raw, '\n');
      i = close + 1;
    } else if (c === '(' || c === ')') {
      endCommand();
      i++;
    } else if (c === '<' && d === '<') {
      endWord();
      if (s.charAt(i + 2) === '<') {
        // A here-string: the next word is data on standard input.
        add('<<<');
        endWord();
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

/** A redirection; its target is the next word when it stands alone. */
const REDIRECTION = /^(?:\d+|&)?(?:>>?\|?|>&|<<<|<&|<>?)/;
const REDIRECTION_ALONE = /^(?:\d+|&)?(?:>>?\|?|>&|<<<|<&|<>?)$/;

/** How the shell can change a word's text: `splits` when it can make several words. */
function expansion(raw: string): { expands: boolean; splits: boolean } {
  let expands = false;
  let splits = false;
  let quoted = false;
  for (let j = 0; j < raw.length; j++) {
    const ch = raw.charAt(j);
    const next = raw.charAt(j + 1);
    if (ch === '\\') {
      j++;
    } else if (ch === "'" && !quoted) {
      j = singleQuoteEnd(raw, j);
    } else if (ch === '$' && next === "'" && !quoted) {
      j = ansiQuoteEnd(raw, j + 1);
    } else if (ch === '"') {
      quoted = !quoted;
    } else if ((ch === '$' && /[A-Za-z_{(@*#?!$0-9-]/.test(next)) || ch === '`') {
      expands = true;
      if (!quoted) splits = true;
      if (ch === '`') j = backquoteEnd(raw, j);
      else if (next === '{') j = closeOf(raw, j + 1, '{', '}');
      else if (next === '(') j = closeOf(raw, j + 1, '(', ')');
    } else if (!quoted && /[*?[]/.test(ch)) {
      // A pathname the shell may expand into several words.
      splits = true;
    } else if (!quoted && ch === '{' && /^\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/.test(raw.slice(j))) {
      // Brace expansion: {a,b} or {1..3}.
      splits = true;
    }
  }
  return { expands, splits };
}

/** A variable assigned from a secret is one too; so are $1 and on after set -- with one. */
function taint(words: Word[], secretVars: Set<string>): void {
  if (
    words[0]?.value === 'set' &&
    words.slice(1).some((word) => usesSecret(word.raw, secretVars))
  ) {
    for (const name of POSITIONAL) secretVars.add(name);
  }
  const declares = ['export', 'local', 'declare', 'readonly', 'typeset'];
  const list = declares.includes(words[0]?.value ?? '') ? words.slice(1) : words;
  for (const word of list) {
    const m = ASSIGNMENT.exec(word.raw);
    if (m?.[1] && usesSecret(m[2] ?? '', secretVars)) secretVars.add(m[1]);
  }
}

// ─── curl ──────────────────────────────────────────────────────────────────

/**
 * Long options that take a value. From `curl --help all` of curl 8.7.1, with
 * the later ones whose form is certain (ech, ip-tos, keepalive-cnt,
 * vlan-priority, ssl-sessions, upload-flags, sigalgs). help is read as a flag
 * (its category word, then, counts as a URL: stricter, never looser).
 */
const CURL_VALUE_OPTIONS = new Set([
  ...'abstract-unix-socket alt-svc aws-sigv4 cacert capath cert cert-type ciphers config connect-timeout connect-to continue-at cookie cookie-jar create-file-mode crlfile curves data data-ascii data-binary data-raw data-urlencode delegation dns-interface dns-ipv4-addr dns-ipv6-addr dns-servers doh-url dump-header egd-file engine etag-compare etag-save expect100-timeout form form-string ftp-account ftp-alternative-to-user ftp-method ftp-port ftp-ssl-ccc-mode happy-eyeballs-timeout-ms haproxy-clientip header hostpubmd5 hostpubsha256 hsts interface ipfs-gateway json keepalive-time key key-type krb libcurl limit-rate local-port login-options mail-auth mail-from mail-rcpt max-filesize max-redirs max-time netrc-file noproxy oauth2-bearer output output-dir parallel-max pass pinnedpubkey preproxy proto proto-default proto-redir proxy proxy-cacert proxy-capath proxy-cert proxy-cert-type proxy-ciphers proxy-crlfile proxy-header proxy-key proxy-key-type proxy-pass proxy-pinnedpubkey proxy-service-name proxy-tls13-ciphers proxy-tlsauthtype proxy-tlspassword proxy-tlsuser proxy-user proxy1.0 pubkey quote random-file range rate referer request request-target resolve retry retry-delay retry-max-time sasl-authzid service-name socks4 socks4a socks5 socks5-gssapi-service socks5-hostname speed-limit speed-time stderr telnet-option tftp-blksize time-cond tls-max tls13-ciphers tlsauthtype tlspassword tlsuser trace trace-ascii trace-config unix-socket upload-file url url-query user user-agent variable write-out'.split(
    ' ',
  ),
  ...'ech ip-tos keepalive-cnt vlan-priority ssl-sessions upload-flags sigalgs'.split(' '),
]);
/** Long options that take none, from the same sources. */
const CURL_FLAG_OPTIONS = new Set([
  ...'anyauth append basic ca-native cert-status compressed compressed-ssh create-dirs crlf digest disable disable-eprt disable-epsv disallow-username-in-url doh-cert-status doh-insecure fail fail-early fail-with-body false-start form-escape ftp-create-dirs ftp-pasv ftp-pret ftp-skip-pasv-ip ftp-ssl-ccc ftp-ssl-control get globoff haproxy-protocol head help http0.9 http1.0 http1.1 http2 http2-prior-knowledge http3 http3-only ignore-content-length include insecure ipv4 ipv6 junk-session-cookies list-only location location-trusted mail-rcpt-allowfails manual metalink negotiate netrc netrc-optional next no-alpn no-buffer no-clobber no-keepalive no-npn no-progress-meter no-sessionid ntlm ntlm-wb parallel parallel-immediate path-as-is post301 post302 post303 progress-bar proxy-anyauth proxy-basic proxy-ca-native proxy-digest proxy-http2 proxy-insecure proxy-negotiate proxy-ntlm proxy-ssl-allow-beast proxy-ssl-auto-client-cert proxy-tlsv1 proxytunnel raw remote-header-name remote-name remote-name-all remote-time remove-on-error retry-all-errors retry-connrefused sasl-ir show-error silent socks5-basic socks5-gssapi socks5-gssapi-nec ssl ssl-allow-beast ssl-auto-client-cert ssl-no-revoke ssl-reqd ssl-revoke-best-effort sslv2 sslv3 styled-output suppress-connect-headers tcp-fastopen tcp-nodelay tftp-no-options tlsv1 tlsv1.0 tlsv1.1 tlsv1.2 tlsv1.3 tr-encoding trace-ids trace-time use-ascii verbose version xattr'.split(
    ' ',
  ),
  ...'show-headers skip-existing dump-ca-embed tls-earlydata follow out-null'.split(' '),
]);
/** Short options, by their long name. */
const CURL_SHORT: Record<string, string> = {
  '#': 'progress-bar',
  '0': 'http1.0',
  '1': 'tlsv1',
  '2': 'sslv2',
  '3': 'sslv3',
  '4': 'ipv4',
  '6': 'ipv6',
  ':': 'next',
  A: 'user-agent',
  B: 'use-ascii',
  C: 'continue-at',
  D: 'dump-header',
  E: 'cert',
  F: 'form',
  G: 'get',
  H: 'header',
  I: 'head',
  J: 'remote-header-name',
  K: 'config',
  L: 'location',
  M: 'manual',
  N: 'no-buffer',
  O: 'remote-name',
  P: 'ftp-port',
  Q: 'quote',
  R: 'remote-time',
  S: 'show-error',
  T: 'upload-file',
  U: 'proxy-user',
  V: 'version',
  X: 'request',
  Y: 'speed-limit',
  Z: 'parallel',
  a: 'append',
  b: 'cookie',
  c: 'cookie-jar',
  d: 'data',
  e: 'referer',
  f: 'fail',
  g: 'globoff',
  h: 'help',
  i: 'include',
  j: 'junk-session-cookies',
  k: 'insecure',
  l: 'list-only',
  m: 'max-time',
  n: 'netrc',
  o: 'output',
  p: 'proxytunnel',
  q: 'disable',
  r: 'range',
  s: 'silent',
  t: 'telnet-option',
  u: 'user',
  v: 'verbose',
  w: 'write-out',
  x: 'proxy',
  y: 'speed-time',
  z: 'time-cond',
};
/** Options that send a credential of some kind. */
const CREDENTIAL_OPTIONS = new Set([
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
  'proxy-cert',
  'proxy-key',
  'proxy-pass',
  'tlsuser',
  'tlspassword',
  'proxy-tlsuser',
  'proxy-tlspassword',
  'aws-sigv4',
  'login-options',
  'sasl-authzid',
  'krb',
  'delegation',
  'negotiate',
  'proxy-negotiate',
  'ntlm',
  'ntlm-wb',
  'proxy-ntlm',
]);
/** Options that print headers or a trace into the log, or the answer's headers into its output. */
const PRINTING_OPTIONS = new Set([
  'verbose',
  'include',
  'show-headers',
  'trace-config',
  'trace-ids',
  'trace-time',
]);
/** Options whose value is a file curl writes headers, cookies, a trace or the request to. */
const SIDE_OUTPUTS = new Set([
  'dump-header',
  'cookie-jar',
  'etag-save',
  'libcurl',
  'trace',
  'trace-ascii',
  'ssl-sessions',
]);
/** -w variables that hold no header, URL or answer. */
const SAFE_WRITE_OUT = new Set([
  ...'http_code response_code http_connect http_version exitcode method scheme content_type filename_effective local_ip local_port remote_ip remote_port num_certs num_connects num_headers num_redirects num_retries onerror proxy_ssl_verify_result proxy_used ssl_verify_result stderr stdout tls_earlydata urlnum conn_id xfer_id curl_version'.split(
    ' ',
  ),
  ...'size_download size_header size_request size_upload speed_download speed_upload'.split(' '),
  ...'time_appconnect time_connect time_namelookup time_posttransfer time_pretransfer time_queue time_redirect time_starttransfer time_total'.split(
    ' ',
  ),
]);
/** A curl URL glob, {a,b} or [1-3], unless escaped. */
const CURL_GLOB = /(?<!\\)[{[]/;

interface Transfers {
  outputs: string[];
  urls: Word[];
  globoff: boolean;
}

interface Curl {
  /** One per --next: each has its own outputs, URLs and --globoff. */
  segments: Transfers[];
  headers: string[];
  writeOuts: string[];
  sideOutputs: Array<{ option: string; target: string }>;
  variables: string[];
  /** Every other option, by its long name. */
  options: Set<string>;
  /** Options curl's manual does not list. */
  unknown: string[];
  /** "$@", "${ARGS[@]}" and the like: words the census cannot see. */
  lists: string[];
}

/** An expansion into a list of words: $@, $*, ${NAME[@]}, ${NAME[*]}. */
const LIST_EXPANSION = /\$(?:[@*]|\{(?:[@*]|[!#]?[A-Za-z_][A-Za-z0-9_]*\[[@*]\][^}]*)\})/;

function readCurl(args: Word[]): Curl {
  const curl: Curl = {
    segments: [],
    headers: [],
    writeOuts: [],
    sideOutputs: [],
    variables: [],
    options: new Set(),
    unknown: [],
    lists: [],
  };
  let segment: Transfers = { outputs: [], urls: [], globoff: false };
  curl.segments.push(segment);
  const option = (name: string, value: string, word: Word) => {
    if (name === 'output') segment.outputs.push(value);
    else if (name === 'url') segment.urls.push({ raw: word.raw, value });
    else if (name === 'write-out') curl.writeOuts.push(value);
    else if (name === 'header' || name === 'proxy-header') curl.headers.push(value);
    else if (name === 'variable') curl.variables.push(value);
    else if (SIDE_OUTPUTS.has(name)) curl.sideOutputs.push({ option: name, target: value });
    curl.options.add(name);
  };
  const flag = (name: string, on: boolean) => {
    if (name === 'next') {
      segment = { outputs: [], urls: [], globoff: false };
      curl.segments.push(segment);
    } else if (name === 'globoff') {
      segment.globoff = on;
    } else if (on) {
      if (name === 'remote-name' || name === 'remote-name-all') {
        segment.outputs.push('(the remote name)');
      }
      curl.options.add(name);
    }
  };
  const blankWord: Word = { raw: '', value: '' };
  let urlsOnly = false;
  for (let k = 0; k < args.length; k++) {
    const word = args[k] ?? blankWord;
    const arg = word.value;
    if (LIST_EXPANSION.test(word.raw)) curl.lists.push(word.raw);
    if (REDIRECTION.test(arg)) {
      if (REDIRECTION_ALONE.test(arg)) k++;
    } else if (urlsOnly || !arg.startsWith('-') || arg === '-') {
      segment.urls.push(word);
    } else if (arg === '--') {
      urlsOnly = true;
    } else if (arg.startsWith('--')) {
      // --name value, or --name=value: split on the first '='.
      const eq = arg.indexOf('=');
      let name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      if (name.startsWith('expand-') && CURL_VALUE_OPTIONS.has(name.slice(7))) name = name.slice(7);
      if (CURL_VALUE_OPTIONS.has(name)) {
        const valueWord = inline === undefined ? (args[++k] ?? blankWord) : word;
        option(name, inline ?? valueWord.value, valueWord);
      } else if (inline === undefined && CURL_FLAG_OPTIONS.has(name)) {
        flag(name, true);
      } else if (
        inline === undefined &&
        name.startsWith('no-') &&
        CURL_FLAG_OPTIONS.has(name.slice(3))
      ) {
        flag(name.slice(3), false);
      } else {
        curl.unknown.push(arg);
      }
    } else {
      // -sSfL, -o file, -ofile.
      for (let p = 1; p < arg.length; p++) {
        const name = CURL_SHORT[arg.charAt(p)];
        if (name === undefined) {
          curl.unknown.push(`-${arg.charAt(p)}`);
        } else if (CURL_VALUE_OPTIONS.has(name)) {
          const attached = arg.slice(p + 1);
          const valueWord = attached === '' ? (args[++k] ?? blankWord) : word;
          option(name, attached === '' ? valueWord.value : attached, valueWord);
          break;
        } else {
          flag(name, true);
        }
      }
    }
  }
  return curl;
}

/** --variable %NAME imports an environment variable; NAME@file reads a file. */
function variableImportsSecret(spec: string, names: ReadonlySet<string>): boolean {
  const m = /^(%?)([A-Za-z_][A-Za-z0-9_]*)([@=]?)/.exec(spec);
  if (!m?.[2]) return true;
  if (m[3] === '@') return true;
  return m[1] === '%' && (names.has(m[2]) || SECRET_NAME.test(m[2]));
}

function sendsSecret(args: Word[], curl: Curl, names: ReadonlySet<string>): boolean {
  return (
    curl.headers.some((header) => AUTH_HEADER.test(header) || header.startsWith('@')) ||
    [...curl.options].some((name) => CREDENTIAL_OPTIONS.has(name)) ||
    curl.variables.some((spec) => variableImportsSecret(spec, names)) ||
    args.some((word) => usesSecret(word.raw, names))
  );
}

/** A -w format that can print a header, a URL or the answer. */
function printingWriteOut(format: string): boolean {
  // @file or @-, or an expansion: a format the census cannot see.
  if (format.startsWith('@') || /[$`]/.test(format)) return true;
  for (const m of format.matchAll(/%(%|\{([^}]*)\}|([A-Za-z_]+)\{[^}]*\})/g)) {
    if (m[1] === '%' || m[3] === 'time') continue;
    if (m[2] !== undefined && SAFE_WRITE_OUT.has(m[2])) continue;
    return true;
  }
  return false;
}

/** Why the curl's answer, its headers or its URL would reach the log. */
function whyPrinted(curl: Curl, piped: boolean): string[] {
  const why: string[] = [];
  for (const option of curl.unknown) {
    why.push(`${option}: an option curl's manual does not list, so what it prints is unknown`);
  }
  for (const list of curl.lists) {
    why.push(`${list}: a list of words the census cannot see, which may hold options`);
  }
  const urls = curl.segments.reduce((total, segment) => total + segment.urls.length, 0);
  for (const [index, segment] of curl.segments.entries()) {
    // A curl with no URL word reads one from -K: it still needs its -o.
    const needed = Math.max(segment.urls.length, urls === 0 && index === 0 ? 1 : 0);
    if (segment.outputs.length < needed) why.push('an answer is printed (no -o /dev/null for it)');
    for (const output of segment.outputs) {
      if (output !== '/dev/null') why.push(`-o ${output}, not /dev/null`);
    }
    for (const url of segment.urls) {
      const { expands, splits } = expansion(url.raw);
      if (splits) {
        why.push(`URL may expand to several transfers: ${url.raw} (the shell can split it)`);
      } else if (!segment.globoff && (expands || CURL_GLOB.test(url.value))) {
        why.push(`URL may expand to several transfers: ${url.raw} (needs --globoff)`);
      }
    }
  }
  for (const name of curl.options) {
    if (PRINTING_OPTIONS.has(name)) why.push(`--${name}`);
    else if (name === 'output-dir') why.push('--output-dir: no -o stays /dev/null');
    else if (name === 'config') why.push('-K: options from a file the census cannot see');
  }
  for (const { option, target } of curl.sideOutputs) {
    if (target !== '/dev/null') why.push(`--${option} ${target}, not /dev/null`);
  }
  for (const format of curl.writeOuts) {
    if (printingWriteOut(format)) why.push(`--write-out ${format}`);
  }
  if (piped) why.push('its output is piped into another command');
  return [...new Set(why)];
}

// ─── The census ────────────────────────────────────────────────────────────

interface Io {
  /** A repository-relative file's text, or null when there is none. */
  read(path: string): string | null;
  /** The directories directly inside a repository-relative directory. */
  dirs(path: string): string[];
}

interface CurlFound {
  where: string;
  command: string;
  sendsSecret: boolean;
  prints: string[];
}

/** Something a workflow runs that the census cannot read. */
interface Unresolved {
  where: string;
  /** The workflow, script or package.json script it is in. */
  file: string;
  command: string;
  why: string;
}

interface Census {
  curls: CurlFound[];
  /** Every script the census read, besides the workflows. */
  scripts: string[];
  unresolved: Unresolved[];
}

interface Ctx {
  out: Census;
  io: Io;
  /** Names that hold a secret anywhere: what the workflows map or write from one. */
  names: Set<string>;
}

interface Scope {
  /** The names above, plus what this script assigned from one. */
  secretVars: Set<string>;
  cwd: string;
  depth: number;
}

interface Source {
  file: string;
  /** Where the command on line `n` of the script is. */
  where(n: number): string;
}

const fileSource = (file: string, first = 1): Source => ({
  file,
  where: (n) => `${file}:${first + n - 1}`,
});
const fixedSource = (file: string, where: string): Source => ({ file, where: () => where });

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh']);
/** Programs that run code the census cannot read. */
const RUNNER = new RegExp(
  `^(?:${[
    // Interpreters.
    'node(?:js)?|deno|bun|tsx|ts-node|vite-node|babel-node|(?:python|pypy)[\\d.]*|ruby[\\d.]*',
    'perl[\\d.]*|php[\\d.]*|lua[\\d.]*|Rscript|pwsh|powershell|osascript|expect|tclsh',
    // Task runners and fan-outs.
    'g?make|just|task|mage|rake|gradlew?|mvn|ant|bazel|nx|lerna|rush|npm-run-all|run-[sp]',
    'concurrently',
    // Programs that run another command, here or elsewhere.
    'xargs|parallel|watch|flock|script|ssh|docker|podman|kubectl|su|runuser|chroot|nsenter',
    'unshare|systemd-run|firejail|caffeinate|strace|ltrace|valgrind|gdb',
  ].join('|')})$`,
);
const HTTP_CLIENTS = new Set(['wget', 'http', 'https', 'httpie', 'xh', 'xhs', 'aria2c', 'curlie']);
/** Words before the command itself that take no option. */
const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  '!',
  '{',
  '}',
  'coproc',
  'builtin',
]);

interface Wrapper {
  /** Options that take a value: the next word, `=value`, or attached to a short one. */
  values: string[];
  /** Options that take none. */
  flags: string[];
  /** Words it reads before the command: timeout's duration. */
  operands?: number;
  /** Options after which no command runs: command -v. */
  stops?: string[];
}
/** Programs that run the command after their own options. */
const WRAPPERS: Record<string, Wrapper> = {
  time: { values: [], flags: ['-p'] },
  nohup: { values: [], flags: [] },
  exec: { values: ['-a'], flags: ['-c', '-l'] },
  command: { values: [], flags: ['-p'], stops: ['-v', '-V'] },
  env: {
    values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-P'],
    flags: ['-', '-i', '--ignore-environment', '-0', '--null', '-v', '--debug'],
  },
  sudo: {
    values: [
      ...['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host'],
      ...['-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout'],
      ...['-U', '--other-user', '-R', '--chroot'],
    ],
    flags: [
      ...['-A', '--askpass', '-b', '--background', '-B', '--bell', '-E', '--preserve-env'],
      ...['-H', '--set-home', '-i', '--login', '-k', '--reset-timestamp', '-n'],
      ...['--non-interactive', '-N', '--no-update', '-P', '--preserve-groups', '-S'],
      ...['--stdin', '-s', '--shell'],
    ],
    stops: ['-l', '--list', '-v', '--validate', '-V', '--version', '-K', '--remove-timestamp'],
  },
  doas: { values: ['-u', '-C'], flags: ['-n', '-s', '-L'] },
  timeout: {
    values: ['-s', '--signal', '-k', '--kill-after'],
    flags: ['--preserve-status', '--foreground', '-v', '--verbose', '-f', '-p'],
    operands: 1,
  },
  nice: { values: ['-n', '--adjustment'], flags: [] },
  ionice: { values: ['-c', '--class', '-n', '--classdata'], flags: ['-t', '--ignore'] },
  stdbuf: { values: ['-i', '--input', '-o', '--output', '-e', '--error'], flags: [] },
  setsid: { values: [], flags: ['-c', '--ctty', '-f', '--fork', '-w', '--wait'] },
  chronic: { values: [], flags: ['-e', '-v'] },
  unbuffer: { values: [], flags: ['-p'] },
};
const MAX_DEPTH = 8;

function noteScript(out: Census, name: string): void {
  if (!out.scripts.includes(name)) out.scripts.push(name);
}

function text(words: Word[]): string {
  return words.map((word) => word.raw).join(' ');
}

function cannotRead(ctx: Ctx, src: Source, where: string, command: string, why: string): void {
  ctx.out.unresolved.push({ where, file: src.file, command, why });
}

/** False, and unresolved, past the depth limit. */
function deepEnough(ctx: Ctx, scope: Scope, src: Source, where: string, command: string): boolean {
  if (scope.depth <= MAX_DEPTH) return true;
  cannotRead(ctx, src, where, command, `the census stops ${MAX_DEPTH} calls deep`);
  return false;
}

/** The arguments of a call with a secret make $1, $@ and the rest secrets. */
function withArguments(scope: Scope, args: Word[]): Scope {
  if (!args.some((word) => usesSecret(word.raw, scope.secretVars))) return scope;
  return { ...scope, secretVars: new Set([...scope.secretVars, ...POSITIONAL]) };
}

/** `--name=value` as [name, value], or [word, undefined]. */
function splitOption(word: string): [string, string | undefined] {
  const eq = word.startsWith('--') ? word.indexOf('=') : -1;
  return eq === -1 ? [word, undefined] : [word.slice(0, eq), word.slice(eq + 1)];
}

/**
 * The command's own words: keywords, assignments, redirections and wrappers
 * before it removed. Null when a wrapper has an option the census cannot read.
 */
function unwrap(words: Word[], cannot: (why: string) => void): Word[] | null {
  let rest = words;
  let k = 0;
  while (k < rest.length) {
    const word = rest[k] ?? { raw: '', value: '' };
    if (KEYWORDS.has(word.value) || ASSIGNMENT.test(word.raw)) {
      k++;
      continue;
    }
    if (word.value === 'function' && k + 1 < rest.length) {
      // function NAME { ...: the body's first command follows.
      k += 2;
      continue;
    }
    if (REDIRECTION.test(word.value)) {
      k += REDIRECTION_ALONE.test(word.value) ? 2 : 1;
      continue;
    }
    // /usr/bin/env and /usr/bin/sudo are env and sudo.
    const name = word.value.startsWith('/') ? (word.value.split('/').pop() ?? '') : word.value;
    const wrapper = WRAPPERS[name];
    if (!wrapper) break;
    k++;
    for (; k < rest.length; k++) {
      const arg = rest[k]?.value ?? '';
      if (arg === '--') {
        k++;
        break;
      }
      if (!arg.startsWith('-') || (arg === '-' && !wrapper.flags.includes('-'))) break;
      if (wrapper.stops?.includes(arg)) return [];
      const [option, inline] = splitOption(arg);
      if (wrapper.values.includes(option)) {
        const value = inline ?? rest[++k]?.value ?? '';
        if (option === '-S' || option === '--split-string') {
          // env -S 'a b': the string's words are env's next arguments, then the rest.
          rest = [...(parseShell(value)[0]?.words ?? []), ...rest.slice(k + 1)];
          k = -1;
        }
      } else if (wrapper.flags.includes(option) || (name === 'nice' && /^-\d+$/.test(arg))) {
        // A flag, or nice's -10.
      } else if (!arg.startsWith('--')) {
        // A group of short options: -nE, -uroot.
        let ok = true;
        for (let p = 1; p < arg.length && ok; p++) {
          const short = `-${arg.charAt(p)}`;
          if (wrapper.stops?.includes(short)) return [];
          if (wrapper.values.includes(short)) {
            if (p === arg.length - 1) k++;
            break;
          }
          ok = wrapper.flags.includes(short);
        }
        if (!ok) {
          cannot(`${name} ${arg}: an option the census cannot read`);
          return null;
        }
      } else {
        cannot(`${name} ${arg}: an option the census cannot read`);
        return null;
      }
    }
    k += wrapper.operands ?? 0;
  }
  return rest.slice(k);
}

/** Function names a script defines: name() { ... } or function name { ... }. */
function functionNames(script: string): Set<string> {
  const names = new Set<string>();
  for (const m of script.matchAll(/(?:^|[\s;&|{(])(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)/g)) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of script.matchAll(/\bfunction\s+([A-Za-z_][\w-]*)/g)) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

/** A line written to $GITHUB_ENV or $GITHUB_OUTPUT with a secret makes its name one. */
function taintGithubFiles(command: Command, secretVars: ReadonlySet<string>, ctx: Ctx): boolean {
  const lines = [
    ...command.words.map((word) => word.raw),
    ...command.heredocs.flatMap((body) => body.split('\n')),
  ];
  const secret = lines.some((line) => usesSecret(line, secretVars));
  for (const line of lines) {
    // NAME=value, or NAME<<DELIMITER for a value over several lines.
    const m = /^["']?([A-Za-z_][\w-]*)(=|<<)/.exec(line);
    if (m?.[1] && (m[2] === '<<' ? secret : usesSecret(line, secretVars))) ctx.names.add(m[1]);
  }
  return secret && lines.some((line) => /\bGITHUB_(?:ENV|OUTPUT)\b/.test(line));
}

function walk(script: string, src: Source, scope: Scope, ctx: Ctx): void {
  const functions = functionNames(script);
  const writesGithubFiles = /\bGITHUB_(?:ENV|OUTPUT)\b/.test(script);
  const pass = (secretVars: Set<string>): boolean => {
    let secretToFunction = false;
    let secretToGithubFile = false;
    const multiline: string[] = [];
    for (const command of parseShell(script)) {
      taint(command.words, secretVars);
      if (writesGithubFiles) {
        secretToGithubFile = taintGithubFiles(command, secretVars, ctx) || secretToGithubFile;
        for (const word of command.words) {
          const m = /^["']?([A-Za-z_][\w-]*)<</.exec(word.raw);
          if (m?.[1]) multiline.push(m[1]);
        }
      }
      const where = src.where(command.line);
      const inner: Scope = { ...scope, secretVars, depth: scope.depth + 1 };
      for (const nested of command.nested) {
        const at = src.where(nested.line);
        if (!deepEnough(ctx, inner, src, at, `$(${nested.script.trim()})`)) continue;
        walk(nested.script, fixedSource(src.file, at), inner, ctx);
      }
      const words = dispatch(command.words, command, src, where, inner, ctx);
      const name = words?.[0]?.value ?? '';
      if (
        functions.has(name) &&
        (words ?? []).slice(1).some((word) => usesSecret(word.raw, secretVars))
      ) {
        secretToFunction = true;
      }
    }
    // NAME<<EOF, then the value written by later commands.
    if (secretToGithubFile) for (const name of multiline) ctx.names.add(name);
    return secretToFunction;
  };
  if (pass(new Set(scope.secretVars)) && !POSITIONAL.every((p) => scope.secretVars.has(p))) {
    // A function was called with a secret: read its $1 and $@ as secrets.
    pass(new Set([...scope.secretVars, ...POSITIONAL]));
  }
}

/** Runs one command's words; returns them unwrapped, or null when unresolved. */
function dispatch(
  all: Word[],
  command: Command,
  src: Source,
  where: string,
  scope: Scope,
  ctx: Ctx,
): Word[] | null {
  const words = unwrap(all, (why) => cannotRead(ctx, src, where, text(all), why));
  const program = words?.[0];
  if (!words || !program) return words;
  const args = words.slice(1);
  const cannot = (why: string) => {
    cannotRead(ctx, src, where, text(words), why);
    return words;
  };
  if (expansion(program.raw).expands) return cannot('a program named by an expansion');
  const name = program.value.split('/').pop() ?? '';
  if (name === 'curl' || name === 'curl.exe') {
    const curl = readCurl(args);
    ctx.out.curls.push({
      where,
      command: text(command.words),
      sendsSecret: sendsSecret(args, curl, scope.secretVars),
      prints: whyPrinted(curl, command.piped),
    });
  } else if (SHELLS.has(name)) {
    runShell(args, command, src, where, text(words), scope, ctx);
  } else if (name === 'source' || name === '.') {
    if (args[0]) runFile(args[0], args.slice(1), src, where, text(words), scope, ctx);
  } else if (name === 'eval') {
    if (args.some((word) => expansion(word.raw).expands))
      return cannot('eval of text the census cannot see');
    if (deepEnough(ctx, scope, src, where, text(words))) {
      walk(args.map((word) => word.value).join(' '), fixedSource(src.file, where), scope, ctx);
    }
  } else if (name === 'trap') {
    const handler = args[0];
    if (!handler || handler.value === '' || /^-[lp]?$/.test(handler.value)) return words;
    if (expansion(handler.raw).expands) return cannot('a trap the census cannot see');
    if (deepEnough(ctx, scope, src, where, text(words))) {
      walk(handler.value, fixedSource(src.file, where), scope, ctx);
    }
  } else if (name === 'find') {
    for (let k = 0; k < args.length; k++) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[k]?.value ?? '')) continue;
      let end = k + 1;
      while (end < args.length && !/^[;+]$/.test(args[end]?.value ?? '')) end++;
      dispatch(args.slice(k + 1, end), command, src, where, scope, ctx);
      k = end;
    }
  } else if (name === 'pnpm' || name === 'npm' || name === 'yarn') {
    runPackageManager(name, args, command, src, where, text(words), scope, ctx);
  } else if (name === 'npx' || name === 'bunx') {
    runPackageBin(name, args, command, src, where, text(words), scope, ctx);
  } else if (name === 'turbo') {
    runTurbo(args, src, where, text(words), scope, ctx);
  } else if (RUNNER.test(name)) {
    return cannot(`${name} runs code the census cannot read`);
  } else if (HTTP_CLIENTS.has(name) || (name === 'gh' && args[0]?.value === 'api')) {
    return cannot('an HTTP client the census does not judge');
  } else if (/\.(?:ba|z|k|da)?sh$/.test(program.value)) {
    runFile(program, args, src, where, text(words), scope, ctx);
  } else if (program.value.includes('/') && !program.value.startsWith('/')) {
    runRepoProgram(program, args, src, where, text(words), scope, ctx);
  } else if (!PRINTS_ITS_ARGUMENTS.has(name) && runsCurl(args)) {
    // gtimeout 90 curl ..., retry -- curl ...: a wrapper WRAPPERS does not list.
    return cannot(`${name} has a curl command among its arguments, which it may run`);
  }
  return words;
}

/** Programs that print their arguments, which may name curl. */
const PRINTS_ITS_ARGUMENTS = new Set(['echo', 'printf']);

/**
 * `curl` and then a URL or an expansion: a curl command, not the word alone
 * (apt-get install -y curl).
 */
function runsCurl(args: Word[]): boolean {
  const at = args.findIndex((word) => /^(?:\S*\/)?curl(?:\.exe)?$/.test(word.value));
  return (
    at !== -1 &&
    args.slice(at + 1).some((word) => word.value.includes('://') || expansion(word.raw).expands)
  );
}

function runShell(
  args: Word[],
  command: Command,
  src: Source,
  where: string,
  call: string,
  scope: Scope,
  ctx: Ctx,
): void {
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]?.value ?? '';
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
      // bash -c 'script' name args...
      if (deepEnough(ctx, scope, src, where, call)) {
        const inline = args[k + 1]?.value ?? '';
        walk(inline, fixedSource(src.file, where), withArguments(scope, args.slice(k + 2)), ctx);
      }
      return;
    }
    // -o pipefail, -euxo pipefail: the option's name is the next word.
    if (/^[-+][A-Za-z]*[oO]$/.test(arg) || REDIRECTION_ALONE.test(arg)) k++;
    else if (!/^[-+]/.test(arg) && !REDIRECTION.test(arg)) {
      const file = args[k];
      if (file) runFile(file, args.slice(k + 1), src, where, call, scope, ctx);
      return;
    }
  }
  // bash <<EOF, or bash -s: the script is the here-document.
  if (command.heredocs.length === 0) {
    // curl ... | bash, or bash < file: a script from standard input.
    cannotRead(ctx, src, where, call, 'a shell reading its script from standard input');
    return;
  }
  if (!deepEnough(ctx, scope, src, where, call)) return;
  for (const body of command.heredocs) walk(body, fixedSource(src.file, where), scope, ctx);
}

/** A script path, resolved against the step's directory, then the repository. */
function findFile(path: string, scope: Scope, io: Io): string | undefined {
  return [posix.join(scope.cwd, path), posix.normalize(path)].find(
    (candidate) => io.read(candidate) !== null,
  );
}

function runFile(
  path: Word,
  args: Word[],
  src: Source,
  where: string,
  call: string,
  scope: Scope,
  ctx: Ctx,
): void {
  if (expansion(path.raw).expands || path.value.startsWith('/')) {
    cannotRead(ctx, src, where, call, 'a script the census cannot find');
    return;
  }
  const found = findFile(path.value, scope, ctx.io);
  if (!found) {
    cannotRead(ctx, src, where, call, 'no such file in the repository');
    return;
  }
  if (!deepEnough(ctx, scope, src, where, call)) return;
  noteScript(ctx.out, found);
  walk(ctx.io.read(found) ?? '', fileSource(found), withArguments(scope, args), ctx);
}

/** ./x: a shell script by its first line, or a program the census cannot read. */
function runRepoProgram(
  program: Word,
  args: Word[],
  src: Source,
  where: string,
  call: string,
  scope: Scope,
  ctx: Ctx,
): void {
  const found = findFile(program.value, scope, ctx.io);
  if (!found) {
    cannotRead(ctx, src, where, call, 'no such file in the repository');
  } else if (/^#!\S*?(?:\/env\s+)?\S*\b(?:ba|z|k|da|mk)?sh\b/.test(ctx.io.read(found) ?? '')) {
    runFile(program, args, src, where, call, scope, ctx);
  } else {
    cannotRead(ctx, src, where, call, 'a repository program that is not a shell script');
  }
}

// ─── Package managers and turbo ────────────────────────────────────────────

interface ManagerOptions {
  values: string[];
  flags: string[];
  /** Options that run the command in several workspace packages. */
  fanOut: string[];
}
/** The options each reads before its command; anything else is unresolved. */
const MANAGER_OPTIONS: Record<string, ManagerOptions> = {
  pnpm: {
    values: [
      ...['-C', '--dir', '--filter', '-F', '--filter-prod', '--workspace-concurrency'],
      ...['--reporter', '--loglevel', '--resume-from', '--test-pattern'],
      '--changed-files-ignore-pattern',
    ],
    flags: [
      ...['-r', '--recursive', '-w', '--workspace-root', '-s', '--silent', '--stream'],
      ...['--parallel', '--aggregate-output', '--if-present', '--no-bail', '--bail'],
      ...['--sort', '--no-sort', '--reverse', '--include-workspace-root'],
      ...['--fail-if-no-match', '--report-summary', '--use-stderr', '--color', '--no-color'],
    ],
    fanOut: ['-r', '--recursive', '--filter', '-F', '--filter-prod'],
  },
  npm: {
    values: ['--prefix', '-w', '--workspace'],
    flags: ['-s', '--silent', '-q', '--quiet', '--if-present', '-ws', '--workspaces'],
    fanOut: ['-w', '--workspace', '-ws', '--workspaces', '--include-workspace-root'],
  },
  yarn: {
    values: ['--cwd'],
    flags: ['-s', '--silent'],
    fanOut: [],
  },
};
/** Commands that run the lifecycle scripts of the root and every workspace package. */
const LIFECYCLE_COMMANDS = new Set([
  ...['install', 'i', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un'],
  ...['rebuild', 'rb', 'link', 'ln', 'unlink', 'import', 'prune', 'dedupe', 'ci'],
  ...['install-test', 'it', 'install-ci-test', 'cit', 'pack', 'publish', 'deploy'],
]);
const LIFECYCLE_SCRIPTS = [
  ...['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare'],
  ...['postprepare', 'prepublishOnly', 'prepack', 'postpack', 'publish', 'postpublish'],
  'dependencies',
];
/** Commands that run no script of ours. */
const MANAGER_BUILTINS = new Set([
  ...['audit', 'approve-builds', 'bin', 'cache', 'config', 'create', 'doctor', 'env'],
  ...['fetch', 'help', 'init', 'licenses', 'list', 'ls', 'outdated', 'patch'],
  ...['patch-commit', 'root', 'setup', 'store', 'why', 'info', 'view', 'whoami'],
]);
const NPM_SCRIPT_COMMANDS = new Set(['test', 't', 'tst', 'start', 'stop', 'restart']);

function readScripts(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

/** The workspace's package directories (pnpm-workspace.yaml, else package.json workspaces). */
function workspacePackages(io: Io, includeRoot: boolean): string[] {
  const globs: string[] = [];
  const yaml = io.read('pnpm-workspace.yaml');
  if (yaml !== null) {
    let inPackages = false;
    for (const line of yaml.split('\n')) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const m = /^\s+-\s*(.+?)\s*$/.exec(line);
        if (m?.[1]) globs.push(yamlScalar(m[1]));
      }
    }
  } else {
    try {
      const pkg = JSON.parse(io.read('package.json') ?? '{}') as {
        workspaces?: string[] | { packages?: string[] };
      };
      const list = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      globs.push(...(list ?? []));
    } catch {
      // No workspaces.
    }
  }
  const expand = (glob: string): string[] => {
    let dirs = ['.'];
    for (const part of glob.replace(/\/+$/, '').split('/')) {
      if (part === '**') {
        const all = [...dirs];
        for (let level = 0, edge = dirs; level < 4; level++) {
          edge = edge.flatMap((dir) => io.dirs(dir).map((name) => posix.join(dir, name)));
          all.push(...edge);
        }
        dirs = all;
      } else if (part.includes('*')) {
        const pattern = new RegExp(
          `^${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
        );
        dirs = dirs.flatMap((dir) =>
          io
            .dirs(dir)
            .filter((name) => pattern.test(name))
            .map((name) => posix.join(dir, name)),
        );
      } else {
        dirs = dirs.map((dir) => posix.join(dir, part));
      }
    }
    return dirs;
  };
  const packages = new Set<string>();
  for (const glob of globs.filter((g) => !g.startsWith('!'))) {
    for (const dir of expand(glob)) {
      if (io.read(posix.join(dir, 'package.json')) !== null) packages.add(dir);
    }
  }
  for (const glob of globs.filter((g) => g.startsWith('!'))) {
    for (const dir of expand(glob.slice(1))) packages.delete(dir);
  }
  return [...(includeRoot ? ['.'] : []), ...[...packages].sort()];
}

/** Runs a package.json script (with its pre and post scripts) in each directory. */
function runScript(
  name: string,
  dirs: string[],
  fanOut: boolean,
  src: Source,
  where: string,
  call: string,
  scope: Scope,
  ctx: Ctx,
): boolean {
  let found = false;
  for (const dir of dirs) {
    const packageJson = posix.join(dir, 'package.json');
    const pkg = ctx.io.read(packageJson);
    if (pkg === null) {
      if (!fanOut) cannotRead(ctx, src, where, call, `no ${packageJson}`);
      continue;
    }
    const scripts = readScripts(pkg);
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      const body = scripts[hook];
      if (typeof body !== 'string') continue;
      if (hook === name) found = true;
      const file = `${packageJson} scripts["${hook}"]`;
      if (!deepEnough(ctx, scope, src, where, call)) return found;
      noteScript(ctx.out, file);
      walk(body, fixedSource(file, file), { ...scope, cwd: dir }, ctx);
    }
  }
  return found;
}

function runPackageManager(
  manager: string,
  args: Word[],
  command: Command,
  src: Source,
  where: string,
  call: string,
  scope: Scope,
  ctx: Ctx,
): void {
  const options = MANAGER_OPTIONS[manager] ?? { values: [], flags: [], fanOut: [] };
  const cannot = (why: string) => cannotRead(ctx, src, where, call, why);
  let cwd = scope.cwd;
  let k = 0;
  for (; k < args.length; k++) {
    const arg = args[k]?.value ?? '';
    if (!arg.startsWith('-')) break;
    const [option, inline] = splitOption(arg);
    if (options.values.includes(option)) {
      const value = inline ?? args[++k]?.value ?? '';
      if (['-C', '--dir', '--prefix', '--cwd'].includes(option)) cwd = posix.join(cwd, value);
    } else if (!options.flags.includes(option)) {
      cannot(`${manager} ${arg}: an option the census cannot read`);
      return;
    }
  }
  // A fan-out option may also follow the command (pnpm test --filter x).
  const fanOut = args.some((word) => options.fanOut.includes(splitOption(word.value)[0]));
  const includeRoot = args.some((word) => word.value === '--include-workspace-root');
  const [first, ...rest] = args.slice(k);
  const inScope: Scope = { ...scope, cwd };
  const sub = first?.value ?? 'install';
  if (fanOut && manager !== 'pnpm') {
    cannot(`a ${manager} workspace fan-out, which the census does not follow`);
  } else if (sub === 'workspace' || sub === 'workspaces') {
    cannot(`a ${manager} workspace fan-out, which the census does not follow`);
  } else if (sub === 'exec' || sub === 'x' || sub === 'dlx') {
    runPackageBin(`${manager} ${sub}`, rest, command, src, where, call, inScope, ctx);
  } else if (LIFECYCLE_COMMANDS.has(sub)) {
    // Installing runs our own install and prepare scripts.
    const dirs = ['.', ...workspacePackages(ctx.io, false)];
    for (const hook of LIFECYCLE_SCRIPTS)
      runScript(hook, dirs, true, src, where, call, inScope, ctx);
  } else if (!MANAGER_BUILTINS.has(sub)) {
    let script = sub;
    let extra = rest;
    if (sub === 'run' || sub === 'run-script') {
      script = rest[0]?.value ?? '';
      extra = rest.slice(1);
    } else if (manager === 'npm' && !NPM_SCRIPT_COMMANDS.has(sub)) {
      return;
    }
    if (!script) return;
    let dirs = [cwd];
    if (fanOut) {
      dirs = workspacePackages(
        ctx.io,
        includeRoot || args.some((w) => /^--filter|^-F/.test(w.value)),
      );
      if (dirs.length === 0) {
        cannot('a workspace fan-out, but the census found no workspace packages');
        return;
      }
    }
    const found = runScript(script, dirs, fanOut, src, where, call, inScope, ctx);
    // pnpm and yarn run a package's binary when no script has the name.
    if (!found && !fanOut && manager !== 'npm') {
      dispatch([{ raw: script, value: script }, ...extra], command, src, where, inScope, ctx);
    }
  }
}

/** pnpm exec, pnpm dlx, npm exec, npx, yarn dlx, bunx: the rest is a command. */
function runPackageBin(
  runner: string,
  args: Word[],
  command: Command,
  src: Source,
  where: string,
  call: string,
  scope: Scope,
  ctx: Ctx,
): void {
  const pnpmStyle = runner.startsWith('pnpm');
  let shell = false;
  let named = false;
  let k = 0;
  for (; k < args.length; k++) {
    const arg = args[k]?.value ?? '';
    if (arg === '--') {
      k++;
      break;
    }
    if (!arg.startsWith('-')) break;
    const [option, inline] = splitOption(arg);
    if (option === '-c' || option === '--call' || option === '--shell-mode') {
      if (!pnpmStyle && option !== '--shell-mode') {
        // npx -c 'command': the value is a script.
        const value = inline ?? args[k + 1]?.value ?? '';
        if (deepEnough(ctx, scope, src, where, call)) {
          walk(value, fixedSource(src.file, where), scope, ctx);
        }
        return;
      }
      shell = true;
    } else if (option === '--package' || option === '-p') {
      if (inline === undefined) k++;
      named = true;
    } else if (
      ![
        ...['-y', '--yes', '--no', '-q', '--quiet', '-s', '--silent', '--parallel'],
        ...['-r', '--recursive', '--no-bail', '--report-summary', '--allow-build'],
      ].includes(option)
    ) {
      cannotRead(ctx, src, where, call, `${runner} ${arg}: an option the census cannot read`);
      return;
    }
  }
  const words = args.slice(k);
  if (shell) {
    if (deepEnough(ctx, scope, src, where, call)) {
      walk(words.map((word) => word.value).join(' '), fixedSource(src.file, where), scope, ctx);
    }
    return;
  }
  const first = words[0];
  if (!first) return;
  // A package to fetch and run: name@version, @scope/name@version.
  const fetched = !named && /dlx|npx|bunx/.test(runner);
  const program = fetched
    ? first.value.replace(/^(@[^/]+\/)?([^@]+)(@.*)?$/, '$2') || first.value
    : first.value;
  dispatch(
    [{ raw: fetched ? program : first.raw, value: program }, ...words.slice(1)],
    command,
    src,
    where,
    scope,
    ctx,
  );
}

/** turbo run a b (or turbo a b): each task's script in every workspace package. */
function runTurbo(
  args: Word[],
  src: Source,
  where: string,
  call: string,
  scope: Scope,
  ctx: Ctx,
): void {
  const cannot = (why: string) => cannotRead(ctx, src, where, call, why);
  const first = args[0]?.value ?? '';
  if (first === 'gen' || first === 'generate') {
    cannot('turbo gen runs generators the census cannot read');
    return;
  }
  if (
    ['prune', 'login', 'logout', 'link', 'unlink', 'daemon', 'ls', 'info', 'telemetry'].includes(
      first,
    ) ||
    ['query', 'boundaries', 'scan', 'bin', 'completion', 'devtools', 'docs'].includes(first)
  ) {
    return;
  }
  const values = [
    ...['--filter', '-F', '--concurrency', '--cache-dir', '--output-logs', '--log-order'],
    ...['--log-prefix', '--ui', '--env-mode', '--cache', '--profile', '--global-deps'],
    ...['--token', '--team', '--api', '--login', '--graph', '--summarize', '--dry', '--dry-run'],
  ];
  const flags = [
    ...['--continue', '--force', '--parallel', '--no-cache', '--only', '--affected'],
    ...['--no-daemon', '--daemon', '--remote-only', '--single-package', '--framework-inference'],
  ];
  const tasks: string[] = [];
  for (let k = first === 'run' || first === 'watch' ? 1 : 0; k < args.length; k++) {
    const arg = args[k]?.value ?? '';
    if (arg === '--') break;
    if (arg.startsWith('-')) {
      const [option, inline] = splitOption(arg);
      if (values.includes(option)) {
        // --graph, --summarize and --dry take an optional value: only an inline one.
        if (
          inline === undefined &&
          !['--graph', '--summarize', '--dry', '--dry-run'].includes(option)
        )
          k++;
      } else if (!flags.includes(option)) {
        cannot(`turbo ${arg}: an option the census cannot read`);
        return;
      }
    } else {
      tasks.push(arg.includes('#') ? arg.slice(arg.indexOf('#') + 1) : arg);
    }
  }
  // turbo.json: what each task depends on, as ^build or pkg#build.
  let config: Record<string, { dependsOn?: string[] }> = {};
  const turboJson = ctx.io.read('turbo.json');
  if (turboJson !== null) {
    try {
      const parsed = JSON.parse(turboJson) as {
        tasks?: Record<string, { dependsOn?: string[] }>;
        pipeline?: Record<string, { dependsOn?: string[] }>;
      };
      config = parsed.tasks ?? parsed.pipeline ?? {};
    } catch {
      cannot('a turbo.json the census cannot read');
      return;
    }
  }
  const taskName = (key: string) => key.replace(/^\^/, '').replace(/^.*#/, '');
  const closure = new Set(tasks);
  for (let grew = true; grew;) {
    grew = false;
    for (const [key, task] of Object.entries(config)) {
      if (!closure.has(taskName(key))) continue;
      for (const dep of task.dependsOn ?? []) {
        if (dep.startsWith('$') || closure.has(taskName(dep))) continue;
        closure.add(taskName(dep));
        grew = true;
      }
    }
  }
  const packages = workspacePackages(ctx.io, false);
  if (packages.length === 0) {
    cannot('a turbo fan-out, but the census found no workspace packages');
    return;
  }
  for (const task of closure) {
    // A root task is //#task in turbo.json.
    const dirs = `//#${task}` in config ? ['.', ...packages] : packages;
    runScript(task, dirs, true, src, where, call, scope, ctx);
  }
}

// ─── Workflows ─────────────────────────────────────────────────────────────

interface RunBlock {
  /** 1-based line of the block's first script line. */
  line: number;
  script: string;
  cwd: string;
  /** The shell the step names, when it is not bash or sh. */
  foreignShell?: string;
  /** A YAML alias the census does not follow. */
  alias?: string;
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

/** A `defaults: run: <key>:` anywhere in the file. */
function defaultsRun(lines: string[], key: string): string | undefined {
  for (const [i, line] of lines.entries()) {
    const m = new RegExp(`^(\\s*)${key}:\\s*(.+)$`).exec(line);
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

/** The lines of the step (or job) whose key at `column` is on line `index`. */
function stepLines(lines: string[], index: number, column: number): { start: number; end: number } {
  const lineAt = (i: number) => lines[i] ?? '';
  const meaningful = (line: string) => line.trim() !== '' && !line.trim().startsWith('#');
  let start = index;
  while (start > 0 && !(/^\s*-\s/.test(lineAt(start)) && keyColumn(lineAt(start)) === column)) {
    if (start < index && meaningful(lineAt(start)) && indentOf(lineAt(start)) < column) {
      start++;
      break;
    }
    start--;
  }
  let end = start + 1;
  for (; end < lines.length; end++) {
    const line = lineAt(end);
    if (!meaningful(line)) continue;
    if (indentOf(line) < column) break;
    if (/^\s*-\s/.test(line) && keyColumn(line) === column) break;
  }
  return { start, end };
}

/** The step's own `<key>:`, beside its `run:` or `uses:`. */
function stepKey(lines: string[], index: number, column: number, key: string): string | undefined {
  const { start, end } = stepLines(lines, index, column);
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? '';
    const m = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.+)$`).exec(line);
    if (m && keyColumn(line) === column) return yamlScalar((m[1] ?? '').trim());
  }
  return undefined;
}

/**
 * A folded block scalar (`run: >`): a line break between two lines of text
 * is a space, but a more-indented line keeps the breaks around it, and an
 * empty line is a break of its own.
 */
function folded(lines: string[]): string {
  let script = '';
  let previous: 'none' | 'text' | 'other' = 'none';
  for (const line of lines) {
    const kind = line.trim() === '' || /^\s/.test(line) ? 'other' : 'text';
    if (previous === 'none') script = line;
    else script += kind === 'text' && previous === 'text' ? ` ${line}` : `\n${line}`;
    previous = kind;
  }
  return script;
}

function runBlocks(text: string): RunBlock[] {
  const lines = text.split('\n');
  const defaultCwd = defaultsRun(lines, 'working-directory') ?? '.';
  // A Windows runner's default shell is PowerShell (runs-on: windows-latest, or in a matrix).
  const defaultShell =
    defaultsRun(lines, 'shell') ?? (/\bwindows-\w/i.test(text) ? 'pwsh' : 'bash');
  const blocks: RunBlock[] = [];
  const lineAt = (index: number) => lines[index] ?? '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(-\s+)?run:[ \t]*(.*)$/.exec(lineAt(i));
    if (!m) continue;
    const column = keyColumn(lineAt(i));
    // An anchor names the value; an alias reuses one from elsewhere.
    const value = (m[3] ?? '').trim().replace(/^&[\w-]+\s*/, '');
    const cwd = stepKey(lines, i, column, 'working-directory') ?? defaultCwd;
    const shell = stepKey(lines, i, column, 'shell') ?? defaultShell;
    const foreignShell = /^(?:\/\S*\/)?(?:bash|sh)\b/.test(shell) ? undefined : shell;
    if (value.startsWith('*')) {
      blocks.push({ line: i + 1, script: '', cwd, alias: value });
    } else if (/^[|>]/.test(value)) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lineAt(j).trim() !== '' && indentOf(lineAt(j)) <= column) break;
        body.push(lineAt(j));
      }
      while (body.length > 0 && (body.at(-1) ?? '').trim() === '') body.pop();
      const strip = Math.min(...body.filter((line) => line.trim() !== '').map(indentOf));
      const scriptLines = body.map((line) => line.slice(strip));
      const script = value.startsWith('>') ? folded(scriptLines) : scriptLines.join('\n');
      blocks.push({ line: i + 2, script, cwd, foreignShell });
      i = j - 1;
    } else if (value !== '') {
      // A plain or quoted scalar may go on over the lines indented under it.
      const parts = [value];
      let j = i + 1;
      for (; j < lines.length && lineAt(j).trim() !== '' && indentOf(lineAt(j)) > column; j++) {
        parts.push(lineAt(j).trim());
      }
      // An empty `run:` opens a mapping (defaults.run), not a script.
      blocks.push({ line: i + 1, script: yamlScalar(parts.join(' ')), cwd, foreignShell });
      i = j - 1;
    }
  }
  return blocks;
}

/** Names a workflow maps from a secret: `NAME: ${{ secrets.X }}` under env:, with:, outputs: ... */
function mappedSecrets(texts: string[], names: Set<string>): void {
  for (let before = -1; before !== names.size;) {
    before = names.size;
    for (const text of texts) {
      const lines = text.split('\n');
      for (const [i, line] of lines.entries()) {
        const m = /^[ \t]*-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1[ \t]*:[ \t]*(.*)$/.exec(line);
        if (!m?.[2]) continue;
        let value = m[3] ?? '';
        if (/^[|>]/.test(value.trim())) {
          // A block scalar: its lines are its value.
          const column = indentOf(line);
          for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j] ?? '';
            if (next.trim() !== '' && indentOf(next) <= column) break;
            value += `\n${next}`;
          }
        }
        // A flow mapping, { NAME: ${{ secrets.X }} }, maps each of its names.
        for (const pair of value.matchAll(/([A-Za-z_][\w-]*)\s*:\s*(\$\{\{[\s\S]*?\}\})/g)) {
          if (pair[1] && usesSecret(pair[2] ?? '', names)) names.add(pair[1]);
        }
        if (!usesSecret(value, names)) continue;
        names.add(m[2]);
        if (m[2] === 'default' || m[2] === 'value') {
          // An input's default or an output's value names the input or output above it.
          const column = indentOf(line);
          const parent = lines
            .slice(0, i)
            .reverse()
            .find((above) => above.trim() !== '' && indentOf(above) < column);
          const key = /^\s*-?\s*['"]?([A-Za-z_][\w-]*)/.exec(parent ?? '')?.[1];
          if (key) names.add(key);
        }
      }
    }
  }
}

/**
 * The lines an `env:` that maps a secret reaches: the block of the job (or
 * step) it is on, or the whole workflow for a top-level one.
 */
function secretEnvSpans(
  lines: string[],
  names: ReadonlySet<string>,
): Array<{ start: number; end: number }> {
  const meaningful = (line: string) => line.trim() !== '' && !line.trim().startsWith('#');
  const blockEnd = (from: number, column: number) => {
    let end = from + 1;
    while (
      end < lines.length &&
      (!meaningful(lines[end] ?? '') || indentOf(lines[end] ?? '') > column)
    )
      end++;
    return end;
  };
  const spans: Array<{ start: number; end: number }> = [];
  for (const [i, line] of lines.entries()) {
    const m = /^(\s*)env:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const column = m[1]?.length ?? 0;
    const body = [m[2] ?? '', ...lines.slice(i + 1, blockEnd(i, column))].join('\n');
    if (!usesSecret(body, names)) continue;
    if (column === 0) {
      spans.push({ start: 0, end: lines.length });
      continue;
    }
    let parent = i - 1;
    while (
      parent >= 0 &&
      (!meaningful(lines[parent] ?? '') || indentOf(lines[parent] ?? '') >= column)
    )
      parent--;
    if (parent >= 0)
      spans.push({ start: parent, end: blockEnd(parent, indentOf(lines[parent] ?? '')) });
  }
  return spans;
}

/** A step that passes a secret to an action the census cannot read. */
function actionsPassedSecrets(
  file: string,
  text: string,
  ctx: Ctx,
  censused: ReadonlySet<string>,
): void {
  const lines = text.split('\n');
  // A job's or the workflow's env: is in every step's environment.
  const spans = secretEnvSpans(lines, ctx.names);
  for (const [i, line] of lines.entries()) {
    const m = /^\s*(?:-\s+)?uses:\s*(.+)$/.exec(line);
    if (!m) continue;
    const target = yamlScalar((m[1] ?? '').trim());
    const { start, end } = stepLines(lines, i, keyColumn(line));
    const step = lines.slice(start, end).join('\n');
    if (
      !usesSecret(step, ctx.names) &&
      !/^\s*secrets:\s*inherit\b/m.test(step) &&
      !spans.some((span) => i >= span.start && i < span.end)
    ) {
      continue;
    }
    const local = target.startsWith('./') ? posix.normalize(target) : undefined;
    const readable =
      local !== undefined &&
      (censused.has(local) ||
        ['action.yml', 'action.yaml'].some((name) => censused.has(posix.join(local, name))));
    if (!readable) {
      ctx.out.unresolved.push({
        where: `${file}:${i + 1}`,
        file,
        command: `uses: ${target}`,
        why: 'an action passed a secret, which the census cannot read',
      });
    }
  }
}

/** Every local action a workflow uses, as `uses: ./path`, that is a composite one. */
function localActions(
  workflows: Array<{ file: string; text: string }>,
  io: Io,
): Array<{ file: string; text: string }> {
  const found = [...workflows];
  for (let i = 0; i < found.length; i++) {
    for (const m of (found[i]?.text ?? '').matchAll(
      /^\s*(?:-\s+)?uses:\s*['"]?(\.\/[^\s'"@]+)/gm,
    )) {
      const dir = posix.normalize(m[1] ?? '');
      for (const name of ['action.yml', 'action.yaml']) {
        const file = posix.join(dir, name);
        const text = io.read(file);
        if (text === null || found.some((entry) => entry.file === file)) continue;
        if (/^\s*using:\s*['"]?composite/m.test(text)) found.push({ file, text });
      }
    }
  }
  return found;
}

function census(workflows: Array<{ file: string; text: string }>, io: Io): Census {
  const files = localActions(workflows, io);
  const censused = new Set(files.map((entry) => entry.file));
  const names = new Set<string>();
  // A name written to $GITHUB_ENV or $GITHUB_OUTPUT is found while reading the
  // scripts, and makes later reads see more: read again until nothing new.
  for (let round = 1; ; round++) {
    mappedSecrets(
      files.map((entry) => entry.text),
      names,
    );
    const before = names.size;
    const ctx: Ctx = { out: { curls: [], scripts: [], unresolved: [] }, io, names };
    for (const { file, text } of files) {
      for (const block of runBlocks(text)) {
        const src = fileSource(file, block.line);
        if (block.alias) {
          cannotRead(
            ctx,
            src,
            `${file}:${block.line}`,
            `run: ${block.alias}`,
            'a YAML alias the census does not follow',
          );
        } else if (block.foreignShell) {
          cannotRead(
            ctx,
            src,
            src.where(1),
            `shell: ${block.foreignShell}`,
            'a run block in a shell the census cannot read',
          );
        } else {
          walk(block.script, src, { secretVars: new Set(names), cwd: block.cwd, depth: 0 }, ctx);
        }
      }
      actionsPassedSecrets(file, text, ctx, censused);
    }
    if (names.size === before) return merged(ctx.out);
    if (round === 10) throw new Error('the secret names did not settle');
  }
}

/** One entry per command: the same command can be read twice (a fan-out, a second pass). */
function merged(out: Census): Census {
  const curls = new Map<string, CurlFound>();
  for (const curl of out.curls) {
    const key = `${curl.where}\n${curl.command}`;
    const seen = curls.get(key);
    if (!seen) {
      curls.set(key, { ...curl, prints: [...curl.prints] });
    } else {
      seen.sendsSecret ||= curl.sendsSecret;
      seen.prints = [...new Set([...seen.prints, ...curl.prints])];
    }
  }
  const unresolved = new Map(
    out.unresolved.map((entry) => [`${entry.where}\n${entry.command}\n${entry.why}`, entry]),
  );
  return { curls: [...curls.values()], scripts: out.scripts, unresolved: [...unresolved.values()] };
}

const repoIo: Io = {
  read(path) {
    const abs = resolve(REPO_ROOT, path);
    if (!abs.startsWith(REPO_ROOT + sep)) return null;
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
  },
  dirs(path) {
    const abs = resolve(REPO_ROOT, path);
    if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + sep)) return [];
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
    return readdirSync(abs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  },
};

function repoWorkflows(): Array<{ file: string; text: string }> {
  const files: string[] = readdirSync(join(REPO_ROOT, '.github', 'workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`);
  const actions = (dir: string): string[] =>
    readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? actions(`${dir}/${entry.name}`)
        : /\.ya?ml$/.test(entry.name)
          ? [`${dir}/${entry.name}`]
          : [],
    );
  if (existsSync(join(REPO_ROOT, '.github', 'actions'))) files.push(...actions('.github/actions'));
  return files.map((file) => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }));
}

/** Every curl that sends a secret and prints its answer, with the reasons. */
function violations(result: Census): string[] {
  return result.curls
    .filter((curl) => curl.sendsSecret && curl.prints.length > 0)
    .map((curl) => `${curl.where}: ${curl.command} (${curl.prints.join('; ')})`);
}

/** What the census could not read, less what READ_BY_HAND has read. */
function openItems(result: Census, read: Readonly<Record<string, string>> = {}): string[] {
  return result.unresolved
    .filter((entry) => !(`${entry.file}: ${entry.command}` in read))
    .map((entry) => `${entry.where}: ${entry.command} (${entry.why})`);
}

/**
 * What the real workflows run that the census cannot read, each read by hand.
 * The key is the file and the command as written, so a new call, or a changed
 * one, is unresolved again until someone reads it. Each reason says what runs
 * and why no answer of a call that sends a secret reaches the log.
 */
const READ_BY_HAND: Readonly<Record<string, string>> = {
  '.github/workflows/security-scan.yml: node scripts/dependency-audit/report.mjs pnpm-audit.json > dependency-audit.md':
    'Reads pnpm-audit.json and scripts/dependency-audit/allow-list.json and prints advisory metadata. It makes no request, and the workflow maps no secret.',
  '.github/workflows/smoke-sim.yml: python3 scripts/smoke/smoke.py --ci --udid "$SMOKE_UDID"':
    'Drives the simulator with idb and xcrun simctl and prints each flow and its result. It makes no request itself; STOCKPILOT_SMOKE_PASSWORD only goes through the simulator pasteboard into the sign-in field and is never printed.',
  'scripts/security-test.sh: node scripts/gen-place-order-parity-sql.mjs --check':
    'Reads a fixture and a pgTAP file and compares them. It makes no request and reads no environment; the CI job maps no secret.',
  'apps/web/package.json scripts["build"]: node ./scripts/copy-maplibre-worker.mjs':
    'Copies two maplibre-gl files from node_modules into public/. It makes no request.',
  'packages/config/package.json scripts["test"]: node --test':
    "Runs node's test runner on packages/config/package.test.mjs, which reads package.json and checks paths on disk. It makes no request.",
};

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

/** The files of a plant's repository, read as the census reads the real one. */
function plantIo(files: Record<string, string>): Io {
  return {
    read: (path) => files[posix.normalize(path)] ?? null,
    dirs: (path) => {
      const prefix = posix.normalize(path) === '.' ? '' : `${posix.normalize(path)}/`;
      const inside = Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split('/'))
        .filter((parts) => parts.length > 1)
        .map((parts) => parts[0] ?? '');
      return [...new Set(inside)].sort();
    },
  };
}

function plant(
  script: string,
  env: Record<string, string> = {},
  files: Record<string, string> = {},
): Census {
  return census([{ file: 'plant.yml', text: workflow(script, env) }], plantIo(files));
}

const HOOK_ENV = { HOOK_TOKEN: '${{ secrets.HOOK_TOKEN }}' };
const AUTH = '-H "Authorization: Bearer ${HOOK_TOKEN}"';
const API = 'https://example.com/api/report';

interface Plant {
  id: string;
  what: string;
  /** The run block of a one-step workflow, with `env` on the step. */
  script?: string;
  env?: Record<string, string>;
  /** A whole workflow, instead. */
  workflow?: string;
  /** The plant's repository; its .github/ YAML files are read as workflows. */
  files?: Record<string, string>;
  finds: { violation: RegExp } | { unresolved: RegExp } | { nothing: true };
}

const NOTIFY_SCRIPT =
  '#!/usr/bin/env bash\ncurl -fsS -H "X-Hook: ${HOOK_TOKEN}" https://example.com/hook\n';

function plantWorkspace(script: string): Record<string, string> {
  return {
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'package.json': JSON.stringify({ scripts: { notify: 'turbo run notify' } }),
    'apps/web/package.json': JSON.stringify({ scripts: { notify: script } }),
    'turbo.json': JSON.stringify({ tasks: { notify: {} } }),
  };
}

const PLANTS: Plant[] = [
  // (1) Long options: --name=value, unknown options, every printing option.
  {
    id: 'A1.1',
    what: '--dump-header=- (inline value)',
    script: `curl -fsS -o /dev/null --dump-header=- ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--dump-header -, not \/dev\/null/ },
  },
  {
    id: 'A1.2',
    what: '--write-out=%{header_json} (inline value)',
    script: `curl -fsS -o /dev/null --write-out=%{header_json} ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--write-out %\{header_json\}/ },
  },
  {
    id: 'A1.3',
    what: '--output=- beside -o /dev/null (inline value)',
    script: `curl -fsS --output=- -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /-o -, not \/dev\/null/ },
  },
  {
    id: 'A1.4',
    what: '--show-headers',
    script: `curl -fsS --show-headers -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--show-headers/ },
  },
  {
    id: 'A1.5',
    what: 'an unknown long option fails closed',
    script: `curl -fsS --frobnicate -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--frobnicate: an option curl's manual does not list/ },
  },
  {
    id: 'A1.6',
    what: 'an unknown short option fails closed',
    script: `curl -fsSW -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /-W: an option curl's manual does not list/ },
  },
  {
    id: 'A1.7',
    what: '-c - (the cookie jar, from the answer, to the log)',
    script: `curl -fsS -c - -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--cookie-jar -, not \/dev\/null/ },
  },
  {
    id: 'A1.8',
    what: '--etag-save -',
    script: `curl -fsS --etag-save - -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--etag-save -, not \/dev\/null/ },
  },
  {
    id: 'A1.9',
    what: '--libcurl=- (inline value)',
    script: `curl -fsS --libcurl=- -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--libcurl -, not \/dev\/null/ },
  },
  {
    id: 'A1.10',
    what: "-w '%{url.query}' (the URL's parts)",
    script: `curl -fsS -o /dev/null -w '%{url.query}' ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--write-out %\{url\.query\}/ },
  },
  {
    id: 'A1.11',
    what: '-K (options from a file)',
    script: `curl -fsS -K hook.curlrc -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /-K: options from a file the census cannot see/ },
  },
  {
    id: 'A1.12',
    what: 'a second transfer after --next has no -o of its own',
    script: `curl -fsS -o /dev/null -o /dev/null ${AUTH} ${API} --next ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /an answer is printed/ },
  },
  {
    id: 'A1.13',
    what: '-D to a file (only /dev/null is safe)',
    script: `curl -fsS -D headers.txt -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--dump-header headers\.txt, not \/dev\/null/ },
  },
  // (2) Secrets the runner pastes in through an expression.
  {
    id: 'A2.1',
    what: '${{ env.X }} of a name mapped from a secret',
    script: 'curl -fsS -X POST "${{ env.DEPLOY_HOOK }}"',
    env: { DEPLOY_HOOK: '${{ secrets.DEPLOY_HOOK_URL }}' },
    finds: { violation: /env\.DEPLOY_HOOK/ },
  },
  {
    id: 'A2.2',
    what: '${{ inputs.X }} named like a secret',
    script: `curl -fsS -H "X-Key: \${{ inputs.api_token }}" ${API}`,
    finds: { violation: /inputs\.api_token/ },
  },
  {
    id: 'A2.3',
    what: '${{ steps.<id>.outputs.X }} written from a secret',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: mint',
      '        run: echo "value=${{ secrets.HOOK_URL }}" >> "$GITHUB_OUTPUT"',
      '      - run: curl -fsS "${{ steps.mint.outputs.value }}"',
    ].join('\n'),
    finds: { violation: /steps\.mint\.outputs\.value/ },
  },
  {
    id: 'A2.4',
    what: '${{ needs.<job>.outputs.X }} named like a secret',
    script: `curl -fsS -H "X-Key: \${{ needs.setup.outputs.deploy_key }}" ${API}`,
    finds: { violation: /needs\.setup\.outputs\.deploy_key/ },
  },
  {
    id: 'A2.5',
    what: '${{ vars.X }} named like a secret',
    script: `curl -fsS -H "X-Key: \${{ vars.HOOK_KEY }}" ${API}`,
    finds: { violation: /vars\.HOOK_KEY/ },
  },
  {
    id: 'A2.6',
    what: "${{ secrets['X'] }}",
    script: `curl -fsS -H "X-Hook: \${{ secrets['HOOK'] }}" ${API}`,
    finds: { violation: /secrets\['HOOK'\]/ },
  },
  {
    id: 'A2.7',
    what: '${{ format(..., secrets.X) }}',
    script: `curl -fsS -H "\${{ format('X-Hook: {0}', secrets.HOOK) }}" ${API}`,
    finds: { violation: /format\('X-Hook: \{0\}', secrets\.HOOK\)/ },
  },
  {
    id: 'A2.8',
    what: '${{ toJSON(secrets) }}',
    script: "curl -fsS -d '${{ toJSON(secrets) }}' https://example.com/api/report",
    finds: { violation: /toJSON\(secrets\)/ },
  },
  {
    id: 'A2.9',
    what: 'a composite action input fed a secret by with:',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: ./.github/actions/notify',
      '        with:',
      '          hook: ${{ secrets.NOTIFY_HOOK }}',
    ].join('\n'),
    files: {
      '.github/actions/notify/action.yml': [
        'name: Notify',
        'inputs:',
        '  hook:',
        '    required: true',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - shell: bash',
        '      run: curl -fsS "${{ inputs.hook }}"',
      ].join('\n'),
    },
    finds: {
      violation: /\.github\/actions\/notify\/action\.yml:9: curl -fsS "\$\{\{ inputs\.hook \}\}"/,
    },
  },
  {
    id: 'A2.10',
    what: 'a name written to $GITHUB_ENV from a secret, read in a later step',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "HOOK=${{ secrets.HOOK_URL }}" >> "$GITHUB_ENV"',
      '      - run: curl -fsS "$HOOK"',
    ].join('\n'),
    finds: { violation: /curl -fsS "\$HOOK"/ },
  },
  {
    id: 'A2.11',
    what: "an action input whose default is the workflow's token",
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: ./.github/actions/report',
    ].join('\n'),
    files: {
      '.github/actions/report/action.yml': [
        'name: Report',
        'inputs:',
        '  gh:',
        '    default: ${{ github.token }}',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - shell: bash',
        '      run: curl -fsS -H "X-Gh: ${{ inputs.gh }}" https://example.com/api/report',
      ].join('\n'),
    },
    finds: { violation: /inputs\.gh/ },
  },
  {
    id: 'B1.1',
    what: 'a script called with a secret reads it as $1',
    script: 'bash scripts/notify.sh "$DEPLOY_HOOK"',
    env: { DEPLOY_HOOK: '${{ secrets.DEPLOY_HOOK_URL }}' },
    files: { 'scripts/notify.sh': '#!/usr/bin/env bash\ncurl -fsS -X POST "$1"\n' },
    finds: { violation: /scripts\/notify\.sh:2: curl -fsS -X POST "\$1"/ },
  },
  {
    id: 'B1.2',
    what: 'a function called with a secret reads it as $1',
    script: 'notify() {\n  curl -fsS -X POST "$1"\n}\nnotify "$DEPLOY_HOOK"',
    env: { DEPLOY_HOOK: '${{ secrets.DEPLOY_HOOK_URL }}' },
    finds: { violation: /curl -fsS -X POST "\$1"/ },
  },
  {
    id: 'B1.3',
    what: 'a curl variable imported from a secret (--variable %X)',
    script: "curl -fsS --variable %DEPLOY_HOOK --expand-url '{{DEPLOY_HOOK}}'",
    env: { DEPLOY_HOOK: '${{ secrets.DEPLOY_HOOK_URL }}' },
    finds: { violation: /--variable %DEPLOY_HOOK/ },
  },
  {
    id: 'B1.4',
    what: 'a URL interpolating a variable named like a secret (control)',
    script: 'curl -fsS "https://example.com/hook?key=${HOOK_KEY}"',
    finds: { violation: /HOOK_KEY/ },
  },
  {
    id: 'B1.5',
    what: '-u with a value named like nothing secret (control)',
    script: `curl -fsS -u "ci:\${CI_PASS}" ${API}`,
    finds: { violation: /-u "ci:\$\{CI_PASS\}"/ },
  },
  {
    id: 'B1.6',
    what: '--user, the long form of -u (control)',
    script: `curl -fsS --user "ci:\${CI_PASSWORD}" ${API}`,
    finds: { violation: /--user "ci:\$\{CI_PASSWORD\}"/ },
  },
  {
    id: 'B1.7',
    what: '--data-binary, one of the --data options (control)',
    script: `curl -fsS --data-binary "token=\${UPLOAD_TOKEN}" ${API}`,
    finds: { violation: /--data-binary "token=\$\{UPLOAD_TOKEN\}"/ },
  },
  {
    id: 'B2.1',
    what: '|| splits commands too (control)',
    script: `curl -fsS -o /dev/null https://example.com/health || curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /^plant\.yml:10: curl -fsS -H "Authorization/ },
  },
  {
    id: 'B2.2',
    what: '| splits commands too (control)',
    script: `echo start | curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /^plant\.yml:10: curl -fsS -H "Authorization/ },
  },
  {
    id: 'B3.1',
    what: '--verbose, the long form (control)',
    script: `curl --verbose -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /\(--verbose\)/ },
  },
  {
    id: 'B3.2',
    what: '--include, the long form (control)',
    script: `curl --include -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /\(--include\)/ },
  },
  {
    id: 'B3.3',
    what: '--trace to a file (control)',
    script: `curl --trace trace.txt -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--trace trace\.txt, not \/dev\/null/ },
  },
  {
    id: 'B3.4',
    what: '--dump-header /dev/stdout (control)',
    script: `curl --dump-header /dev/stdout -o /dev/null ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--dump-header \/dev\/stdout, not \/dev\/null/ },
  },
  {
    id: 'B3.5',
    what: '-o to a file, not /dev/null (control)',
    script: `curl -fsS -o response.json ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /-o response\.json, not \/dev\/null/ },
  },
  {
    id: 'B4.1',
    what: './x.sh (control)',
    script: './scripts/notify.sh',
    env: HOOK_ENV,
    files: { 'scripts/notify.sh': NOTIFY_SCRIPT },
    finds: { violation: /^scripts\/notify\.sh:2: curl/ },
  },
  {
    id: 'B4.2',
    what: 'source x.sh (control)',
    script: 'source scripts/notify.sh',
    env: HOOK_ENV,
    files: { 'scripts/notify.sh': NOTIFY_SCRIPT },
    finds: { violation: /^scripts\/notify\.sh:2: curl/ },
  },
  // (3) What the census cannot read is unresolved, or now read.
  {
    id: 'A3.1',
    what: 'node running a repository script',
    script: 'node scripts/notify.mjs',
    env: HOOK_ENV,
    finds: { unresolved: /node scripts\/notify\.mjs \(node runs code the census cannot read\)/ },
  },
  {
    id: 'A3.2',
    what: 'python running a repository script',
    script: 'python3 scripts/notify.py',
    env: HOOK_ENV,
    finds: { unresolved: /python3 scripts\/notify\.py \(python3 runs code/ },
  },
  {
    id: 'A3.3',
    what: 'make',
    script: 'make notify',
    env: HOOK_ENV,
    finds: { unresolved: /make notify \(make runs code/ },
  },
  {
    id: 'A3.4',
    what: 'xargs',
    script: `printf '%s\\n' ${API} | xargs curl -fsS ${AUTH}`,
    env: HOOK_ENV,
    finds: { unresolved: /xargs curl .*\(xargs runs code/ },
  },
  {
    id: 'A3.5',
    what: 'a repository program that is not a shell script',
    script: './scripts/notify',
    env: HOOK_ENV,
    files: { 'scripts/notify': '#!/usr/bin/env node\nconsole.log(1)\n' },
    finds: {
      unresolved: /\.\/scripts\/notify \(a repository program that is not a shell script\)/,
    },
  },
  {
    id: 'A3.6',
    what: 'a repository shell script with no .sh, by its first line',
    script: './scripts/notify',
    env: HOOK_ENV,
    files: { 'scripts/notify': NOTIFY_SCRIPT },
    finds: { violation: /scripts\/notify:2: curl/ },
  },
  {
    id: 'A3.7',
    what: 'a pnpm -r fan-out, read in every workspace package',
    script: 'pnpm -r run notify',
    env: HOOK_ENV,
    files: plantWorkspace(`curl -fsS ${AUTH} ${API}`),
    finds: { violation: /apps\/web\/package\.json scripts\["notify"\]: curl/ },
  },
  {
    id: 'A3.8',
    what: 'a pnpm --filter fan-out',
    script: 'pnpm --filter web notify',
    env: HOOK_ENV,
    files: plantWorkspace(`curl -fsS ${AUTH} ${API}`),
    finds: { violation: /apps\/web\/package\.json scripts\["notify"\]: curl/ },
  },
  {
    id: 'A3.9',
    what: 'a turbo fan-out',
    script: 'pnpm notify',
    env: HOOK_ENV,
    files: plantWorkspace(`curl -fsS ${AUTH} ${API}`),
    finds: { violation: /apps\/web\/package\.json scripts\["notify"\]: curl/ },
  },
  {
    id: 'A3.10',
    what: 'an npm workspace fan-out',
    script: 'npm run notify --workspaces',
    env: HOOK_ENV,
    files: plantWorkspace(`curl -fsS ${AUTH} ${API}`),
    finds: { unresolved: /npm run notify --workspaces \(a npm workspace fan-out/ },
  },
  {
    id: 'A3.11',
    what: 'the depth limit',
    script: 'bash scripts/loop.sh',
    env: HOOK_ENV,
    files: { 'scripts/loop.sh': 'source scripts/loop.sh\n' },
    finds: { unresolved: /source scripts\/loop\.sh \(the census stops 8 calls deep\)/ },
  },
  {
    id: 'A3.12',
    what: 'sudo -u user curl (the option takes a value)',
    script: `sudo -u runner curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /sudo -u runner curl/ },
  },
  {
    id: 'A3.13',
    what: 'env -u NAME curl',
    script: `env -u DEBUG curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /env -u DEBUG curl/ },
  },
  {
    id: 'A3.14',
    what: 'timeout -s KILL 60 curl',
    script: `timeout -s KILL 60 curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /timeout -s KILL 60 curl/ },
  },
  {
    id: 'A3.15',
    what: 'nice -n 5 curl',
    script: `nice -n 5 curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /nice -n 5 curl/ },
  },
  {
    id: 'A3.16',
    what: 'a wrapper option the census cannot read',
    script: `sudo --frobnicate runner curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { unresolved: /sudo --frobnicate: an option the census cannot read/ },
  },
  {
    id: 'A3.17',
    what: 'a program named by a variable',
    script: `"$CURL" -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { unresolved: /"\$CURL" .*\(a program named by an expansion\)/ },
  },
  {
    id: 'A3.18',
    what: 'find -exec curl',
    script: `find . -name hook.json -exec curl -fsS ${AUTH} -d @{} ${API} \\;`,
    env: HOOK_ENV,
    finds: { violation: /find \. -name hook\.json -exec curl/ },
  },
  {
    id: 'A3.19',
    what: 'eval of text with an expansion',
    script: `eval "curl -fsS ${AUTH} ${API}"`,
    env: HOOK_ENV,
    finds: { unresolved: /eval .*\(eval of text the census cannot see\)/ },
  },
  {
    id: 'A3.20',
    what: 'a trap handler',
    script: `trap 'curl -fsS ${AUTH} ${API}' EXIT`,
    env: HOOK_ENV,
    finds: { violation: /^plant\.yml:10: curl -fsS -H "Authorization/ },
  },
  {
    id: 'A3.21',
    what: 'an HTTP client other than curl',
    script: `wget --header "Authorization: Bearer \${HOOK_TOKEN}" ${API}`,
    env: HOOK_ENV,
    finds: { unresolved: /wget .*\(an HTTP client the census does not judge\)/ },
  },
  {
    id: 'A3.22',
    what: 'an action passed a secret',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: example/notify-action@v1',
      '        with:',
      '          token: ${{ secrets.NOTIFY_TOKEN }}',
    ].join('\n'),
    finds: { unresolved: /uses: example\/notify-action@v1 \(an action passed a secret/ },
  },
  {
    id: 'A3.23',
    what: 'a run block in another shell',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - shell: python',
      '        run: |',
      '          import os, urllib.request',
      "          print(urllib.request.urlopen(os.environ['HOOK_URL']).read())",
    ].join('\n'),
    finds: { unresolved: /shell: python \(a run block in a shell the census cannot read\)/ },
  },
  {
    id: 'A3.24',
    what: 'a run: plain scalar over several lines',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: curl -fsS',
      '          -H "Authorization: Bearer ${{ secrets.HOOK_TOKEN }}"',
      '          https://example.com/api/report',
    ].join('\n'),
    finds: { violation: /plant\.yml:6: curl -fsS -H "Authorization/ },
  },
  {
    id: 'A3.25',
    what: 'command -p curl',
    script: `command -p curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /command -p curl/ },
  },
  {
    id: 'A3.26',
    what: 'time -p curl',
    script: `time -p curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /time -p curl/ },
  },
  // (4) A URL that may expand to several transfers.
  {
    id: 'A4.1',
    what: 'a {a,b} glob in a quoted URL',
    script: `curl -fsS -o /dev/null ${AUTH} "https://example.com/api/{report,export}"`,
    env: HOOK_ENV,
    finds: {
      violation:
        /URL may expand to several transfers: "https:\/\/example\.com\/api\/\{report,export\}" \(needs --globoff\)/,
    },
  },
  {
    id: 'A4.2',
    what: 'a [1-3] glob in a quoted URL',
    script: `curl -fsS -o /dev/null ${AUTH} "https://example.com/api/report[1-3]"`,
    env: HOOK_ENV,
    finds: { violation: /URL may expand to several transfers: .*report\[1-3\]/ },
  },
  {
    id: 'A4.3',
    what: 'an unquoted variable, even with --globoff',
    script: `curl -fsS -g -o /dev/null ${AUTH} $REPORT_URLS`,
    env: HOOK_ENV,
    finds: {
      violation: /URL may expand to several transfers: \$REPORT_URLS \(the shell can split it\)/,
    },
  },
  {
    id: 'A4.4',
    what: 'a quoted variable without --globoff',
    script: `curl -fsS -o /dev/null ${AUTH} "$REPORT_URL"`,
    env: HOOK_ENV,
    finds: { violation: /URL may expand to several transfers: "\$REPORT_URL" \(needs --globoff\)/ },
  },
  {
    id: 'A4.5',
    what: 'an unquoted brace, which the shell expands, even with --globoff',
    script: `curl -fsS -g -o /dev/null ${AUTH} https://example.com/api/{report,export}`,
    env: HOOK_ENV,
    finds: { violation: /\(the shell can split it\)/ },
  },
  {
    id: 'A4.6',
    what: 'control: --globoff and one -o /dev/null per URL word pass',
    script: [
      `curl -fsS --globoff -o /dev/null ${AUTH} "$REPORT_URL"`,
      `curl -fsSg -o /dev/null -o /dev/null ${AUTH} "https://example.com/api/report[1]" ${API}`,
    ].join('\n'),
    env: HOOK_ENV,
    finds: { nothing: true },
  },
  // (5) Found while checking the new guard against the same kinds of gap.
  {
    id: 'C1',
    what: 'a one-line function NAME { ...; }',
    script: `function notify { curl -fsS ${AUTH} ${API}; }`,
    env: HOOK_ENV,
    finds: { violation: /function notify \{ curl -fsS/ },
  },
  {
    id: 'C2',
    what: 'an option array, "${OPTS[@]}", which may hold -v',
    script: `OPTS=(-v)\ncurl -fsS -g -o /dev/null -o /dev/null ${AUTH} "\${OPTS[@]}" ${API}`,
    env: HOOK_ENV,
    finds: { violation: /"\$\{OPTS\[@\]\}": a list of words the census cannot see/ },
  },
  {
    id: 'C3',
    what: 'a -w format from a variable',
    script: `curl -fsS -o /dev/null -w "$FMT" ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /--write-out \$FMT/ },
  },
  {
    id: 'C4',
    what: 'a script piped into a shell',
    script: 'curl -fsS https://example.com/install.sh | bash',
    env: HOOK_ENV,
    finds: { unresolved: /: bash \(a shell reading its script from standard input\)/ },
  },
  {
    id: 'C5',
    what: "bash -c '...' with a secret as its $0",
    script: `bash -c 'curl -fsS -X POST "$0"' "$DEPLOY_HOOK"`,
    env: { DEPLOY_HOOK: '${{ secrets.DEPLOY_HOOK_URL }}' },
    finds: { violation: /curl -fsS -X POST "\$0"/ },
  },
  {
    id: 'C6',
    what: 'set -- with a secret, then $1',
    script: 'set -- "$DEPLOY_HOOK"\ncurl -fsS -X POST "$1"',
    env: { DEPLOY_HOOK: '${{ secrets.DEPLOY_HOOK_URL }}' },
    finds: { violation: /curl -fsS -X POST "\$1"/ },
  },
  {
    id: 'C7',
    what: 'a run block on a Windows runner (PowerShell unless it says otherwise)',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: windows-latest',
      '    steps:',
      "      - run: Invoke-WebRequest -Uri $env:HOOK_URL -Headers @{ Authorization = 'Bearer x' }",
    ].join('\n'),
    finds: { unresolved: /shell: pwsh \(a run block in a shell the census cannot read\)/ },
  },
  {
    id: 'C8',
    what: 'a task runner (concurrently)',
    script: `concurrently "curl -fsS ${AUTH} ${API}"`,
    env: HOOK_ENV,
    finds: { unresolved: /concurrently .*\(concurrently runs code the census cannot read\)/ },
  },
  {
    id: 'C9',
    what: 'bash -euxo pipefail script.sh reads the script',
    script: 'bash -euxo pipefail scripts/notify.sh',
    env: HOOK_ENV,
    files: { 'scripts/notify.sh': NOTIFY_SCRIPT },
    finds: { violation: /^scripts\/notify\.sh:2: curl/ },
  },
  {
    id: 'C10',
    what: 'control: shell: /bin/bash -e {0} is bash, and a discarded answer passes',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - shell: /bin/bash -e {0}',
      '        run: curl -fsS -o /dev/null -H "Authorization: Bearer ${{ secrets.HOOK_TOKEN }}" https://example.com/api/report',
    ].join('\n'),
    finds: { nothing: true },
  },
  {
    id: 'C11',
    what: '/usr/bin/env curl (a wrapper by its path)',
    script: `/usr/bin/env curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /\/usr\/bin\/env curl -fsS/ },
  },
  {
    id: 'C12',
    what: '/usr/bin/sudo -u runner python3 (a wrapper by its path, then an interpreter)',
    script: '/usr/bin/sudo -u runner python3 scripts/notify.py',
    env: HOOK_ENV,
    finds: { unresolved: /python3 scripts\/notify\.py \(python3 runs code/ },
  },
  {
    id: 'C13',
    what: "env -S 'curl -fsS' ... (the string's words come first)",
    script: `env -S 'curl -fsS' ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: { violation: /env -S 'curl -fsS' -H "Authorization/ },
  },
  {
    id: 'C14',
    what: 'run: > (folded) keeps the line break before a more-indented line',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: >',
      '          echo start',
      '            curl -fsS -H "Authorization: Bearer ${{ secrets.HOOK_TOKEN }}" https://example.com/api/report',
    ].join('\n'),
    finds: { violation: /^plant\.yml:8: curl -fsS -H "Authorization/ },
  },
  {
    id: 'C15',
    what: "an action in a job whose env: maps a secret (it is in the action's environment)",
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    env:',
      '      HOOK_TOKEN: ${{ secrets.HOOK_TOKEN }}',
      '    steps:',
      '      - uses: example/notify-action@v1',
    ].join('\n'),
    finds: { unresolved: /uses: example\/notify-action@v1 \(an action passed a secret/ },
  },
  {
    id: 'C16',
    what: 'a wrapper WRAPPERS does not list, running curl',
    script: `gtimeout 90 curl -fsS ${AUTH} ${API}`,
    env: HOOK_ENV,
    finds: {
      unresolved: /gtimeout 90 curl .*\(gtimeout has a curl command among its arguments/,
    },
  },
  {
    id: 'C17',
    what: 'control: a job env: with no secret, installing curl and echoing a curl command pass',
    workflow: [
      'on: push',
      'jobs:',
      '  plant:',
      '    runs-on: ubuntu-latest',
      '    env:',
      "      CI: 'true'",
      '    steps:',
      '      - uses: example/setup-action@v1',
      '      - run: |',
      '          sudo apt-get install -y curl',
      '          echo "curl -fsS https://example.com/api/report"',
      '          printf \'%s\\n\' curl "$HOOK_URL"',
    ].join('\n'),
    finds: { nothing: true },
  },
];

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
        // pnpm test runs turbo, which runs each package's own test script.
        'package.json scripts["test"]',
        'apps/web/package.json scripts["test"]',
        'apps/web/package.json scripts["build"]',
      ]),
    );
  });

  it('everything the census cannot read has been read by hand', () => {
    expect(openItems(real, READ_BY_HAND)).toEqual([]);
    // No stale entry: each one still names something the workflows run.
    const seen = new Set(real.unresolved.map((entry) => `${entry.file}: ${entry.command}`));
    expect(Object.keys(READ_BY_HAND).filter((key) => !seen.has(key))).toEqual([]);
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
        `curl -fsS --globoff -o /dev/null -w "HTTP %{http_code}\\n" ${AUTH} "\${URL}"`,
        'curl -sSfL -o tool.tar.gz "https://example.com/tool.tar.gz"',
        'curl -g --output /dev/null -H "Authorization: Bearer ${{ secrets.TOKEN }}" "${URL}"',
        'curl -H "X-Key: ${{ secrets.TOKEN }}" "${URL}"',
        `code="$(curl -sS -o /dev/null -w '%{http_code}' ${AUTH} ${API})"`,
        `curl -fsS -o "/dev/null" ${AUTH} ${API}`,
        `echo "curl ${AUTH} ${API}"`,
        "cat <<'EOF'",
        `curl ${AUTH} ${API}`,
        'EOF',
        // The safe form above, without --globoff: "${URL}" may hold a glob.
        `curl -fsS -o /dev/null ${AUTH} "\${URL}"`,
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
      true,
    ]);
    expect(violations(result)[0]).toMatch(/^plant\.yml:11: if curl -fsS --max-time 90 -H/);
    expect(openItems(result)).toEqual([]);
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
        'scripts/plant-hook.sh:3: curl -fsS -H "X-Hook: ${HOOK_TOKEN}" "$HOOK_URL" (an answer is printed (no -o /dev/null for it); URL may expand to several transfers: "$HOOK_URL" (needs --globoff))',
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
      expect(openItems(missing)).toEqual([
        'plant.yml:10: bash scripts/not-there.sh (no such file in the repository)',
      ]);
    });
  });

  // The second review (2026-10-31, of the guard as 4cc3c9f1c left it), the
  // check of the first review's clauses, and what checking the new guard
  // found. That guard missed each plant not marked as a control: it found
  // nothing at all, or (C9) took pipefail for the script. The table in the
  // PR lists what it found for each.
  describe('one plant per gap the second review found', () => {
    it.each(PLANTS)('$id: $what', (p) => {
      const files = p.files ?? {};
      const workflows = [
        { file: 'plant.yml', text: p.workflow ?? workflow(p.script ?? '', p.env) },
        ...Object.entries(files)
          .filter(([file]) => /^\.github\/(?:workflows|actions)\/.*\.ya?ml$/.test(file))
          .map(([file, text]) => ({ file, text })),
      ];
      const result = census(workflows, plantIo(files));
      if ('violation' in p.finds) {
        expect(violations(result)).toEqual(
          expect.arrayContaining([expect.stringMatching(p.finds.violation)]),
        );
      } else if ('unresolved' in p.finds) {
        expect(openItems(result)).toEqual(
          expect.arrayContaining([expect.stringMatching(p.finds.unresolved)]),
        );
      } else {
        expect({ violations: violations(result), unresolved: openItems(result) }).toEqual({
          violations: [],
          unresolved: [],
        });
      }
    });
  });
});
