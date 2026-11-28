import { PROBE_RULES, type ProbeKind, type ProbeRule } from './probe-paths';

/**
 * The scanner-path rules (lib/security/probe-paths.ts) matched again inside
 * the probe route, the way Next matched them before the rewrite (review M2):
 * the route keeps a sample of what was asked for only when the path it was
 * handed is one a rule of its own kind takes. A path that is not (the route
 * called directly, or a platform that hands over something else) gives no
 * sample, and nothing a client wrote is kept as "a path a rule took".
 *
 * sourceToRegExp turns a rule's source (path-to-regexp 6 syntax as
 * probe-paths.ts writes it: `/:name(pattern)*`, `/:name*`, `/:name(pattern)`
 * and literal text) into a regular expression without case and with an
 * optional trailing slash, like Next's own; probe-match.test.ts checks it
 * against Next's two matchers for every rule. ruleParamNames reads the same
 * source for the names of its parameters, which arrive in the query string
 * after the rewrite.
 */

/** The longest path matched again; a longer one is no match (so no sample). */
export const PROBE_MATCH_MAX_LENGTH = 2048;

type SourcePart =
  | { kind: 'literal'; text: string }
  | { kind: 'param'; name: string; pattern: string; modifier: '' | '*' | '+' | '?' };

/** A rule's source, cut into its literal text and its named parameters. */
function partsOf(source: string): SourcePart[] {
  const parts: SourcePart[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '/' && source[i + 1] === ':') {
      // A parameter with its "/" prefix.
      i += 2;
      let name = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) name += source[i++];
      let pattern = '[^/#?]+?';
      if (source[i] === '(') {
        let depth = 0;
        let inClass = false;
        const start = i + 1;
        for (; i < source.length; i++) {
          const c = source[i]!;
          if (c === '\\') {
            i++;
            continue;
          }
          if (inClass) {
            if (c === ']') inClass = false;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === '(') depth++;
          else if (c === ')' && --depth === 0) break;
        }
        pattern = source.slice(start, i);
        i++;
      }
      const next = source[i];
      const modifier = next === '*' || next === '?' || next === '+' ? next : '';
      if (modifier) i++;
      parts.push({ kind: 'param', name, pattern, modifier });
    } else {
      parts.push({ kind: 'literal', text: ch });
      i++;
    }
  }
  return parts;
}

export function sourceToRegExp(source: string): RegExp {
  let out = '';
  for (const part of partsOf(source)) {
    if (part.kind === 'literal') {
      out += part.text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else if (part.modifier === '*') {
      out += `(?:/(?:${part.pattern}))*`;
    } else if (part.modifier === '+') {
      out += `(?:/(?:${part.pattern}))+`;
    } else if (part.modifier === '?') {
      out += `(?:/(?:${part.pattern}))?`;
    } else {
      out += `/(?:${part.pattern})`;
    }
  }
  return new RegExp(`^${out}/?$`, 'i');
}

/** The names of a rule's parameters, in the order its source names them. */
export function ruleParamNames(source: string): string[] {
  return partsOf(source).flatMap((part) => (part.kind === 'param' ? [part.name] : []));
}

const MATCHERS: readonly RegExp[] = PROBE_RULES.map((rule) => sourceToRegExp(rule.source));

/**
 * The rule Next applies to `pathname`: the first in PROBE_RULES that takes it
 * (beforeFiles, in order), or null. A path longer than PROBE_MATCH_MAX_LENGTH
 * is null.
 */
export function probeRuleFor(pathname: string): ProbeRule | null {
  if (
    typeof pathname !== 'string' ||
    pathname.length === 0 ||
    pathname.length > PROBE_MATCH_MAX_LENGTH
  ) {
    return null;
  }
  const at = MATCHERS.findIndex((re) => re.test(pathname));
  return at === -1 ? null : PROBE_RULES[at]!;
}

/** True when the rule Next applies to `pathname` is one of `kind`. */
export function pathMatchesKind(pathname: string, kind: ProbeKind): boolean {
  return probeRuleFor(pathname)?.kind === kind;
}
