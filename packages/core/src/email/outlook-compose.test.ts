import { describe, expect, it } from 'vitest';

import {
  OUTLOOK_COMPOSE_BASE,
  OUTLOOK_MOBILE_COMPOSE_BASE,
  DRAFT_URL_LIMIT,
  encodeDraftQuery,
  composeOutlookWebUrl,
  composeOutlookMobileUrl,
  composeMailtoUrl,
  composeClipboardText,
  createOutlookComposeEmail,
  assertSafeDisplayName,
  assertRoutableAddress,
  encodeMailtoPathAddress,
} from './outlook-compose';

/** Reference two-step decode. mailto: is an opaque-path scheme — slice at the
 *  first '?', never new URL().searchParams. */
function decodeCompose(url: string): { to: string; params: Record<string, string> } {
  const outerQuery = url.slice(url.indexOf('?') + 1);
  const mailtouri = outerQuery
    .split('&')
    .map((p) => p.split('='))
    .find(([k]) => k === 'mailtouri')?.[1];
  if (!mailtouri) throw new Error('no mailtouri param');
  const inner = decodeURIComponent(mailtouri);
  const q = inner.indexOf('?');
  const to = decodeURIComponent(inner.slice('mailto:'.length, q === -1 ? undefined : q));
  const params: Record<string, string> = {};
  if (q !== -1) {
    for (const pair of inner.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return { to, params };
}

const BASE_INPUT = {
  to: 'to@example.test',
  cc: 'cc@example.test',
  subject: 'Subject with spaces & specials',
  body: 'Line one\nLine two',
} as const;

describe('outlook-compose transport', () => {
  it('pins the tenant-verified compose base (LITERAL — never office.com)', () => {
    expect(OUTLOOK_COMPOSE_BASE).toBe('https://outlook.cloud.microsoft/mail/deeplink/compose');
    expect(OUTLOOK_COMPOSE_BASE).not.toContain('outlook.office.com');
    expect(DRAFT_URL_LIMIT).toBe(1800);
  });

  it('encodeDraftQuery uses %20, never +, never URLSearchParams form-encoding', () => {
    const q = encodeDraftQuery({ subject: 'a b', body: 'c d' });
    expect(q).toBe('subject=a%20b&body=c%20d');
    expect(q).not.toContain('+');
  });

  it('encodeDraftQuery percent-encodes a literal plus as %2B (never left bare)', () => {
    // A bare '+' surviving into the query string would collide with RFC 6068's
    // (non-existent) treatment of '+' and with form-decoders that read '+' as
    // space, corrupting the value on decode. URLSearchParams would emit '+'
    // for this input's own encoded spaces too, which is exactly the bug this
    // module exists to avoid.
    const q = encodeDraftQuery({ subject: 'a+b', body: 'c+d' });
    expect(q).toBe('subject=a%2Bb&body=c%2Bd');
  });

  it('encodeDraftQuery percent-encodes unicode (accents, CJK) via UTF-8 percent-encoding', () => {
    const q = encodeDraftQuery({
      subject: 'Café résumé 日本語 test',
      body: 'Price: $5 + tax\napostrophe test',
    });
    expect(q).toBe(
      'subject=Caf%C3%A9%20r%C3%A9sum%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20test&body=Price%3A%20%245%20%2B%20tax%0Aapostrophe%20test',
    );
  });

  it('outlook URL is ONE mailtouri param; plain to=/cc=/subject=/body= are ABSENT', () => {
    const url = composeOutlookWebUrl(BASE_INPUT);
    expect(url.startsWith(`${OUTLOOK_COMPOSE_BASE}?mailtouri=`)).toBe(true);
    const outer = url.slice(url.indexOf('?') + 1);
    for (const k of ['to=', 'cc=', 'subject=', 'body=']) {
      expect(outer.split('&').some((p) => p.startsWith(k))).toBe(false);
    }
  });

  it('golden URL: bare addresses, known input, full literal string (no display names)', () => {
    // Hardcoded end-to-end, NOT built from OUTLOOK_COMPOSE_BASE or by calling
    // encodeDraftQuery/composeOutlookWebUrl to derive the expectation — this
    // is the actual byte string a browser would receive for BASE_INPUT.
    expect(composeOutlookWebUrl(BASE_INPUT)).toBe(
      'https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=mailto%3Ato%2540example.test%3Fcc%3Dcc%2540example.test%26subject%3DSubject%2520with%2520spaces%2520%2526%2520specials%26body%3DLine%2520one%250ALine%2520two',
    );
  });

  it('golden URL: with display-name chips, known input, full literal string', () => {
    expect(composeOutlookWebUrl({ ...BASE_INPUT, toName: 'To Name', ccName: 'Cc Name' })).toBe(
      'https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=mailto%3ATo%2520Name%2520%253Cto%2540example.test%253E%3Fcc%3DCc%2520Name%2520%253Ccc%2540example.test%253E%26subject%3DSubject%2520with%2520spaces%2520%2526%2520specials%26body%3DLine%2520one%250ALine%2520two',
    );
  });

  it('two encoding layers exactly: decode recovers the original values', () => {
    const { to, params } = decodeCompose(composeOutlookWebUrl(BASE_INPUT));
    expect(to).toBe('to@example.test');
    expect(params.cc).toBe('cc@example.test');
    expect(params.subject).toBe('Subject with spaces & specials');
    expect(params.body).toBe('Line one\nLine two');
  });

  it('display names ride as name-addr chips in the OWA url ONLY', () => {
    const url = composeOutlookWebUrl({ ...BASE_INPUT, toName: 'To Name', ccName: 'Cc Name' });
    const { to, params } = decodeCompose(url);
    expect(to).toBe('To Name <to@example.test>');
    expect(params.cc).toBe('Cc Name <cc@example.test>');
    // mailto + clipboard stay BARE-ADDRESS (OWA parser extension does not travel):
    expect(composeMailtoUrl(BASE_INPUT)).toBe(
      'mailto:to@example.test?cc=cc%40example.test&subject=Subject%20with%20spaces%20%26%20specials&body=Line%20one%0ALine%20two',
    );
    expect(composeClipboardText(BASE_INPUT)).toContain('TO: to@example.test');
    expect(composeClipboardText(BASE_INPUT)).not.toContain('To Name');
  });

  it('an apostrophe in a display name is ALLOWED (not an RFC 5322 special) and rides through intact', () => {
    expect(assertSafeDisplayName("O'Brien Warehouse")).toBe("O'Brien Warehouse");
    const { to } = decodeCompose(composeOutlookWebUrl({ ...BASE_INPUT, toName: "O'Brien Warehouse" }));
    expect(to).toBe("O'Brien Warehouse <to@example.test>");
  });

  it('cc is OPTIONAL: omitted cc emits no cc param and no CC clipboard line', () => {
    const noCc = { to: 'to@example.test', subject: 'S', body: 'B' };
    const { params } = decodeCompose(composeOutlookWebUrl(noCc));
    expect('cc' in params).toBe(false);
    expect(composeMailtoUrl(noCc)).toBe('mailto:to@example.test?subject=S&body=B');
    expect(composeClipboardText(noCc)).not.toContain('CC:');
  });

  it('clipboard text carries labelled TO/CC/SUBJECT/MESSAGE blocks', () => {
    expect(composeClipboardText(BASE_INPUT)).toBe(
      ['TO: to@example.test', 'CC: cc@example.test', 'SUBJECT: Subject with spaces & specials', '', 'MESSAGE:', 'Line one\nLine two'].join('\n'),
    );
  });

  it('createOutlookComposeEmail returns the Brief section-30 shape', () => {
    const composed = createOutlookComposeEmail(BASE_INPUT);
    expect(composed.to).toBe('to@example.test');
    expect(composed.cc).toBe('cc@example.test');
    expect(composed.outlookWebUrl).toBe(composeOutlookWebUrl(BASE_INPUT));
    expect(composed.mailtoUrl).toBe(composeMailtoUrl(BASE_INPUT));
    expect(composed.clipboardText).toBe(composeClipboardText(BASE_INPUT));
  });

  it('assertSafeDisplayName rejects RFC 5322 specials (a comma splits recipients)', () => {
    expect(assertSafeDisplayName('Fresno Warehouse DC4')).toBe('Fresno Warehouse DC4');
    for (const bad of ['A, B', 'A <B>', 'A "B"', 'A @ B', 'A; B']) {
      expect(() => assertSafeDisplayName(bad)).toThrow();
    }
  });
});

/** Reference decode for an opaque-scheme deep link. `ms-outlook:` is NOT a
 *  hierarchical URL any more than `mailto:` is — slice at the first '?',
 *  never new URL().searchParams. */
function decodeMobileCompose(url: string): { base: string; params: Record<string, string>; order: string[] } {
  const q = url.indexOf('?');
  const base = url.slice(0, q === -1 ? undefined : q);
  const params: Record<string, string> = {};
  const order: string[] = [];
  if (q !== -1) {
    for (const pair of url.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      const key = pair.slice(0, eq);
      order.push(key);
      params[key] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return { base, params, order };
}

/**
 * THE CC ACCEPTANCE GATE for the native transport.
 *
 * The maintenance workflow depends on the requester creating the Zendesk
 * ticket while a FIXED cc address receives the copy. "Outlook opened" is not
 * success — a compose screen that opened with the cc silently missing is a
 * WORSE failure than not opening at all, because nobody notices. Every
 * assertion below exists to make a dropped cc a red test, not a quiet
 * business-process break.
 */
describe('composeOutlookMobileUrl — native ms-outlook: transport (CC regression gate)', () => {
  it('is a NATIVE app scheme, never an https URL (the whole bug: expo-linking hands https to the browser)', () => {
    expect(OUTLOOK_MOBILE_COMPOSE_BASE).toBe('ms-outlook://compose');
    const url = composeOutlookMobileUrl(BASE_INPUT);
    expect(url.startsWith('ms-outlook://compose?')).toBe(true);
    expect(url.startsWith('http')).toBe(false);
    expect(url).not.toContain('outlook.cloud.microsoft');
    expect(url).not.toContain('mailtouri=');
  });

  it('CC GATE: the cc parameter is present and decodes to the exact address', () => {
    const { params } = decodeMobileCompose(composeOutlookMobileUrl(BASE_INPUT));
    expect('cc' in params).toBe(true);
    expect(params.cc).toBe('cc@example.test');
    // An EMPTY cc= would satisfy "the param exists" while dropping the copy:
    expect((params.cc ?? '').length).toBeGreaterThan(0);
  });

  it('golden URL: known input, full literal string (to, cc, subject, body — in that order)', () => {
    // Hardcoded end-to-end, NOT derived by calling encodeDraftQuery or the
    // composer — this is the actual byte string handed to Linking.openURL.
    expect(composeOutlookMobileUrl(BASE_INPUT)).toBe(
      'ms-outlook://compose?to=to%40example.test&cc=cc%40example.test&subject=Subject%20with%20spaces%20%26%20specials&body=Line%20one%0ALine%20two',
    );
    expect(decodeMobileCompose(composeOutlookMobileUrl(BASE_INPUT)).order).toEqual([
      'to',
      'cc',
      'subject',
      'body',
    ]);
  });

  it('uses the SAME encodeDraftQuery encoder as the web path: %20 for spaces, never +', () => {
    const url = composeOutlookMobileUrl(BASE_INPUT);
    expect(url).toBe(
      `${OUTLOOK_MOBILE_COMPOSE_BASE}?${encodeDraftQuery({
        to: BASE_INPUT.to,
        cc: BASE_INPUT.cc,
        subject: BASE_INPUT.subject,
        body: BASE_INPUT.body,
      })}`,
    );
    expect(url).not.toContain('+');
    expect(url).toContain('%20');
  });

  it('one encoding layer only: decode recovers the exact subject and body, unicode included', () => {
    const { params } = decodeMobileCompose(
      composeOutlookMobileUrl({
        ...BASE_INPUT,
        subject: 'Café résumé 日本語 test',
        body: 'Price: $5 + tax\napostrophe test',
      }),
    );
    expect(params.to).toBe('to@example.test');
    expect(params.cc).toBe('cc@example.test');
    expect(params.subject).toBe('Café résumé 日本語 test');
    expect(params.body).toBe('Price: $5 + tax\napostrophe test');
  });

  it('CC GATE: the SAME assertSafeDisplayName guard applies — an RFC 5322 special in a name THROWS, it never splits the recipients', () => {
    // Why the guard has to run on this path too: an unquoted name-addr
    // containing a comma/semicolon/angle bracket splits into TWO recipients,
    // and the mandatory cc is what silently disappears. Failing loudly is the
    // only acceptable outcome — on both transports, identically.
    for (const bad of ['A, B', 'A <B>', 'A "B"', 'A @ B', 'A; B']) {
      expect(() => composeOutlookMobileUrl({ ...BASE_INPUT, ccName: bad })).toThrow();
      expect(() => composeOutlookMobileUrl({ ...BASE_INPUT, toName: bad })).toThrow();
      // ...exactly as the web path already does, for the same input:
      expect(() => composeOutlookWebUrl({ ...BASE_INPUT, ccName: bad })).toThrow();
    }
    expect(() => composeOutlookMobileUrl({ ...BASE_INPUT, toName: "O'Brien Warehouse" })).not.toThrow();
  });

  it('CC GATE: addresses ride BARE — a cosmetic display name never reshapes the cc value handed to an unverified parser', () => {
    // The name-addr chip is a VERIFIED OWA-web parser extension (see the
    // module doc). The native app is a different parser that nobody in this
    // repo has verified, and the failure mode of guessing wrong is exactly
    // the silent cc drop this gate exists to prevent. So the mobile deep link
    // holds the same bare-address boundary composeMailtoUrl already holds:
    // names are validated, then left out of the wire format. A missing chip
    // is cosmetic; a missing cc breaks the workflow.
    const named = composeOutlookMobileUrl({ ...BASE_INPUT, toName: 'To Name', ccName: 'Cc Name' });
    expect(named).toBe(composeOutlookMobileUrl(BASE_INPUT));
    const { params } = decodeMobileCompose(named);
    expect(params.cc).toBe('cc@example.test');
    expect(params.to).toBe('to@example.test');
    expect(named).not.toContain('Cc%20Name');
    expect(named).not.toContain('%3C');
  });

  it('cc is OPTIONAL at the transport layer: an omitted cc emits no empty cc= param', () => {
    const url = composeOutlookMobileUrl({ to: 'to@example.test', subject: 'S', body: 'B' });
    expect(url).toBe('ms-outlook://compose?to=to%40example.test&subject=S&body=B');
    expect(decodeMobileCompose(url).params).not.toHaveProperty('cc');
  });

  it('never longer than the web compose URL, so the shared DRAFT_URL_LIMIT guard already covers it', () => {
    // The web URL double-encodes an inner mailto: URI (every %xx becomes
    // %25xx) on top of a 52-char https base; this one encodes once onto a
    // 20-char scheme. That is why callers can keep measuring the web URL as
    // the binding constraint. If this ever inverts, the length guard has to
    // be revisited — hence the pin.
    for (const input of [
      BASE_INPUT,
      { ...BASE_INPUT, body: 'x'.repeat(1200) },
      { ...BASE_INPUT, body: 'line\nline '.repeat(120) },
    ]) {
      expect(composeOutlookMobileUrl(input).length).toBeLessThan(composeOutlookWebUrl(input).length);
    }
  });
});

/**
 * ADDRESS INJECTION — one poisoned recipient must not become two recipients,
 * or a second subject, on ANY transport.
 *
 * THE DEFECT (measured 2026-08-13, before this block existed). The delivery
 * builder's address validator was a negative-space regex — everything except
 * whitespace, `<>`, `,`, `;`, `:` and `"` — which ACCEPTED `? & = % / + # ! $ '
 * ( ) * | \ ^ { } [ ] ~` and backtick. `composeMailtoUrl` then interpolated the
 * To address into the URL PATH raw:
 *
 *   to = 'a?cc=attacker@evil.test'
 *     -> mailto:a?cc=attacker@evil.test?cc=arosas%40cvwest.org&subject=S&body=B
 *
 * A URL parser reads that as To `a`, cc `attacker@evil.test?cc=arosas@cvwest.org`
 * — one cc, belonging to the attacker, with the MANDATORY CC swallowed into
 * their value. Not "an extra recipient appears": the acceptance gate silently
 * disappears, which is the exact failure this whole feature is built around.
 *
 * The other three transports were already safe, and are asserted here anyway
 * rather than reasoned about — a fix applied to one of four copies of a
 * behaviour is recurring pattern #26, and "the other three encode" is precisely
 * the kind of claim that stops being true when someone adds a fifth.
 */
describe('a poisoned recipient cannot inject a second recipient or subject, on any transport', () => {
  const POISONED = [
    ['a query-string cc injection', 'a?cc=attacker@evil.test'],
    ['a query-string subject injection', 'a?subject=Approved@evil.test'],
    ['a fragment', 'a#x@evil.test'],
    ['an ampersand', 'a&cc=attacker@evil.test'],
    ['a comma-joined second address', 'first@evil.test,attacker@evil.test'],
    ['a semicolon-joined second address', 'first@evil.test;attacker@evil.test'],
    ['a percent-encoded question mark', 'a%3Fcc=attacker@evil.test'],
    ['a newline forging a header line', 'x@y.test\nCC: attacker@evil.test'],
    ['a name-addr', 'Attacker <attacker@evil.test>'],
    ['empty', ''],
    ['whitespace only', '   '],
  ] as const;

  const GOOD = { to: 'dc4@example.test', cc: 'arosas@example.test', subject: 'S', body: 'B' };

  const TRANSPORTS = [
    ['outlook web', composeOutlookWebUrl],
    ['ms-outlook native', composeOutlookMobileUrl],
    ['mailto', composeMailtoUrl],
    ['clipboard', composeClipboardText],
  ] as const;

  for (const [transportLabel, compose] of TRANSPORTS) {
    for (const [label, poison] of POISONED) {
      it(`${transportLabel}: refuses ${label} in the TO`, () => {
        expect(() => compose({ ...GOOD, to: poison })).toThrow(
          /recipient "to" must be exactly one plain email address/,
        );
      });

      it(`${transportLabel}: refuses ${label} in the CC`, () => {
        expect(() => compose({ ...GOOD, cc: poison })).toThrow(
          /recipient "cc" must be exactly one plain email address/,
        );
      });
    }

    it(`${transportLabel}: still composes the well-formed pair, so the refusals above mean something`, () => {
      // Without this every test above is satisfied by a function that throws
      // unconditionally.
      const out = compose(GOOD);
      expect(out).toContain('dc4');
      expect(out).toContain('arosas');
    });
  }

  it('THE GRAMMAR IS NARROWER THAN RFC 5322, deliberately — `a?cc=x` is a legal dot-atom', () => {
    // Stated as a test because it is the reason the encoder below exists and
    // must not be deleted as redundant. `?` and `=` are RFC 5322 `atext`, so a
    // validator faithful to the RFC would admit the injection string. The
    // accepted local-part set is the practical mailbox one instead.
    for (const ch of ['?', '&', '=', '%', '/', '#', '!', '$', "'", '(', ')', '*', '|', '\\', '^', '{', '}', '[', ']', '`', '~']) {
      expect(() => assertRoutableAddress('to', `a${ch}b@evil.test`)).toThrow();
    }
    // and the practical set it keeps, so this is a narrowing and not a ban
    for (const ok of [
      'dc4@learn4life.org',
      'arosas@cvwest.org',
      'user+tag@learn4life.org',
      'first.last@sub.domain.example',
      'a_b-c@x-y.co.uk',
    ]) {
      expect(assertRoutableAddress('to', ok)).toBe(ok);
    }
  });

  it('rejects an address past the RFC 5321 254-character ceiling', () => {
    const long = `${'a'.repeat(250)}@evil.test`;
    expect(long.length).toBeGreaterThan(254);
    expect(() => assertRoutableAddress('to', long)).toThrow();
  });

  /**
   * THE SECOND LAYER, tested WITHOUT the first.
   *
   * `assertRoutableAddress` makes the injection unreachable; the encoder makes
   * it impossible. That distinction is not academic — the validator is a regex,
   * and a regex is what got loosened last time. These two assertions are what
   * would still hold if the grammar were widened back to something that admits
   * `?`, so they are written against the encoder directly rather than through a
   * compose function that refuses before reaching it.
   */
  it('ENCODER: a poisoned address in the mailto PATH still yields exactly one cc — the real one', () => {
    const poisoned = 'a?cc=attacker@evil.test';
    const url = `mailto:${encodeMailtoPathAddress(poisoned)}?cc=${encodeURIComponent('arosas@example.test')}&subject=S`;

    expect(encodeMailtoPathAddress(poisoned)).toBe('a%3Fcc%3Dattacker@evil.test');
    const parsed = new URLSearchParams(new URL(url).search);
    expect(parsed.getAll('cc')).toEqual(['arosas@example.test']);
    expect(parsed.getAll('subject')).toEqual(['S']);
  });

  it('ENCODER: is the IDENTITY on every address the validator admits, so the shipped URLs are byte-for-byte unchanged', () => {
    // The owner tenant-verified these URLs against live Microsoft 365. If
    // encoding changed their bytes, that verification would no longer apply to
    // what ships. It does not: the accepted grammar is a strict subset of the
    // path-safe set.
    for (const address of [
      'dc4@learn4life.org',
      'arosas@cvwest.org',
      'user+tag@learn4life.org',
      'first.last@sub.domain.example',
      'a_b-c@x-y.co.uk',
    ]) {
      expect(encodeMailtoPathAddress(assertRoutableAddress('to', address))).toBe(address);
    }

    expect(composeMailtoUrl({ to: 'dc4@learn4life.org', cc: 'arosas@cvwest.org', subject: 'S', body: 'B' })).toBe(
      'mailto:dc4@learn4life.org?cc=arosas%40cvwest.org&subject=S&body=B',
    );
  });

  /**
   * THE TWO LAYERS' RELATIONSHIP, pinned as an invariant rather than assumed.
   *
   * Honest statement of what is and is not covered: while the validator stays
   * strict, the encoder can never actually fire inside `composeMailtoUrl` —
   * nothing poisoned reaches it — so SUBSTITUTING the encoder for a raw
   * interpolation at that one call site is not detectable by any test, because
   * it is the identity on every input that gets that far. That is what defense
   * in depth means here, not a gap being papered over.
   *
   * What IS detectable, and what this test is for, is the relationship going
   * out of alignment. If the validator is ever widened past the encoder's safe
   * set — which is exactly how the shipped defect arose, a negative-space regex
   * quietly admitting `?` — this fails and says so, which is the moment the
   * encoder stops being belt-and-braces and becomes the only thing standing
   * between a poisoned address and the mandatory CC.
   */
  it('INVARIANT: every character the validator ADMITS is one the encoder leaves alone', () => {
    const admitted = new Set<string>();
    for (let code = 0x20; code < 0x7f; code += 1) {
      const ch = String.fromCharCode(code);
      // Try the character in the local part and in a domain label; if either
      // placement validates, the encoder has to be able to carry it verbatim.
      for (const candidate of [`a${ch}b@example.test`, `ab@ex${ch}ample.test`]) {
        try {
          assertRoutableAddress('to', candidate);
          admitted.add(ch);
        } catch {
          /* rejected: the encoder never sees it through a compose function */
        }
      }
    }

    // Non-empty, or the assertion below is vacuous.
    expect(admitted.size).toBeGreaterThan(30);
    for (const ch of admitted) {
      expect(encodeMailtoPathAddress(`a${ch}b`)).toBe(`a${ch}b`);
    }
    // And the specific characters that carry URL meaning are NOT in that set.
    for (const ch of ['?', '#', ',', '&', '=', '%', '/', ';', ':', ' ']) {
      expect(admitted.has(ch)).toBe(false);
    }
  });

  it('ENCODER: percent-encodes every character that means something to a URL parser', () => {
    for (const [raw, encoded] of [
      ['?', '%3F'],
      ['#', '%23'],
      [',', '%2C'],
      ['&', '%26'],
      ['=', '%3D'],
      ['%', '%25'],
      ['/', '%2F'],
      [';', '%3B'],
      [' ', '%20'],
      ['\n', '%0A'],
    ] as const) {
      expect(encodeMailtoPathAddress(`a${raw}b`)).toBe(`a${encoded}b`);
    }
  });
});
