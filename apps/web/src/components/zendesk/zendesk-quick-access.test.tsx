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
    const field = input.parentElement!;
    expect(field).toHaveClass('focus-within:ring-2', 'focus-within:ring-ring');
    fireEvent.change(input, { target: { value: 'learn4life' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(h.save).toHaveBeenCalledWith({ subdomain: 'learn4life' }));
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
