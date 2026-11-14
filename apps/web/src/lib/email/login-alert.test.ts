import { beforeEach, describe, expect, it, vi } from 'vitest';

// Wire-level: the new-device alert must send the es signin template from
// the registry's security sender, and must NEVER reintroduce the old
// copy's false claim that sign-in alerts are a manageable preference.

const sendEmail = vi.fn();

vi.mock('./resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

import { sendNewDeviceLoginEmail } from './login-alert';

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

  it('the last email of 24 hours carries the sentence in both parts; others do not', async () => {
    await sendNewDeviceLoginEmail({
      to: 'owner@example.com',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/127.0',
      ip: '203.0.113.7',
      lastForADay: true,
    });
    const last = sendEmail.mock.calls[0]![0] as { html: string; text: string };
    expect(last.text).toContain('Further new-device sign-ins in the next 24 hours won’t send more emails');
    expect(last.html).toContain('Further new-device sign-ins in the next 24 hours won&rsquo;t send more emails');

    sendEmail.mockClear();
    await sendNewDeviceLoginEmail({
      to: 'owner@example.com',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/127.0',
      ip: '203.0.113.7',
    });
    const other = sendEmail.mock.calls[0]![0] as { html: string; text: string };
    expect(other.text).not.toContain('next 24 hours');
    expect(other.html).not.toContain('next 24 hours');
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
