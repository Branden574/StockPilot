import { describe, expect, it } from 'vitest';

import { plainAddressMailtoUrl as mailto } from './mailto-link';

/**
 * SECURITY: a mailto: link made from a stored address opens only the one
 * address the screen shows (the phone's Team and Users cards, the web's
 * support triage, and the supplier cards on both apps). Every refusal below
 * passes through the old `mailto:${email}` unchanged, which is what made the
 * link do more than the screen said.
 */
describe('plainAddressMailtoUrl: one plain address becomes a link', () => {
  it('trimmed, percent-encoded on either side of a literal @', () => {
    expect(mailto('orders@acme.com')).toBe('mailto:orders@acme.com');
    expect(mailto('  orders@acme.com  ')).toBe('mailto:orders@acme.com');
    expect(mailto('first.last+po@mail.acme.co.uk')).toBe('mailto:first.last%2Bpo@mail.acme.co.uk');
    expect(mailto("o'brien@acme.com")).toBe("mailto:o'brien@acme.com");
    expect(mailto('Orders-2026@Acme-Supply.co')).toBe('mailto:Orders-2026@Acme-Supply.co');
    expect(mailto('ap_desk@acme.example.com')).toBe('mailto:ap_desk@acme.example.com');
    // RFC 6068: the '@' between the name and the domain stays literal; an
    // encoded %40 is a character inside the name and leaves no domain.
    expect(mailto('orders@acme.com')).not.toContain('%40');
    // Read back by the mail app as the same one address.
    expect(decodeURIComponent(mailto('first.last+po@acme.co.uk')!.slice('mailto:'.length))).toBe(
      'first.last+po@acme.co.uk',
    );
  });
});

describe('plainAddressMailtoUrl: anything else is not a link', () => {
  // Mutation caught: the old `mailto:${email}`, which opened this message
  // with a hidden copy to x@y.z.
  it("'?bcc=' and every other query, recipient list or separator", () => {
    for (const email of [
      'a@b.com?bcc=x@y.z',
      'a@b.com?BCC=x@y.z',
      'a@b.com?cc=x@y.z',
      'a@b.com?subject=Invoice',
      'a@b.com?body=hi',
      'a@b.com&bcc=x@y.z',
      'a%3Fbcc%3Dx@b.com',
      'a@b.com%3Fbcc%3Dx%40y.z',
      'a@b.com,x@y.z',
      'a@b.com;x@y.z',
      'a@b.com x@y.z',
      'a b@c.com',
      'a@b.com#x',
      'a@b%2Ecom',
      '"a"@b.com',
      '<a@b.com>',
      'a@[127.0.0.1]',
      'a@b.com/x',
      'mailto:a@b.com',
    ]) {
      expect(mailto(email), JSON.stringify(email)).toBeNull();
    }
  });

  // Mutation caught: a deny-list (or a \w / Unicode-letter pattern), which
  // lets through characters it does not name.
  it('a zero-width joiner, anywhere in the address', () => {
    for (const email of [
      'or\u200Dders@acme.com',
      'orders\u200D@acme.com',
      'orders@ac\u200Dme.com',
      'orders@acme.com\u200D',
    ]) {
      expect(mailto(email), JSON.stringify(email)).toBeNull();
    }
  });

  it('a tag character (U+E0000 to U+E007F), which no screen draws', () => {
    for (const email of [
      'orders\u{E0041}@acme.com',
      'orders@acme\u{E0062}\u{E0063}\u{E0063}.com',
      'orders@acme.com\u{E007F}',
      '\u{E0001}orders@acme.com',
    ]) {
      expect(mailto(email), JSON.stringify(email)).toBeNull();
    }
  });

  it('fullwidth letters, digits, @ and dots that read like the ASCII ones', () => {
    for (const email of [
      '\uFF4F\uFF52\uFF44\uFF45\uFF52\uFF53@acme.com', // fullwidth 'orders'
      'orders@\uFF41\uFF43\uFF4D\uFF45.com', // fullwidth 'acme'
      'orders@acme.\uFF43\uFF4F\uFF4D', // fullwidth 'com'
      'orders\uFF20acme.com', // fullwidth '@'
      'orders@acme\uFF0Ecom', // fullwidth '.'
      'orders@acme\u3002com', // ideographic full stop
      'orders\uFF11@acme.com', // fullwidth '1'
    ]) {
      expect(mailto(email), JSON.stringify(email)).toBeNull();
    }
  });

  it('control, direction and other invisible characters', () => {
    for (const email of [
      'a\u0000@b.com',
      'a@b\u0007.com',
      'a@b.com\r\nbcc:x@y.z',
      'a\u200B@b.com',
      'a@b\u202E.com',
      'a@b.com\u2066',
      '\u00ADa@b.com',
      'a\u2060@b.com',
    ]) {
      expect(mailto(email), JSON.stringify(email)).toBeNull();
    }
  });

  it('look-alike letters from other scripts, and any other non-ASCII letter', () => {
    for (const email of [
      '\u0430cme@acme.com', // Cyrillic a
      'orders@\u0430cme.com',
      'orders@acme.\u0441om', // Cyrillic s
      '\u00FCber@acme.com',
      'orders@m\u00FCller.de',
    ]) {
      expect(mailto(email), JSON.stringify(email)).toBeNull();
    }
  });

  it('text that is not one address with a dotted domain, or is too long', () => {
    for (const email of [
      '',
      '   ',
      'orders',
      '@acme.com',
      'orders@',
      'orders@acme',
      'orders@.com',
      'orders@acme.',
      'orders@acme..com',
      'a@b@c.com',
      'a@@b.com',
      '.orders@acme.com',
      'orders.@acme.com',
      'or..ders@acme.com',
      'orders@-acme.com',
      'orders@acme-.com',
      'orders@acme.com.',
      'orders@acme_co.com',
      `${'a'.repeat(65)}@acme.com`,
      `orders@${'a'.repeat(64)}.com`,
      `${'a'.repeat(60)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(63)}.com`,
    ]) {
      expect(mailto(email), JSON.stringify(email)).toBeNull();
    }
    expect(mailto(null)).toBeNull();
    expect(mailto(undefined)).toBeNull();
  });

  it('a subject never makes a refused address a link', () => {
    expect(mailto('a@b.com?bcc=x@y.z', { subject: 'Re: hi' })).toBeNull();
    expect(mailto('or\u200Dders@acme.com', { subject: 'Re: hi' })).toBeNull();
  });
});

describe('plainAddressMailtoUrl: the subject', () => {
  it('goes out as the one subject parameter, percent-encoded', () => {
    expect(mailto('dana@example.com', { subject: 'Re: Scanner stops after one scan' })).toBe(
      `mailto:dana@example.com?subject=${encodeURIComponent('Re: Scanner stops after one scan')}`,
    );
  });

  // Mutation caught: the subject appended without encoding, as the triage
  // link's "Re: " was, which lets a subject add its own parameters.
  it('cannot add a recipient or another parameter', () => {
    const url = mailto('dana@example.com', {
      subject: 'Re: x&bcc=eve@evil.test&cc=mallory@evil.test',
    })!;
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect([...query.keys()]).toEqual(['subject']);
    expect(query.get('subject')).toBe('Re: x&bcc=eve@evil.test&cc=mallory@evil.test');
  });

  it('is one line, without control or invisible characters', () => {
    const url = mailto('dana@example.com', {
      subject: 'Re: line one\r\nBcc: eve@evil.test\u0000 tag\u{E0041}\u200D end',
    })!;
    const subject = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('subject');
    expect(subject).toBe('Re: line one Bcc: eve@evil.test tag end');
    expect(subject).not.toMatch(/[\r\n\u0000\u200D]/);
  });

  it('is at most 200 characters, cut between characters, never inside an emoji', () => {
    const long = `Re: ${'x'.repeat(195)}\u{1F600}\u{1F600}`;
    const url = mailto('dana@example.com', { subject: long })!;
    const subject = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('subject')!;
    expect(Array.from(subject)).toHaveLength(200);
    expect(subject.endsWith('\u{1F600}')).toBe(true);
  });

  it('a lone surrogate is dropped instead of throwing', () => {
    expect(() => mailto('dana@example.com', { subject: 'Re: \uD83D broken' })).not.toThrow();
    expect(mailto('dana@example.com', { subject: 'Re: \uD83D broken' })).toBe(
      `mailto:dana@example.com?subject=${encodeURIComponent('Re: broken')}`,
    );
  });

  it('a blank or missing subject adds no parameter', () => {
    expect(mailto('dana@example.com', { subject: '  \r\n ' })).toBe('mailto:dana@example.com');
    expect(mailto('dana@example.com', { subject: null })).toBe('mailto:dana@example.com');
    expect(mailto('dana@example.com', {})).toBe('mailto:dana@example.com');
  });
});
