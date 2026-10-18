import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PoAccessDenied } from '@/components/po/po-access-denied';

import { AccessStateCard, ModuleNotEnabled } from './module-not-enabled';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * The three cards a page shows in place of its content when the person cannot
 * use it (W-SH-10, W-SH-16). The redesign changes their look only: each keeps
 * its own words, its one h1 (tours and the page title rule read `main h1`),
 * and its next step.
 */
describe('ModuleNotEnabled', () => {
  it('names the module, says it is off, and offers Settings to someone who can enable it', () => {
    render(<ModuleNotEnabled moduleId="rentals" canManage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 1, name: "Rentals isn't enabled" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This module isn't turned on for your organization."),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Enable in Settings → Modules' })).toHaveAttribute(
      'href',
      '/dashboard/settings/modules',
    );
    expect(screen.queryByText('Ask an owner or admin to enable it.')).toBeNull();
  });

  it('tells everyone else who can enable it, with no link', () => {
    render(<ModuleNotEnabled moduleId="rentals" canManage={false} />);
    expect(screen.getByText('Ask an owner or admin to enable it.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('PoAccessDenied', () => {
  it('keeps its words and its one h1', () => {
    render(<PoAccessDenied />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 1, name: "You don't have access to purchase orders" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Viewing purchase orders needs the “View purchase orders” permission, which isn't enabled for your account\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ask an owner or admin to enable it from Settings → Roles & permissions.'),
    ).toBeInTheDocument();
  });
});

describe('AccessStateCard', () => {
  // The same look P2.6's StatePanel draws for a page-sized state, so the
  // switch to it later changes nothing on screen.
  it('draws the quiet page card: hairline, radius 8, icon disc on the inset surface', () => {
    const { container } = render(
      <AccessStateCard title="Title" description="Why">
        <button type="button">Next step</button>
      </AccessStateCard>,
    );
    const card = within(container).getByRole('heading', { level: 1 }).parentElement!;
    for (const cls of ['rounded-lg', 'border', 'border-border', 'bg-card', 'max-w-2xl']) {
      expect(card.className.split(/\s+/), cls).toContain(cls);
    }
    const disc = card.firstElementChild!;
    expect(disc).toHaveAttribute('aria-hidden', 'true');
    expect(disc.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-sunk', 'rounded-full', 'size-11']),
    );
    expect(screen.getByRole('button', { name: 'Next step' })).toBeInTheDocument();
  });
});
