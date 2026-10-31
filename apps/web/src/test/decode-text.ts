/**
 * The decoder the customer guards read text with: customer-addresses.guard.test.ts
 * (docket S15) reads each line of the tracked tree both as written and
 * decoded, and customer-names-in-copy.guard.test.ts (docket S17) reads each
 * piece of copy the same way. Test support: only tests import it.
 *
 * One round undoes %-escapes (a malformed one left as it is), then HTML
 * references, backslash escapes (\uXXXX, \u{X}, \xXX, \UXXXXXXXX, octal)
 * and SQL U&'\XXXX' strings, reads <br> and <wbr> as breaks, and folds
 * full-width and other compatibility forms; decode() runs rounds until nothing
 * changes (16 rounds at most), so any mix of them reads plain.
 */

// Named HTML references that can spell part of an address or a name, wrap one
// or hide a break in one, looked up in lower case.
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  // From the XHTML list JSX decodes in its text and attribute values: each
  // reference whose character, compatibility forms folded, is white space, a
  // middle dot, a letter or a digit.
  nbsp: '\u00A0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  middot: '\u00B7',
  ordf: '\u00AA',
  ordm: '\u00BA',
  image: '\u2111',
  real: '\u211C',
  sup1: '\u00B9',
  sup2: '\u00B2',
  sup3: '\u00B3',
  trade: '\u2122',
  // Others.
  commat: '@',
  period: '.',
  lowbar: '_',
  underbar: '_',
  plus: '+',
  amp: '&',
  percnt: '%',
  bsol: '\\',
  equals: '=',
  num: '#',
  semi: ';',
  lt: '<',
  gt: '>',
  lsqb: '[',
  lbrack: '[',
  rsqb: ']',
  rbrack: ']',
  lpar: '(',
  rpar: ')',
  lcub: '{',
  lbrace: '{',
  rcub: '}',
  rbrace: '}',
  quot: '"',
  apos: "'",
  newline: '\n',
  tab: '\t',
  shy: '\u00AD',
  zerowidthspace: '\u200B',
  zwnj: '\u200C',
  zwj: '\u200D',
  lrm: '\u200E',
  rlm: '\u200F',
  nobreak: '\u2060',
};

const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  f: '\f',
  v: '\v',
};

const fromCode = (whole: string, code: number) =>
  code <= 0x10ffff ? String.fromCodePoint(code) : whole;

/** One round of decoding. */
function decodeOnce(text: string): string {
  return (
    text
      // %uXXXX (JavaScript's escape()), then runs of %XX as UTF-8; a run that
      // is not UTF-8 has its ASCII bytes decoded and the rest left as written.
      .replace(/%[uU]([0-9A-Fa-f]{4})/g, (whole, hex: string) => fromCode(whole, parseInt(hex, 16)))
      .replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return run.replace(/%([0-7][0-9A-Fa-f])/g, (whole, hex: string) =>
            fromCode(whole, parseInt(hex, 16)),
          );
        }
      })
      // HTML references: numeric ones with or without the semicolon (as a
      // browser reads them), named ones (a letter, then letters and digits,
      // as in &sup1;) with it.
      .replace(
        /&#(?:0*([0-9]{1,7})|[xX]0*([0-9A-Fa-f]{1,6}));?|&([A-Za-z][A-Za-z0-9]{1,30});/g,
        (whole, dec?: string, hex?: string, name?: string) => {
          if (name !== undefined) return NAMED_REFERENCES[name.toLowerCase()] ?? whole;
          return fromCode(whole, dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16));
        },
      )
      // SQL Unicode strings, U&'...' with \XXXX or \+XXXXXX (read before the
      // octal escapes below, which would read \0040 as \004 and a 0).
      .replace(/U&'(?:[^']|'')*'/gi, (literal) =>
        literal.replace(
          /\\(?:\+([0-9A-Fa-f]{6})|([0-9A-Fa-f]{4}))/g,
          (whole, six?: string, four?: string) => fromCode(whole, parseInt((six ?? four)!, 16)),
        ),
      )
      // Backslash escapes behind one backslash or more (a string inside a
      // string): \UXXXXXXXX, \u{X}, \uXXXX, \xXX, octal, \n \r \t \f \v, and a
      // backslash before any other mark.
      .replace(
        /\\+(?:U([0-9A-Fa-f]{8})|[uU]\{([0-9A-Fa-f]{1,6})\}|[uU]([0-9A-Fa-f]{4})|[xX]([0-9A-Fa-f]{2})|([0-3][0-7]{2})|([nrtfv])|([^\sA-Za-z0-9]))/g,
        (
          whole,
          long?: string,
          braced?: string,
          short?: string,
          byte?: string,
          octal?: string,
          control?: string,
          mark?: string,
        ) => {
          if (mark !== undefined) return mark;
          if (control !== undefined) return CONTROL_ESCAPES[control]!;
          if (octal !== undefined) return fromCode(whole, parseInt(octal, 8));
          return fromCode(whole, parseInt((long ?? braced ?? short ?? byte)!, 16));
        },
      )
      .replace(/<wbr\s*\/?>/gi, '\u200B')
      .replace(/<\/?br\s*\/?>/gi, '\n')
      // Full-width and other compatibility forms, then the full stops that
      // domain names also read as dots.
      .normalize('NFKC')
      .replace(/[\u3002\uFF0E\uFF61]/g, '.')
  );
}

/** The line decoded round after round until nothing changes (16 rounds at most). */
export function decode(line: string): string {
  let text = line;
  for (let round = 0; round < 16; round += 1) {
    const next = decodeOnce(text);
    if (next === text) break;
    text = next;
  }
  return text;
}
