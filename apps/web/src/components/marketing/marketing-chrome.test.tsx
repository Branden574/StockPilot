import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The marketing chrome and the public support form after the redesign (P5.1):
 * the header is opaque (no glass or blur), the footer prints the brand once,
 * every link keeps its target, and the form keeps its required fields, its
 * off-screen honeypot and "Submit another".
 */

const createSupportTicketAction = vi.fn();
vi.mock('@/server/actions/support-tickets', () => ({
  createSupportTicketAction: (...a: unknown[]) => createSupportTicketAction(...a),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));

import { MarketingFooter } from './footer';
import { MarketingHeader } from './header';
import { SupportForm } from './support-form';

beforeEach(() => vi.clearAllMocks());

describe('MarketingHeader', () => {
  it('is opaque at every scroll position: no backdrop blur, no translucent fill', () => {
    const source = readFileSync(join(__dirname, 'header.tsx'), 'utf8');
    expect(source).not.toMatch(/backdrop-blur|color-mix\(|bg-background\/\d/);
    const { container } = render(<MarketingHeader />);
    const header = container.querySelector('header') as HTMLElement;
    expect(header.className).toMatch(/\bbg-background\b/);
    window.scrollY = 40;
    fireEvent.scroll(window);
    expect(header.className).toMatch(/\bborder-border\b/);
    expect(header.className).not.toMatch(/blur/);
  });

  it('keeps every link and both plain anchors into the app', () => {
    render(<MarketingHeader />);
    const hrefs = screen
      .getAllByRole('link')
      .map((a) => [a.textContent?.trim(), a.getAttribute('href')]);
    expect(hrefs).toEqual(
      expect.arrayContaining([
        ['Features', '/#product'],
        ['How it works', '/#how-it-works'],
        ['Compare', '/#compare'],
        ['Pricing', '/pricing'],
        ['Support', '/support'],
        ['Sign in', '/signin'],
        ['Open app', '/signin'],
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Toggle menu' }));
    expect(screen.getAllByRole('link', { name: 'Sign in' })).toHaveLength(2);
  });
});

describe('MarketingFooter', () => {
  it('prints the brand once (it printed "StockPilot StockPilot")', () => {
    render(<MarketingFooter />);
    const home = screen.getByRole('link', { name: 'Home' });
    expect(home.textContent?.match(/StockPilot/g)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'California privacy' })).toHaveAttribute(
      'href',
      '/privacy#california',
    );
  });
});

describe('SupportForm', () => {
  it('keeps required fields, the off-screen honeypot and Submit another (name and email stay)', async () => {
    createSupportTicketAction.mockResolvedValue({ ok: true, data: {} });
    render(<SupportForm />);
    expect(screen.getByLabelText(/^Email/)).toBeRequired();
    expect(screen.getByLabelText(/^Subject/)).toBeRequired();
    expect(screen.getByLabelText(/^Details/)).toBeRequired();
    const honeypot = document.getElementById('sup-company') as HTMLInputElement;
    expect(honeypot.tabIndex).toBe(-1);
    expect(honeypot.closest('[aria-hidden]')?.className).toMatch(/-left-\[9999px\]/);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'ada@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Subject/), { target: { value: 'Broken' } });
    fireEvent.change(screen.getByLabelText(/^Details/), {
      target: { value: 'It broke when I clicked.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send ticket' }));
    await waitFor(() => expect(screen.getByText('Ticket received')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Submit another' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Ada');
    expect(screen.getByLabelText(/^Email/)).toHaveValue('ada@example.test');
    expect(screen.getByLabelText(/^Subject/)).toHaveValue('');
    expect(screen.getByLabelText(/^Details/)).toHaveValue('');
  });
});
