import { describe, expect, it } from 'vitest';

import {
  OUTLOOK_COMPOSE_BASE,
  DRAFT_URL_LIMIT,
  encodeDraftQuery,
  composeOutlookWebUrl,
  composeMailtoUrl,
  composeClipboardText,
  createOutlookComposeEmail,
  assertSafeDisplayName,
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
