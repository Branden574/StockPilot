import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wire-level: the new-device alert must send the es signin template from
// the registry's security sender, and must NEVER reintroduce the old
// copy's false claim that sign-in alerts are a manageable preference.

const sendEmail = vi.fn();

vi.mock('./resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

import {
  RATE_REFUSAL_WAIT_MS,
  sendNewDeviceLoginEmail,
  sendSignedOutEverywhereEmail,
  sendSignInReportedEmail,
} from './login-alert';

describe('sendNewDeviceLoginEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
  });

  it('sends the es signin alert from the registry security sender', async () => {
    await sendNewDeviceLoginEmail({
      to: 'owner@example.com',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ip: '203.0.113.7',
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
      from?: string;
      replyTo?: string;
    };
    expect(msg.to).toBe('owner@example.com');
    expect(msg.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(msg.replyTo).toBeUndefined();
    expect(msg.subject).toBe('New sign-in to your StockPilot account');
    expect(msg.html).toContain('Chrome on macOS');
    expect(msg.html).toContain('203.0.113.7');
    expect(msg.html).toContain('/dashboard/settings/security');
  });

  it('the email that reaches the count carries the sentence in both parts; others do not', async () => {
    await sendNewDeviceLoginEmail({
      to: 'owner@example.com',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/127.0',
      ip: '203.0.113.7',
      lastForADay: true,
    });
    const last = sendEmail.mock.calls[0]![0] as { html: string; text: string };
    expect(last.text).toContain('Further new-device sign-ins won’t send more emails for up to 24 hours');
    expect(last.html).toContain('Further new-device sign-ins won&rsquo;t send more emails for up to 24 hours');

    sendEmail.mockClear();
    await sendNewDeviceLoginEmail({
      to: 'owner@example.com',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/127.0',
      ip: '203.0.113.7',
    });
    const other = sendEmail.mock.calls[0]![0] as { html: string; text: string };
    expect(other.text).not.toContain('up to 24 hours');
    expect(other.html).not.toContain('up to 24 hours');
  });

  it('never claims the alert is a manageable preference (registry flag)', async () => {
    await sendNewDeviceLoginEmail({
      to: 'owner@example.com',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/127.0',
      ip: null,
    });

    const msg = sendEmail.mock.calls[0]![0] as { html: string; text: string };
    for (const surface of [msg.html, msg.text]) {
      expect(surface).not.toContain('alerts are on for your account');
      expect(surface).not.toMatch(/notification preferences/i);
      expect(surface).not.toMatch(/only the first time we see a new device/i);
    }
    expect(msg.html).toContain('a core account-safety notice');
  });

  // S5: the phone's agent ('StockPilot/<build> CFNetwork/... Darwin/...') has
  // no case in friendlyDevice, so the email named a phone sign-in by its raw
  // agent. The phone's sign-in route names the device itself.
  it('a device label replaces the guess from the agent, and is escaped', async () => {
    await sendNewDeviceLoginEmail({
      to: 'owner@example.com',
      userAgent: 'StockPilot/42 CFNetwork/1568.100.1 Darwin/24.0.0',
      ip: '203.0.113.7',
      deviceLabel: 'StockPilot app on iPhone 15 Pro (iOS 18.1)',
    });
    const msg = sendEmail.mock.calls[0]![0] as { html: string; text: string };
    expect(msg.html).toContain('StockPilot app on iPhone 15 Pro (iOS 18.1)');
    expect(msg.text).toContain('StockPilot app on iPhone 15 Pro (iOS 18.1)');
    expect(msg.html).not.toContain('CFNetwork');

    sendEmail.mockClear();
    await sendNewDeviceLoginEmail({
      to: 'owner@example.com',
      userAgent: 'StockPilot/42 CFNetwork/1568.100.1 Darwin/24.0.0',
      ip: null,
      deviceLabel: 'StockPilot app on <img src=x onerror=alert(1)>',
    });
    const hostile = sendEmail.mock.calls[0]![0] as { html: string };
    expect(hostile.html).not.toContain('<img src=x');
    expect(hostile.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('no label: the guess from the agent, as before', async () => {
    await sendNewDeviceLoginEmail({
      to: 'owner@example.com',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      ip: null,
      deviceLabel: null,
    });
    const msg = sendEmail.mock.calls[0]![0] as { html: string };
    expect(msg.html).toContain('Safari on iPhone');
  });
});

describe('sendNewDeviceLoginEmail (part 3): the place, the kind and the link reach the email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
  });

  it('a new country with a city: the Location row names the country in English, and the kind is said', async () => {
    await sendNewDeviceLoginEmail({
      to: 'member@example.test',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/127.0',
      ip: null,
      place: { country: 'MX', city: 'Tijuana' },
      newDevice: false,
      newCountry: true,
      notMeUrl: 'https://app.example.test/sign-in-alert?a=0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d&i=20261120&t=x',
    });
    const msg = sendEmail.mock.calls[0]![0] as { html: string; text: string };
    expect(msg.text).toContain('Location:    Tijuana, Mexico (approximate)');
    expect(msg.text).toContain('from a country we haven’t seen on this account before');
    expect(msg.html).toContain('>This was not me &rarr;</a>');
    expect(msg.text).toContain(
      'This was not me (ends every session of your account): https://app.example.test/sign-in-alert?a=0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d&i=20261120&t=x',
    );
  });

  it('the country alone when there is no city; no Location row when there is no country', async () => {
    await sendNewDeviceLoginEmail({
      to: 'member@example.test',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/127.0',
      ip: null,
      place: { country: 'BR', city: null },
    });
    expect((sendEmail.mock.calls[0]![0] as { text: string }).text).toContain(
      'Location:    Brazil (approximate)',
    );
    sendEmail.mockClear();
    await sendNewDeviceLoginEmail({
      to: 'member@example.test',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/127.0',
      ip: null,
      place: { country: null, city: null },
      notMeUrl: null,
    });
    const msg = sendEmail.mock.calls[0]![0] as { html: string; text: string };
    expect(msg.text).not.toContain('Location:');
    expect(msg.html).not.toContain('This was not me');
  });
});

describe('sendSignedOutEverywhereEmail (part 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
  });

  it('the member is told every session ended, with the reset button; the answer of the send is handed back', async () => {
    const result = await sendSignedOutEverywhereEmail({
      to: 'member@example.test',
      firstName: 'Avery',
      device: 'Firefox on Windows',
      place: { country: 'MX', city: 'Tijuana' },
      signedInAt: new Date('2026-11-20T15:30:00Z'),
      appUrl: 'https://app.example.test',
    });
    expect(result).toEqual({ ok: true, id: 'test' });
    const msg = sendEmail.mock.calls[0]![0] as { to: string; subject: string; html: string; text: string; from?: string };
    expect(msg.to).toBe('member@example.test');
    expect(msg.subject).toBe('We ended every session of your StockPilot account');
    // Nobody was said to be told, so the email does not say so.
    expect(msg.text).not.toMatch(/owners and admins/);
    expect(msg.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(msg.html).toContain('https://app.example.test/reset');
    expect(msg.text).toContain('Tijuana, Mexico');
    expect(msg.text).toContain('Nov 20, 2026');
    expect(msg.text).toContain('Firefox on Windows');
  });
});

describe('sendSignedOutEverywhereEmail: the owners and admins were told, only when they were (finding 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
  });

  it('adminsTold reaches the email', async () => {
    await sendSignedOutEverywhereEmail({
      to: 'member@example.test',
      device: 'Firefox on Windows',
      place: null,
      signedInAt: new Date('2026-11-20T15:30:00Z'),
      adminsTold: true,
    });
    const msg = sendEmail.mock.calls[0]![0] as { html: string; text: string };
    expect(msg.text).toContain('The owners and admins of your organization were told, so they can help.');
    expect(msg.html).toContain('The owners and admins of your organization were told, so they can help.');
  });
});

describe('a refusal for rate is tried once more after a short wait (finding 3)', () => {
  const send = () =>
    sendSignInReportedEmail({
      to: 'admin@example.test',
      memberName: 'Avery Example',
      memberEmail: 'member@example.test',
      organizationName: 'Example School',
      deviceFamily: 'Chrome on macOS',
      place: null,
      signedInAt: new Date('2026-11-20T15:30:00Z'),
      appUrl: 'https://app.example.test',
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a 429, then sent: one more try, after the wait and not before', async () => {
    sendEmail
      .mockResolvedValueOnce({ ok: false, status: 429, error: 'rate_limit_exceeded' })
      .mockResolvedValueOnce({ ok: true, id: 'second-try' });
    const pending = send();
    await vi.advanceTimersByTimeAsync(RATE_REFUSAL_WAIT_MS - 1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true, id: 'second-try' });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    // The same message both times.
    expect(sendEmail.mock.calls[1]![0]).toEqual(sendEmail.mock.calls[0]![0]);
  });

  it('refused for rate twice: not sent, and no third try', async () => {
    sendEmail.mockResolvedValue({ ok: false, status: 429, error: 'rate_limit_exceeded' });
    const pending = send();
    await vi.advanceTimersByTimeAsync(RATE_REFUSAL_WAIT_MS * 5);
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('any other refusal is not tried again', async () => {
    sendEmail.mockResolvedValue({ ok: false, status: 422, error: 'invalid' });
    const pending = send();
    await vi.advanceTimersByTimeAsync(RATE_REFUSAL_WAIT_MS * 5);
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('the member’s email is tried again the same way', async () => {
    sendEmail
      .mockResolvedValueOnce({ ok: false, status: 429, error: 'rate_limit_exceeded' })
      .mockResolvedValueOnce({ ok: true, id: 'second-try' });
    const pending = sendSignedOutEverywhereEmail({
      to: 'member@example.test',
      device: 'Firefox on Windows',
      place: null,
      signedInAt: new Date('2026-11-20T15:30:00Z'),
    });
    await vi.advanceTimersByTimeAsync(RATE_REFUSAL_WAIT_MS);
    await expect(pending).resolves.toEqual({ ok: true, id: 'second-try' });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('the wait is short: a second or two', () => {
    expect(RATE_REFUSAL_WAIT_MS).toBeGreaterThanOrEqual(1000);
    expect(RATE_REFUSAL_WAIT_MS).toBeLessThanOrEqual(2000);
  });
});

describe('sendSignInReportedEmail (part 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
  });

  it('an owner or admin is told who, the device family, where and when, with a link to the list', async () => {
    await sendSignInReportedEmail({
      to: 'admin@example.test',
      adminFirstName: 'Jordan',
      memberName: 'Avery Example',
      memberEmail: 'member@example.test',
      organizationName: 'Example School',
      deviceFamily: 'Chrome on macOS',
      place: { country: 'MX', city: null },
      signedInAt: new Date('2026-11-20T15:30:00Z'),
      appUrl: 'https://app.example.test',
    });
    const msg = sendEmail.mock.calls[0]![0] as { to: string; subject: string; html: string; text: string };
    expect(msg.to).toBe('admin@example.test');
    expect(msg.subject).toBe('A member reported a sign-in they did not make');
    expect(msg.text).toContain('Avery Example (member@example.test)');
    expect(msg.text).toContain('Chrome on macOS');
    expect(msg.text).toContain('Mexico');
    expect(msg.text).toContain('Example School');
    expect(msg.html).toContain('https://app.example.test/dashboard/settings/security/sign-ins');
  });

  it('a send that throws is answered as not sent, never thrown', async () => {
    sendEmail.mockRejectedValue(new Error('network'));
    await expect(
      sendSignInReportedEmail({
        to: 'admin@example.test',
        memberName: 'Avery Example',
        memberEmail: 'member@example.test',
        organizationName: 'Example School',
        deviceFamily: 'Chrome on macOS',
        place: null,
        signedInAt: new Date('2026-11-20T15:30:00Z'),
        appUrl: 'https://app.example.test',
      }),
    ).resolves.toEqual({ ok: false, error: 'send_threw' });
  });
});
