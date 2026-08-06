import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock, back: vi.fn() }),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}));

type ActionResult = { ok: true } | { error: { message: string } };
const revoke = vi.fn(async (..._args: unknown[]): Promise<ActionResult> => ({ ok: true }));
vi.mock('@/server/actions/maintenance-requests', () => ({
  revokeMaintenanceShareLinkAction: (...args: unknown[]) => revoke(...args),
}));

import { ShareLinkPanel } from './share-link-panel';

// A distinctive fake token — real tokens are 64 lowercase hex chars
// (maintenance-share-links.ts mintToken()); this fixture only needs to be
// unique enough that a stray match would be unambiguous.
const TOKEN = 'deadbeefcafe1234deadbeefcafe1234deadbeefcafe1234deadbeefcafe12';
const LINK = { url: `https://stockpilotusa.com/m/${TOKEN}`, expiresAt: '2027-01-31T00:00:00.000Z' };

let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // Manual writeText stub — deliberately using the static `userEvent.click`
  // API below (not `userEvent.setup()`), which installs its own clipboard
  // emulation that clobbers a hand-defined `navigator.clipboard` before this
  // stub is ever exercised. Same idiom as maintenance-email-action.test.tsx.
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
});

describe('ShareLinkPanel', () => {
  it('shows the empty state and no Copy/Revoke controls when there is no active link', () => {
    render(<ShareLinkPanel requestId="r1" link={null} />);
    expect(screen.getByText(/No active share link/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy URL/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('never renders the raw token as visible page text — only the Copy affordance can reach it', () => {
    render(<ShareLinkPanel requestId="r1" link={LINK} />);
    // The token must not appear as literal text anywhere in the rendered
    // output (no href-as-text, no title, no data attribute, no plain <a>
    // whose visible label is the URL).
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('discloses the ~180-day photo-access grant and that the link is revocable', () => {
    render(<ShareLinkPanel requestId="r1" link={LINK} />);
    expect(screen.getByText(/180 days/)).toBeInTheDocument();
    expect(screen.getByText(/Revocable at any time/)).toBeInTheDocument();
  });

  it('Copy URL copies the exact link to the clipboard, never rendering it into the DOM', async () => {
    render(<ShareLinkPanel requestId="r1" link={LINK} />);
    await userEvent.click(screen.getByRole('button', { name: /Copy URL/ }));
    expect(vi.mocked(navigator.clipboard.writeText)).toHaveBeenCalledWith(LINK.url);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('Revoke opens a confirm dialog, then calls the revoke action and refreshes on success', async () => {
    render(<ShareLinkPanel requestId="r1" link={LINK} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByText('Revoke this share link?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(revoke).toHaveBeenCalledWith('r1');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('surfaces a failed revoke via toast without refreshing', async () => {
    revoke.mockResolvedValueOnce({ error: { message: 'No active share link found for this request.' } });
    render(<ShareLinkPanel requestId="r1" link={LINK} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(toastError).toHaveBeenCalledWith('No active share link found for this request.');
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
