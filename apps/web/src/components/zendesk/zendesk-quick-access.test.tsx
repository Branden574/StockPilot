// "Open your Zendesk" in the redesign (P4.F2, row W-WS-14): the launch link
// still opens the agent URL in a new tab, and the subdomain field, whose
// input draws no outline of its own, shows the focus ring on the whole field
// (it had no visible focus before). Enter still saves.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/zendesk', () => ({ setZendeskSubdomainAction: h.save }));

import { ZendeskQuickAccess } from './zendesk-quick-access';

beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue({ ok: true, data: null });
});

describe('ZendeskQuickAccess', () => {
  it('opens the real agent interface in a new tab', () => {
    render(<ZendeskQuickAccess subdomain="acme" canManage={false} />);
    const link = screen.getByRole('link', { name: /Open my Zendesk/ });
    expect(link).toHaveAttribute('href', 'https://acme.zendesk.com/agent');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('the subdomain field shows a focus ring around the field and Enter saves', async () => {
    render(<ZendeskQuickAccess subdomain={null} canManage />);
    expect(screen.getByText(/No Zendesk subdomain set yet — add it below\./)).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: /Your Zendesk subdomain/ });
    // Every organization sees this example, so it names no customer's Zendesk.
    expect(input).toHaveAttribute('placeholder', 'yourcompany');
    const field = input.parentElement!;
    expect(field).toHaveClass('focus-within:ring-2', 'focus-within:ring-ring');
    fireEvent.change(input, { target: { value: 'sampleorg' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(h.save).toHaveBeenCalledWith({ subdomain: 'sampleorg' }));
  });

  // docket S27: the stored subdomain is written by the app's checked path,
  // which takes one DNS label only (connections.ts), but the link is built
  // from whatever the row holds. A value that is not one label opens no link
  // and reads as not set, for every member who sees this page.
  it.each([
    'other.example/x?',
    'acme.zendesk.com@other.example',
    'acme/agent#',
    'acme.other',
    '-acme',
    ' acme',
    'a'.repeat(64),
  ])('builds no link from a stored subdomain that is not one DNS label (%s)', (stored) => {
    render(<ZendeskQuickAccess subdomain={stored} canManage={false} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('zendesk.com/agent');
    expect(
      screen.getByText(/No Zendesk subdomain set yet\. Ask an admin to set it\./),
    ).toBeInTheDocument();
  });

  it('a manager sees such a value as not set, with an empty field to set it', async () => {
    render(<ZendeskQuickAccess subdomain="other.example/x?" canManage />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/No Zendesk subdomain set yet — add it below\./)).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: /Your Zendesk subdomain/ });
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: 'sampleorg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.save).toHaveBeenCalledWith({ subdomain: 'sampleorg' }));
  });

  it('still links a 63-character label and a label with inner hyphens', () => {
    const { unmount } = render(<ZendeskQuickAccess subdomain={'a'.repeat(63)} canManage={false} />);
    expect(screen.getByRole('link', { name: /Open my Zendesk/ })).toHaveAttribute(
      'href',
      `https://${'a'.repeat(63)}.zendesk.com/agent`,
    );
    unmount();
    render(<ZendeskQuickAccess subdomain="sample-org-2" canManage={false} />);
    expect(screen.getByRole('link', { name: /Open my Zendesk/ })).toHaveAttribute(
      'href',
      'https://sample-org-2.zendesk.com/agent',
    );
  });

  // DESIGN-SPEC 2.4 item 3: a form control is never edged by the hairline
  // alone. The field drew --border (1.13:1 against the dark card), where the
  // shared Input draws the stronger --ed-line-strong (1.30:1).
  it('edges the subdomain field with the control border the shared Input uses', () => {
    render(<ZendeskQuickAccess subdomain="acme" canManage />);
    const field = screen.getByRole('textbox', { name: /Your Zendesk subdomain/ }).parentElement!;
    expect(field).toHaveClass('border', 'border-line-strong');
    expect(field).not.toHaveClass('border-input');
  });
});
