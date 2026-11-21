import { describe, expect, it } from 'vitest';

import { DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY } from '@/components/settings/delete-account-copy';

import { esEmailById } from '../registry';
import { ES_MAX_HTML_BYTES } from '../tokens';
import {
  renderAccountDeleteCodeEmail,
  renderPasswordResetEmail,
  renderSigninAlertEmail,
  SIGNIN_ALERT_LAST_FOR_A_DAY_TEXT,
} from './security';

import type { RenderedEsEmail } from './security';

// Registry sample world (ES.W) adapted to real merge params.
const SEED = {
  email: 'owner@example.com',
  firstName: 'Carsten',
  resetUrl: 'https://stockpilotusa.com/auth/confirm?token_hash=pkce_4Kx&type=recovery&next=%2Freset%2Fcomplete',
  requestedAt: 'Jun 12, 2026, 2:41 PM PT',
  device: 'Chrome on macOS',
  when: 'Jun 12, 2026, 2:41 PM PT',
  ip: '203.0.113.7',
  securityUrl: 'https://stockpilotusa.com/dashboard/settings/security',
  appUrl: 'https://stockpilotusa.com',
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function assertNoLeakage(res: RenderedEsEmail): void {
  for (const surface of [res.html, res.text, res.subject, res.preheader]) {
    expect(surface).not.toContain('undefined');
    expect(surface).not.toContain('null');
    expect(surface).not.toContain('{{');
    expect(surface).not.toMatch(UUID_RE);
  }
}

function assertWeight(res: RenderedEsEmail): void {
  expect(Buffer.byteLength(res.html, 'utf8')).toBeLessThanOrEqual(ES_MAX_HTML_BYTES);
}

function assertEssentialFooter(html: string): void {
  expect(html).toContain('can&rsquo;t be unsubscribed');
  expect(html).not.toContain('>Unsubscribe</a>');
  expect(html).not.toContain('Manage email preferences');
  expect(html).toContain('>Support</a>');
  expect(html).toContain('>Privacy</a>');
  expect(html).toContain('>Terms</a>');
}

describe('pw-reset (renderPasswordResetEmail)', () => {
  const render = () =>
    renderPasswordResetEmail({
      email: SEED.email,
      resetUrl: SEED.resetUrl,
      firstName: SEED.firstName,
      requestedAt: SEED.requestedAt,
      device: SEED.device,
      appUrl: SEED.appUrl,
    });

  it('renders with realistic seed data — hero, CTA, info card, no leakage', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.html).toContain('Reset your password.');
    expect(res.html).toContain('Takes about a minute.');
    expect(res.html).toContain('Hi Carsten —');
    expect(res.html).toContain('owner@example.com');
    expect(res.html).toContain('Didn&rsquo;t request this?');
    expect(res.html).toContain('Requested Jun 12, 2026, 2:41 PM PT, from Chrome on macOS.');
    // Bulletproof CTA with the registry label.
    expect(res.html).toContain('>Reset password &rarr;</a>');
    // Link fallback carries the (escaped) reset URL.
    expect(res.html).toContain('Or paste this link into your browser');
    expect(res.html).toContain('token_hash=pkce_4Kx&amp;type=recovery');
  });

  it('subject and preheader are byte-equal to the registry builders', () => {
    const def = esEmailById('pw-reset');
    const res = render();
    expect(res.subject).toBe(def.subject({}));
    expect(res.subject).toBe('Reset your StockPilot password');
    expect(res.preheader).toBe(def.preheader({ linkExpiry: '60 minutes' }));
    expect(res.html).toContain(res.preheader);
  });

  it('sends from the registry security sender', () => {
    const res = render();
    expect(res.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(res.replyTo).toBeUndefined();
  });

  it('uses the essential footer (no unsubscribe)', () => {
    assertEssentialFooter(render().html);
  });

  it('embeds the lock hero with reserved dimensions and message-carrying alt', () => {
    const res = render();
    expect(res.html).toContain('https://stockpilotusa.com/email/motion/lock@2x.gif');
    expect(res.html).toContain('width="528" height="194"');
    expect(res.html).toContain(
      'alt="A lock closes with a soft verification ring — password-reset link secured"',
    );
  });

  it('falls back to "Hi —" without a first name and drops unknown provenance', () => {
    const res = renderPasswordResetEmail({
      email: SEED.email,
      resetUrl: SEED.resetUrl,
    });
    assertNoLeakage(res);
    expect(res.html).toContain('Hi —');
    expect(res.html).not.toContain('Requested');
    expect(res.html).toContain('and can be used once.');
  });

  it('keeps the "Requested …" sentence without a device label', () => {
    const res = renderPasswordResetEmail({
      email: SEED.email,
      resetUrl: SEED.resetUrl,
      requestedAt: SEED.requestedAt,
    });
    expect(res.html).toContain('Requested Jun 12, 2026, 2:41 PM PT.');
    expect(res.html).not.toContain(', from');
  });

  it('stress: long email + hostile name stay escaped and under budget', () => {
    const res = renderPasswordResetEmail({
      email: 'exceptionally.long.recipient.address.for.stress-testing@very-long-subdomain.example-warehouse-operations.com',
      resetUrl: SEED.resetUrl,
      firstName: '<script>alert(1)</script>',
      requestedAt: SEED.requestedAt,
      device: SEED.device,
    });
    assertWeight(res);
    expect(res.html).not.toContain('<script>');
    expect(res.html).toContain('&lt;script&gt;');
    expect(res.html).toContain(
      'exceptionally.long.recipient.address.for.stress-testing@very-long-subdomain.example-warehouse-operations.com',
    );
  });
});

describe('signin (renderSigninAlertEmail)', () => {
  const render = () =>
    renderSigninAlertEmail({
      email: SEED.email,
      device: SEED.device,
      ip: SEED.ip,
      when: SEED.when,
      securityUrl: SEED.securityUrl,
      resetUrl: `${SEED.appUrl}/reset`,
      appUrl: SEED.appUrl,
    });

  it('renders with realistic seed data — detail grid, banner, both CTAs', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.html).toContain('New sign-in to your account.');
    expect(res.html).toContain('Was this you?');
    expect(res.html).toContain('Chrome on macOS');
    expect(res.html).toContain('203.0.113.7');
    expect(res.html).toContain('Don&rsquo;t recognize this?');
    expect(res.html).toContain('>Secure my account &rarr;</a>');
    expect(res.html).toContain('>Reset password</a>');
  });

  it('subject and preheader are byte-equal to the registry builders', () => {
    const def = esEmailById('signin');
    const res = render();
    expect(res.subject).toBe(def.subject({}));
    expect(res.subject).toBe('New sign-in to your StockPilot account');
    expect(res.preheader).toBe(def.preheader({ summary: SEED.device, time: SEED.when }));
    expect(res.html).toContain(res.preheader);
  });

  it('sends from the registry security sender', () => {
    const res = render();
    expect(res.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(res.replyTo).toBeUndefined();
  });

  it('uses the essential footer and NEVER reintroduces the false preference claim', () => {
    const res = render();
    assertEssentialFooter(res.html);
    // Registry flag: the old copy claimed a manageable preference that
    // does not exist. Neither surface may claim alerts are configurable.
    for (const surface of [res.html, res.text]) {
      expect(surface).not.toContain('alerts are on for your account');
      expect(surface).not.toMatch(/notification preferences/i);
      expect(surface).not.toMatch(/only the first time/i);
    }
    expect(res.html).toContain('a core account-safety notice');
  });

  it('the footer says it is sent when a new device signs in', () => {
    const res = render();
    expect(res.html).toContain(
      `>${SEED.email}</span> when a new device signs in — a core account-safety notice.`,
    );
    expect(res.html).not.toContain('whenever a new device signs in');
  });

  it('embeds the pulse hero with reserved dimensions and alt text', () => {
    const res = render();
    expect(res.html).toContain('https://stockpilotusa.com/email/motion/pulse@2x.gif');
    expect(res.html).toContain('width="528" height="194"');
    expect(res.html).toMatch(/alt="[^"]*new device signed in[^"]*"/);
  });

  it('the email that reaches the 24-hour count says so in one sentence, in both parts', () => {
    const sentence =
      'Further new-device sign-ins won’t send more emails for up to 24 hours, so if these sign-ins weren’t you, change your password and review your devices under Active sessions in your security settings now.';
    expect(SIGNIN_ALERT_LAST_FOR_A_DAY_TEXT).toBe(sentence);
    const res = renderSigninAlertEmail({
      email: SEED.email,
      device: SEED.device,
      ip: SEED.ip,
      when: SEED.when,
      securityUrl: SEED.securityUrl,
      resetUrl: `${SEED.appUrl}/reset`,
      appUrl: SEED.appUrl,
      lastForADay: true,
    });
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.text).toContain(sentence);
    expect(res.html).toContain(
      'Further new-device sign-ins won&rsquo;t send more emails for up to 24 hours, so if these sign-ins weren&rsquo;t you, change your password and review your devices under Active sessions in your security settings now.',
    );
  });

  it('every other new-device email carries no such sentence', () => {
    const res = render();
    for (const surface of [res.html, res.text]) {
      expect(surface).not.toMatch(/up to 24 hours/);
    }
  });

  it('stress: unknown ip + missing first name + hostile device stay safe', () => {
    const res = renderSigninAlertEmail({
      email: SEED.email,
      device: '<img src=x onerror=alert(1)> on "Windows"',
      ip: 'unknown',
      when: SEED.when,
      securityUrl: SEED.securityUrl,
      resetUrl: `${SEED.appUrl}/reset`,
    });
    assertWeight(res);
    expect(res.html).toContain('Hi —');
    expect(res.html).toContain('Unknown');
    expect(res.html).not.toContain('<img src=x');
    expect(res.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

// ── email change (2026-08-25, mig 0345) ─────────────────────────────

import {
  renderEmailChangeCurrentEmail,
  renderEmailChangeNewEmail,
  renderEmailChangedNoticeEmail,
} from './security';

const EC = {
  currentEmail: 'owner@example.com',
  newEmail: 'carsten@example.com',
  confirmUrl: 'https://stockpilotusa.com/auth/confirm?token_hash=NEWSIDE&type=email_change',
  approveUrl: 'https://stockpilotusa.com/auth/confirm?token_hash=CURSIDE&type=email_change',
  changedAt: 'Aug 25, 2026, 4:02 PM UTC',
  requestedAt: 'Aug 25, 2026, 3:58 PM UTC',
  appUrl: 'https://stockpilotusa.com',
};

describe('email-change-new (renderEmailChangeNewEmail)', () => {
  const render = () =>
    renderEmailChangeNewEmail({
      newEmail: EC.newEmail,
      currentEmail: EC.currentEmail,
      confirmUrl: EC.confirmUrl,
      firstName: 'Carsten',
      appUrl: EC.appUrl,
    });

  it('renders the confirmation to the NEW address and says the current one stays canonical', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    assertEssentialFooter(res.html);
    expect(res.html).toContain('Confirm your new email.');
    expect(res.html).toContain(EC.newEmail);
    expect(res.html).toContain(EC.currentEmail);
    expect(res.html).toContain('>Confirm new email &rarr;</a>');
    expect(res.html).toContain('token_hash=NEWSIDE&amp;type=email_change');
    expect(res.text).toContain(EC.confirmUrl);
    expect(res.text).toContain(`keeps using ${EC.currentEmail} until both addresses have confirmed`);
    // The new-side email must never carry the approval (current-side) link.
    expect(res.html).not.toContain('CURSIDE');
  });

  it('subject and preheader are byte-equal to the registry builders', () => {
    const def = esEmailById('email-change-new');
    const res = render();
    expect(res.subject).toBe(def.subject({}));
    expect(res.preheader).toBe(def.preheader({ linkExpiry: '60 minutes' }));
    expect(res.from).toBe('StockPilot Security <security@stockpilotusa.com>');
  });
});

describe('email-change-current (renderEmailChangeCurrentEmail)', () => {
  const render = () =>
    renderEmailChangeCurrentEmail({
      currentEmail: EC.currentEmail,
      newEmail: EC.newEmail,
      approveUrl: EC.approveUrl,
      firstName: 'Carsten',
      requestedAt: EC.requestedAt,
      appUrl: EC.appUrl,
    });

  it('leads with the "do not approve" warning and carries the approval link', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    assertEssentialFooter(res.html);
    expect(res.html).toContain('Approve your email change.');
    expect(res.html).toContain('Do not approve it.');
    expect(res.html).toContain('>Approve email change &rarr;</a>');
    expect(res.html).toContain('token_hash=CURSIDE&amp;type=email_change');
    expect(res.html).toContain('Requested Aug 25, 2026, 3:58 PM UTC.');
    expect(res.html).toContain('https://stockpilotusa.com/reset');
    expect(res.text).toContain(EC.approveUrl);
    expect(res.html).not.toContain('NEWSIDE');
  });

  it('subject names the target address, byte-equal to the registry', () => {
    const def = esEmailById('email-change-current');
    const res = render();
    expect(res.subject).toBe(def.subject({ newEmail: EC.newEmail }));
    expect(res.subject).toBe(`Approve changing your StockPilot email to ${EC.newEmail}`);
    expect(res.preheader).toBe(def.preheader({ linkExpiry: '60 minutes' }));
  });

  it('escapes a hostile target address', () => {
    const res = renderEmailChangeCurrentEmail({
      currentEmail: EC.currentEmail,
      newEmail: '"><img src=x onerror=alert(1)>@evil.test',
      approveUrl: EC.approveUrl,
    });
    expect(res.html).not.toContain('<img src=x');
    expect(res.html).toContain('&lt;img src=x');
  });
});

describe('email-changed (renderEmailChangedNoticeEmail)', () => {
  const render = () =>
    renderEmailChangedNoticeEmail({
      oldEmail: EC.currentEmail,
      newEmail: EC.newEmail,
      changedAt: EC.changedAt,
      firstName: 'Carsten',
      appUrl: EC.appUrl,
    });

  it('records previous → new, the time, and the "didn’t do this" escalation', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    assertEssentialFooter(res.html);
    expect(res.html).toContain('Your sign-in email was changed.');
    expect(res.html).toContain(EC.currentEmail);
    expect(res.html).toContain(EC.newEmail);
    expect(res.html).toContain('Aug 25, 2026, 4:02 PM UTC');
    expect(res.html).toContain('Contact your administrator immediately.');
    expect(res.html).toContain('>Contact support &rarr;</a>');
    expect(res.text).toContain(`from ${EC.currentEmail} to ${EC.newEmail}`);
    // No link that could act on the account: this is a record, not a lever.
    expect(res.html).not.toContain('token_hash=');
  });

  it('subject and preheader are byte-equal to the registry builders', () => {
    const def = esEmailById('email-changed');
    const res = render();
    expect(res.subject).toBe(def.subject({}));
    expect(res.subject).toBe('Your StockPilot email was changed');
    expect(res.preheader).toBe(def.preheader({ newEmail: EC.newEmail }));
  });
});

describe('account-delete-code (renderAccountDeleteCodeEmail)', () => {
  const render = () =>
    renderAccountDeleteCodeEmail({
      email: SEED.email,
      code: '042917',
      codeExpiry: '10 minutes',
      firstName: SEED.firstName,
      appUrl: SEED.appUrl,
    });

  it('puts the code in the body only, never in the subject or the preheader', () => {
    const res = render();
    expect(res.html).toContain('042917');
    expect(res.text).toContain('042917');
    expect(res.subject).not.toContain('042917');
    expect(res.preheader).not.toContain('042917');
    expect(res.subject).toBe(esEmailById('account-delete-code').subject({}));
  });

  it('says what the code is for, how long it works, and that nothing happens unless it is used', () => {
    const res = render();
    for (const surface of [res.text, res.html]) {
      expect(surface).toMatch(/delete/i);
      expect(surface).toContain('10 minutes');
      expect(surface).toContain('Nothing happens unless the code is used.');
    }
    expect(res.text).toContain(SEED.email);
  });

  it('is sent from security, essential, with no emoji, no exclamation mark and no leakage', () => {
    const res = render();
    expect(res.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    assertEssentialFooter(res.html);
    assertNoLeakage(res);
    assertWeight(res);
    expect(res.text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(res.text).not.toContain('!');
    expect(res.subject).not.toContain('!');
  });

  it('says that only the newest code works, in the HTML and the plain text, with the dialog\'s own sentence', () => {
    const res = render();
    expect(DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY).toBe('If you ask again, only the newest code works.');
    expect(res.html).toContain(DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY);
    expect(res.text).toContain(DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY);
  });

  it('the plain text opens with the same greeting as the HTML', () => {
    const res = render();
    expect(res.html).toContain('Hi Carsten — someone asked to delete the StockPilot account for');
    const lines = res.text.split('\n').filter((l) => l.length > 0);
    expect(lines[1]).toMatch(/^Hi Carsten — someone asked to delete the StockPilot account for /);
  });

  it('with no first name, both parts say "Hi —"', () => {
    const res = renderAccountDeleteCodeEmail({ email: SEED.email, code: '000001', firstName: null });
    expect(res.html).toContain('Hi — someone asked');
    expect(res.text).toContain('Hi — someone asked');
  });

  it('escapes the address in the markup', () => {
    const res = renderAccountDeleteCodeEmail({ email: 'a<b>@example.test', code: '000001' });
    expect(res.html).not.toContain('a<b>@example.test');
    expect(res.html).toContain('a&lt;b&gt;@example.test');
  });
});

// ── sign-in alerts, part 3 (2026-11-21) ─────────────────────────────

import {
  renderSigninReportedEmail,
  renderSigninSignedOutEmail,
  SIGNIN_ALERT_NOT_ME_LABEL,
} from './security';

const NOT_ME_URL =
  'https://stockpilotusa.com/sign-in-alert?a=0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d&i=20261120&t=' +
  'x'.repeat(43);

describe('signin (part 3): the place, which kind it is, and "This was not me"', () => {
  const base = {
    email: 'member@example.test',
    device: 'Chrome on macOS',
    ip: SEED.ip,
    when: SEED.when,
    securityUrl: SEED.securityUrl,
    resetUrl: `${SEED.appUrl}/reset`,
    appUrl: SEED.appUrl,
  };

  it('a Location row when the place is known, said to be approximate, in both parts', () => {
    const res = renderSigninAlertEmail({ ...base, location: 'Tijuana, Mexico' });
    expect(res.html).toContain('>Location</div>');
    expect(res.html).toContain('Tijuana, Mexico (approximate)');
    expect(res.text).toContain('Location:    Tijuana, Mexico (approximate)');
    assertWeight(res);
  });

  it('no Location row when the place is not known', () => {
    for (const location of [undefined, null, '', '   ']) {
      const res = renderSigninAlertEmail({ ...base, location });
      expect(res.html).not.toContain('>Location</div>');
      expect(res.text).not.toContain('Location:');
    }
  });

  it('the preheader names the place next to the device, as the registry sample does', () => {
    const def = esEmailById('signin');
    const res = renderSigninAlertEmail({ ...base, location: 'Tijuana, Mexico' });
    expect(res.preheader).toBe(
      def.preheader({ summary: 'Chrome on macOS near Tijuana, Mexico', time: SEED.when }),
    );
  });

  it.each([
    [{ newDevice: true, newCountry: false }, 'from a device we haven’t seen before', 'New device'],
    [{ newDevice: false, newCountry: true }, 'from a country we haven’t seen on this account before', 'New country'],
    [
      { newDevice: true, newCountry: true },
      'from a device and a country we haven’t seen on this account before',
      'New device and new country',
    ],
  ])('says which kind of alert it is: %j', (kind, sentence, pill) => {
    const res = renderSigninAlertEmail({ ...base, kind });
    expect(res.text).toContain(`${base.email} was just signed in ${sentence}.`);
    expect(res.html).toContain(`Security &middot; ${pill}`);
    expect(res.text).toContain(`Why:         ${pill}`);
  });

  it('with the link: a primary "This was not me" button, and "Secure my account" kept beside it', () => {
    const res = renderSigninAlertEmail({ ...base, notMeUrl: NOT_ME_URL });
    expect(SIGNIN_ALERT_NOT_ME_LABEL).toBe('This was not me');
    expect(res.html).toContain('>This was not me &rarr;</a>');
    // In markup the query's & is written &amp; (the browser reads it back as &).
    expect(res.html).toContain(`href="${NOT_ME_URL.replace(/&/g, '&amp;')}"`);
    expect(res.html).toContain('>Secure my account</a>');
    expect(res.html).toContain('This button works for 7 days. It signs you out on every device.');
    expect(res.text).toContain(`This was not me (signs you out on every device): ${NOT_ME_URL}`);
    expect(res.text).toContain(`Secure my account: ${base.securityUrl}`);
    assertWeight(res);
  });

  it('without the link (its record could not be written): the old buttons, and no "This was not me"', () => {
    const res = renderSigninAlertEmail({ ...base, notMeUrl: null });
    expect(res.html).not.toContain('This was not me');
    expect(res.text).not.toContain('This was not me');
    expect(res.html).toContain('>Secure my account &rarr;</a>');
    expect(res.html).toContain('>Reset password</a>');
  });

  it('escapes a hostile place', () => {
    const res = renderSigninAlertEmail({ ...base, location: '<script>x</script>, Mexico' });
    expect(res.html).not.toContain('<script>x');
    expect(res.html).toContain('&lt;script&gt;x&lt;/script&gt;, Mexico');
  });
});

describe('signin-signed-out (renderSigninSignedOutEmail): the member, after "This was not me"', () => {
  const render = () =>
    renderSigninSignedOutEmail({
      email: 'member@example.test',
      firstName: 'Robin',
      device: 'StockPilot app on iPhone 15 Pro (iOS 18.1)',
      location: 'Tijuana, Mexico',
      when: 'Nov 20, 2026, 3:30 PM UTC',
      resetUrl: 'https://stockpilotusa.com/reset',
      appUrl: SEED.appUrl,
    });

  it('says every session ended and asks for a new password, with one button', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    assertEssentialFooter(res.html);
    expect(res.subject).toBe('We signed you out of StockPilot everywhere');
    expect(res.html).toContain('You are signed out on every device.');
    expect(res.html).toContain('Reset your password now.');
    expect(res.html).toContain('>Reset my password &rarr;</a>');
    expect(res.html).toContain('href="https://stockpilotusa.com/reset"');
    expect(res.html).toContain('StockPilot app on iPhone 15 Pro (iOS 18.1)');
    expect(res.html).toContain('Tijuana, Mexico (approximate)');
    expect(res.text).toContain('Reset my password: https://stockpilotusa.com/reset');
    expect(res.text).toContain('Anyone who knows your password can still sign in until you change it.');
  });

  it('subject and preheader are byte-equal to the registry', () => {
    const def = esEmailById('signin-signed-out');
    const res = render();
    expect(res.subject).toBe(def.subject({}));
    expect(res.preheader).toBe(def.preheader({}));
    expect(res.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(def.category).toBe('ess');
  });

  it('no place: no Location row', () => {
    const res = renderSigninSignedOutEmail({
      email: 'member@example.test',
      device: 'Chrome on macOS',
      location: null,
      when: 'Nov 20, 2026, 3:30 PM UTC',
      resetUrl: 'https://stockpilotusa.com/reset',
    });
    expect(res.html).not.toContain('>Location</div>');
    expect(res.html).toContain('Hi —');
  });
});

describe('signin-reported (renderSigninReportedEmail): owners and admins', () => {
  const render = (name = 'Robin Sample') =>
    renderSigninReportedEmail({
      adminEmail: 'admin@example.test',
      adminFirstName: 'Sam',
      memberName: name,
      memberEmail: 'member@example.test',
      organizationName: 'Sample Org',
      deviceFamily: 'StockPilot app on iPhone',
      location: 'Mexico',
      when: 'Nov 20, 2026, 3:30 PM UTC',
      listUrl: 'https://stockpilotusa.com/dashboard/settings/security/sign-ins',
      appUrl: SEED.appUrl,
    });

  it('names the member and the device family, and links to the list', () => {
    const res = render();
    assertNoLeakage(res);
    assertWeight(res);
    assertEssentialFooter(res.html);
    expect(res.subject).toBe('Robin Sample reported a sign-in they did not make');
    expect(res.html).toContain('StockPilot app on iPhone');
    expect(res.html).toContain('member@example.test');
    expect(res.html).toContain('Mexico (approximate)');
    expect(res.html).toContain('>Review sign-in alerts &rarr;</a>');
    expect(res.html).toContain('href="https://stockpilotusa.com/dashboard/settings/security/sign-ins"');
    expect(res.html).toContain('because you are an owner or admin of Sample Org');
    expect(res.text).toContain('Review sign-in alerts: https://stockpilotusa.com/dashboard/settings/security/sign-ins');
  });

  it('subject and preheader are byte-equal to the registry', () => {
    const def = esEmailById('signin-reported');
    const res = render();
    expect(res.subject).toBe(def.subject({ name: 'Robin Sample' }));
    expect(res.preheader).toBe(def.preheader({}));
    expect(res.from).toBe('StockPilot Security <security@stockpilotusa.com>');
  });

  it('escapes the member’s name in the markup and keeps the subject to one plain line', () => {
    const res = render('<b>Robin</b>\nSample');
    expect(res.html).not.toContain('<b>Robin');
    expect(res.html).toContain('&lt;b&gt;Robin&lt;/b&gt;');
    expect(res.subject).not.toContain('\n');
  });

  it('a very long name is cut in the subject', () => {
    const res = render('R'.repeat(200));
    expect(res.subject.length).toBeLessThan(120);
  });
});
