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
      to: 'branden574@gmail.com',
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
    expect(msg.to).toBe('branden574@gmail.com');
    expect(msg.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    expect(msg.replyTo).toBeUndefined();
    expect(msg.subject).toBe('New sign-in to your StockPilot account');
    expect(msg.html).toContain('Chrome on macOS');
    expect(msg.html).toContain('203.0.113.7');
    expect(msg.html).toContain('/dashboard/settings/security');
  });

  it('never claims the alert is a manageable preference (registry flag)', async () => {
    await sendNewDeviceLoginEmail({
      to: 'branden574@gmail.com',
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
});
