import { describe, expect, it } from 'vitest';

import { esEmailById } from '../registry';
import { ES_MAX_HTML_BYTES } from '../tokens';
import { renderPasswordResetEmail, renderSigninAlertEmail } from './security';

import type { RenderedEsEmail } from './security';

// Registry sample world (ES.W) adapted to real merge params.
const SEED = {
  email: 'branden574@gmail.com',
  firstName: 'Branden',
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
    expect(res.html).toContain('Hi Branden —');
    expect(res.html).toContain('branden574@gmail.com');
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

  it('embeds the pulse hero with reserved dimensions and alt text', () => {
    const res = render();
    expect(res.html).toContain('https://stockpilotusa.com/email/motion/pulse@2x.gif');
    expect(res.html).toContain('width="528" height="194"');
    expect(res.html).toMatch(/alt="[^"]*new device signed in[^"]*"/);
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
