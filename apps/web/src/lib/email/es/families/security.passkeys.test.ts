import { describe, expect, it } from 'vitest';

import { renderPasskeyAddedEmail, renderPasskeyRemovedEmail } from './security';

/**
 * The two passkey emails of stage 4 (plan 2.8, section 4): the subject, the
 * device as our server read it, never the member's name for the passkey
 * (review 1 F5: the emails take no name at all), and no link that signs in
 * (the one button is support).
 */

const added = renderPasskeyAddedEmail({
  email: 'member@example.test',
  addedAt: 'Nov 21, 2026, 9:41 AM UTC',
  device: 'Chrome on macOS',
  appUrl: 'https://app.example.test',
});
const removed = renderPasskeyRemovedEmail({
  email: 'member@example.test',
  removedAt: 'Nov 21, 2026, 9:41 AM UTC',
  appUrl: 'https://app.example.test',
});

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

describe('passkey emails', () => {
  it('added: the subject, the time and the device, from the security sender', () => {
    expect(added.subject).toBe('A passkey was added to your StockPilot account');
    expect(added.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(added.text).toContain('on Nov 21, 2026, 9:41 AM UTC from Chrome on macOS');
    expect(added.text).toContain('remove it in Settings, Security, and change your password');
    expect(added.html).toContain('Chrome on macOS');
  });

  it('removed: the subject and that the other devices were signed out', () => {
    expect(removed.subject).toBe('A passkey was removed from your StockPilot account');
    expect(removed.text).toContain('You were signed out on your other devices.');
    expect(removed.text).toContain('Change your password now');
  });

  it('the renderers take no passkey name: nothing a member typed can be printed', () => {
    // The parameters carry no name field; a name passed anyway is not printed.
    const withName = renderPasskeyAddedEmail({
      email: 'member@example.test',
      addedAt: 'now',
      device: 'Safari on iOS',
      ...({ name: 'Front desk key' } as object),
    });
    expect(withName.html).not.toContain('Front desk key');
    expect(withName.text).not.toContain('Front desk key');
  });

  it('no link signs in: every link is support, privacy, terms or the unsubscribe-free footer', () => {
    for (const html of [added.html, removed.html]) {
      for (const href of hrefs(html)) {
        expect(href, href).not.toMatch(/signin|sign-in|token=|code=|verify|magic|reset/i);
      }
    }
  });
});
