// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Check now" (F1-1, owner decision Q9) schedules a check and returns at once.
 * The button says what happened inline, and never reloads the page itself.
 */

const requestExceptionCheckAction = vi.fn();
vi.mock('@/server/actions/exceptions', () => ({
  requestExceptionCheckAction: () => requestExceptionCheckAction(),
}));

import { CheckNowButton } from './check-now-button';

beforeEach(() => vi.clearAllMocks());

async function press() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Check now/ }));
  });
}

describe('CheckNowButton', () => {
  it('says the check started', async () => {
    requestExceptionCheckAction.mockResolvedValue({ ok: true, scheduled: true, retryAfterSeconds: 0, lastSyncedAt: null });
    render(<CheckNowButton />);
    await press();
    expect(screen.getByRole('status')).toHaveTextContent('Check started. Reload the page in a minute to see the result.');
  });

  it('says when the last check was under a minute ago', async () => {
    requestExceptionCheckAction.mockResolvedValue({ ok: true, scheduled: false, retryAfterSeconds: 37, lastSyncedAt: 'x' });
    render(<CheckNowButton />);
    await press();
    expect(screen.getByRole('status')).toHaveTextContent('You can check again in 37 seconds.');
  });

  it('shows a refusal inline as an alert', async () => {
    requestExceptionCheckAction.mockResolvedValue({ error: { message: 'Only a manager can run a check now.', reason: null } });
    render(<CheckNowButton />);
    await press();
    expect(screen.getByRole('alert')).toHaveTextContent('Only a manager can run a check now.');
  });
});
