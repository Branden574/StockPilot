import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_MAP_POLL_FAILED } from '@stockpilot/core';

/**
 * The attack map's section (a server component). Security invariant.
 * Pinned: one read of the whole window, with no day start (only the browser
 * knows its midnight), handed to the island as its first values; a failed
 * read is handed over as a failed read (the island says "Could not check"),
 * never as an empty map; nothing else is read here.
 */

const h = vi.hoisted(() => ({
  read: vi.fn(),
  islandProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/server/services/platform/security-map', () => ({
  readPlatformSecurityMap: (...a: unknown[]) => h.read(...a),
}));
vi.mock('./security-map/security-map-island', () => ({
  SecurityMapIsland: (props: Record<string, unknown>) => {
    h.islandProps.push(props);
    return <div data-testid="island" />;
  },
}));

import { PlatformSecurityMapSection } from './platform-security-map-section';

const VIEW = { ok: true, view: { v: 1 }, refusedWindow: null };

beforeEach(() => {
  h.read.mockReset();
  h.islandProps = [];
});

describe('the attack map section', () => {
  it('reads the whole window once, with no day start, and hands that read to the island', async () => {
    h.read.mockResolvedValue(VIEW);
    render(await PlatformSecurityMapSection());
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith({ scope: 'whole', dayStart: null });
    expect(h.islandProps).toEqual([{ initial: VIEW }]);
    expect(screen.getByRole('region', { name: 'Attack map' })).toContainElement(
      screen.getByTestId('island'),
    );
  });

  it('a failed read is handed over as a failed read, not as an empty map', async () => {
    h.read.mockResolvedValue(SECURITY_MAP_POLL_FAILED);
    render(await PlatformSecurityMapSection());
    expect(h.islandProps[0]!.initial).toBe(SECURITY_MAP_POLL_FAILED);
  });
});
