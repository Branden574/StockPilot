import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_ALERTS_FAILED } from '@stockpilot/core';

/**
 * The security alerts' section (a server component). Security invariant.
 * Pinned: one read of the alerts, with nothing handed in, handed to the
 * client as its first values; a failed read is handed over as a failed read
 * (the client says "could not be checked"), never as an empty list; nothing
 * else is read here but the zone the viewer chose, handed beside it.
 */

const h = vi.hoisted(() => ({
  read: vi.fn(),
  clientProps: [] as Array<Record<string, unknown>>,
  zone: null as string | null,
}));

vi.mock('@/lib/platform/viewer-time-zone', () => ({
  readPlatformViewerTimeZone: async () => h.zone,
}));
vi.mock('@/server/services/platform/security-alerts', () => ({
  readPlatformSecurityAlerts: (...a: unknown[]) => h.read(...a),
}));
vi.mock('./security-alerts/security-alerts-client', () => ({
  SecurityAlertsClient: (props: Record<string, unknown>) => {
    h.clientProps.push(props);
    return <div data-testid="client" />;
  },
}));

import { PlatformSecurityAlertsSection } from './platform-security-alerts-section';

const VIEW = { ok: true, view: { v: 1 } };

beforeEach(() => {
  h.read.mockReset();
  h.clientProps = [];
  h.zone = null;
});

describe('the security alerts section', () => {
  it('reads the alerts once, with nothing handed in, and hands that read to the client', async () => {
    h.read.mockResolvedValue(VIEW);
    render(await PlatformSecurityAlertsSection());
    expect(h.read.mock.calls).toEqual([[]]);
    expect(h.clientProps).toEqual([{ initial: VIEW, timeZone: null }]);
    expect(screen.getByRole('region', { name: 'Security alerts' })).toContainElement(
      screen.getByTestId('client'),
    );
  });

  it('the zone the viewer chose is handed to the client', async () => {
    h.read.mockResolvedValue(VIEW);
    h.zone = 'America/Los_Angeles';
    render(await PlatformSecurityAlertsSection());
    expect(h.clientProps).toEqual([{ initial: VIEW, timeZone: 'America/Los_Angeles' }]);
  });

  it('a failed read is handed over as a failed read, not as an empty list', async () => {
    h.read.mockResolvedValue(SECURITY_ALERTS_FAILED);
    render(await PlatformSecurityAlertsSection());
    expect(h.clientProps[0]!.initial).toBe(SECURITY_ALERTS_FAILED);
  });
});
