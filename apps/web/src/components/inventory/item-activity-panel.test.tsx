import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

// B40: Load older set `loading`, awaited the action with no catch and cleared
// it only when it answered. A page that got no answer (offline, a server
// error, a deploy) left the button spinning and disabled for good, with no
// message, so the older history could not be reached without a reload.

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/activity', () => ({ loadOlderItemActivityAction: vi.fn() }));
// The feed is drawn by its own tests; here only the button and the message count.
vi.mock('@/components/inventory/activity-feed', () => ({ ActivityFeed: () => null }));

import { toast } from 'sonner';

import { loadOlderItemActivityAction } from '@/server/actions/activity';

import { ItemActivityPanel } from './item-activity-panel';

const CURSOR = {
  movement: { createdAt: '2026-10-01T12:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ItemActivityPanel when Load older gets no answer', () => {
  it('says the older activity could not be loaded, and Load older works again', async () => {
    vi.mocked(loadOlderItemActivityAction).mockRejectedValueOnce(offline());
    render(
      <ItemActivityPanel
        itemId="item-1"
        initialEvents={[]}
        initialLocationNames={{}}
        initialCursor={CURSOR}
        initialExhausted={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestFailedMessage('load older activity'),
    );
    expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('load older activity'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load older' })).toBeEnabled());
  });
});
