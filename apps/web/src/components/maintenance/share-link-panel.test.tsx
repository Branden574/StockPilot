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
type IssueResult = ({ ok: true } & { url: string; expiresAt: string }) | { error: { message: string } };
const revoke = vi.fn(async (..._args: unknown[]): Promise<ActionResult> => ({ ok: true }));
const issue = vi.fn(async (..._args: unknown[]): Promise<IssueResult> => ({
  ok: true,
  url: GENERATED_URL,
  expiresAt: '2027-02-01T00:00:00.000Z',
}));
vi.mock('@/server/actions/maintenance-requests', () => ({
  revokeMaintenanceShareLinkAction: (...args: unknown[]) => revoke(...args),
  issueMaintenanceShareLinkAction: (...args: unknown[]) => issue(...args),
}));

import { ShareLinkPanel } from './share-link-panel';

// A distinctive fake token — real tokens are 64 lowercase hex chars
// (maintenance-share-links.ts mintToken()); this fixture only needs to be
// unique enough that a stray match would be unambiguous.
const TOKEN = 'deadbeefcafe1234deadbeefcafe1234deadbeefcafe1234deadbeefcafe12';
const GENERATED_URL = `https://stockpilotusa.com/m/${TOKEN}`;
const STATUS = { expiresAt: '2027-01-31T00:00:00.000Z' };

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

// Match page.test.tsx's own "StockPilot activity timeline honesty sweep"
// word list exactly (fix wave Important 3 — Task 14's lesson carried
// forward). Radix's Dialog unmounts its content entirely while `open` is
// false, so a sweep run before ever opening the Revoke dialog can never see
// this copy — the new tests below open it FIRST.
const FORBIDDEN = [
  'Ticket created',
  'Request submitted to Zendesk',
  'DC4 notified',
  'Andrew notified',
  'Ticket assigned',
  'Email sent',
  'Zendesk comment',
];

describe('ShareLinkPanel (mig 0330 — show-once)', () => {
  it('no active link: shows the empty state, a "Generate link" button, and no Copy/Revoke controls', () => {
    render(<ShareLinkPanel requestId="r1" status={null} canRevoke={true} />);
    expect(screen.getByText(/No active share link/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate link' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy URL/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('SECURITY PROPERTY — an existing active link (server status) renders NO URL, NO Copy button, and explains the URL cannot be shown again; the affordance is "Generate new link"', () => {
    render(<ShareLinkPanel requestId="r1" status={STATUS} canRevoke={true} />);
    expect(screen.getByText(/cannot be shown again/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy URL/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate new link' })).toBeInTheDocument();
    // No token/URL material anywhere — the server literally cannot supply it.
    expect(document.body.innerHTML).not.toContain('/m/');
  });

  it('Generate mints via the issue action and then offers Copy for the freshly-returned URL — the show-once moment', async () => {
    render(<ShareLinkPanel requestId="r1" status={null} canRevoke={true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate link' }));
    expect(issue).toHaveBeenCalledWith('r1');
    expect(await screen.findByText(/copy it now/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Copy URL/ }));
    expect(vi.mocked(navigator.clipboard.writeText)).toHaveBeenCalledWith(GENERATED_URL);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('never renders the raw token as visible page text, even right after generating — only the Copy affordance can reach it', async () => {
    render(<ShareLinkPanel requestId="r1" status={null} canRevoke={true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate link' }));
    await screen.findByText(/copy it now/i);
    // The token must not appear as literal text anywhere in the rendered
    // output (no href-as-text, no title, no data attribute, no plain <a>
    // whose visible label is the URL).
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('discloses the ~180-day photo-access grant and that the link is revocable', () => {
    render(<ShareLinkPanel requestId="r1" status={STATUS} canRevoke={true} />);
    expect(screen.getByText(/180 days/)).toBeInTheDocument();
    expect(screen.getByText(/Revocable at/)).toBeInTheDocument();
  });

  it('a failed generate surfaces via toast and never shows a Copy affordance', async () => {
    issue.mockResolvedValueOnce({ error: { message: 'Missing permission: maintenance_requests:manage' } });
    render(<ShareLinkPanel requestId="r1" status={null} canRevoke={true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate link' }));
    expect(toastError).toHaveBeenCalledWith('Missing permission: maintenance_requests:manage');
    expect(screen.queryByRole('button', { name: /Copy URL/ })).not.toBeInTheDocument();
  });

  it('Revoke opens a confirm dialog, then calls the revoke action and refreshes on success', async () => {
    render(<ShareLinkPanel requestId="r1" status={STATUS} canRevoke={true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByText('Revoke this share link?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(revoke).toHaveBeenCalledWith('r1');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('revoking right after generating drops the fresh URL — a dead link is never left copyable', async () => {
    render(<ShareLinkPanel requestId="r1" status={null} canRevoke={true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate link' }));
    await screen.findByText(/copy it now/i);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(screen.queryByRole('button', { name: /Copy URL/ })).not.toBeInTheDocument();
  });

  it('surfaces a failed revoke via toast without refreshing', async () => {
    revoke.mockResolvedValueOnce({ error: { message: 'No active share link found for this request.' } });
    render(<ShareLinkPanel requestId="r1" status={STATUS} canRevoke={true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(toastError).toHaveBeenCalledWith('No active share link found for this request.');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('the OPEN Revoke confirm dialog never contains forbidden ticket/notification vocabulary (fix wave Important 3 — Task 14 lesson carried forward: a portalled dialog hides copy from a pre-open sweep)', async () => {
    render(<ShareLinkPanel requestId="r1" status={STATUS} canRevoke={true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByText('Revoke this share link?')).toBeInTheDocument();
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  describe('canRevoke={false} — the owning-requester tier (fix wave Important 2)', () => {
    it('renders Generate but never a Revoke button, even with an active link', () => {
      render(<ShareLinkPanel requestId="r1" status={STATUS} canRevoke={false} />);
      expect(screen.getByRole('button', { name: 'Generate new link' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    });

    it('MUTATION GUARD — never mounts the revoke confirm dialog markup at all, so it cannot be coaxed open by any means', () => {
      render(<ShareLinkPanel requestId="r1" status={STATUS} canRevoke={false} />);
      expect(screen.queryByText('Revoke this share link?')).not.toBeInTheDocument();
    });

    it('Generate + Copy still work normally in this tier', async () => {
      render(<ShareLinkPanel requestId="r1" status={null} canRevoke={false} />);
      await userEvent.click(screen.getByRole('button', { name: 'Generate link' }));
      await userEvent.click(await screen.findByRole('button', { name: /Copy URL/ }));
      expect(vi.mocked(navigator.clipboard.writeText)).toHaveBeenCalledWith(GENERATED_URL);
    });
  });
});
