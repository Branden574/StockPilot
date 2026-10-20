import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GetStartedChecklist } from './get-started-checklist';

const dismissOnboardingAction = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('@/server/actions/onboarding', () => ({ dismissOnboardingAction }));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const baseSteps = [
  {
    id: 'warehouse',
    done: true,
    title: 'Confirm warehouse',
    description: 'Set your default location.',
    href: '/dashboard/settings/warehouses',
    cta: 'Confirm',
  },
  {
    id: 'invite',
    done: false,
    title: 'Invite team',
    description: 'Bring teammates aboard.',
    href: '/dashboard/settings/people',
    cta: 'Invite',
  },
  {
    id: 'first-item',
    done: false,
    title: 'Add first item',
    description: 'Stock something to track.',
    href: '/dashboard/inventory/new',
    cta: 'Add item',
  },
  {
    id: 'mfa',
    done: false,
    title: 'Set up MFA',
    description: 'Protect your account.',
    href: '/dashboard/settings/security',
    cta: 'Enable',
  },
];

describe('GetStartedChecklist', () => {
  it('shows the completed/total counter', () => {
    render(<GetStartedChecklist steps={baseSteps} />);
    expect(screen.getByText('1 / 4')).toBeInTheDocument();
  });

  it('renders the progress bar with width matching the percentage', () => {
    const { container } = render(<GetStartedChecklist steps={baseSteps} />);
    // 1 of 4 done -> 25%
    // Locator updated for the redesign (P3.1, look only): the fill is the
    // reference's accent progress bar now, found by its data-slot instead of
    // the old ink classes.
    const fill = container.querySelector('[data-slot="get-started-progress"]') as HTMLElement;
    expect(fill).not.toBeNull();
    expect(fill.style.width).toBe('25%');
  });

  it('renders done step titles with line-through styling', () => {
    render(<GetStartedChecklist steps={baseSteps} />);
    const doneTitle = screen.getByText('Confirm warehouse');
    expect(doneTitle).toHaveClass('line-through');
  });

  it('pending steps render their CTA link with the right href', () => {
    render(<GetStartedChecklist steps={baseSteps} />);
    const inviteLink = screen.getByRole('link', { name: /Invite/i });
    expect(inviteLink).toHaveAttribute('href', '/dashboard/settings/people');
    const addItemLink = screen.getByRole('link', { name: /Add item/i });
    expect(addItemLink).toHaveAttribute('href', '/dashboard/inventory/new');
  });

  it('renders 4 list items when given 4 steps', () => {
    render(<GetStartedChecklist steps={baseSteps} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
  });

  it('does not render a CTA link for done steps', () => {
    render(<GetStartedChecklist steps={baseSteps} />);
    expect(
      screen.queryByRole('link', { name: /Confirm/i }),
    ).not.toBeInTheDocument();
  });

  it('keeps the tour anchor: a section labelled by its h2#get-started-heading', () => {
    const { container } = render(<GetStartedChecklist steps={baseSteps} />);
    const section = container.querySelector('section[aria-labelledby="get-started-heading"]');
    expect(section).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Get started' })).toHaveAttribute(
      'id',
      'get-started-heading',
    );
    expect(screen.getByRole('region', { name: 'Get started' })).toBe(section);
  });

  it('dismiss hides the panel and records it across devices (mig 0257)', () => {
    render(<GetStartedChecklist steps={baseSteps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss getting started' }));
    expect(dismissOnboardingAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Get started')).toBeNull();
  });

  // HANDOFFS P3.1 (from P2.1): the "Or ask the AI" chips hovered in the accent
  // (hover:bg-accent/40); every hover in the redesign is the neutral fill.
  it('keeps the three AI prompt chips, hovering in the neutral fill', () => {
    render(<GetStartedChecklist steps={baseSteps} />);
    expect(screen.getByText(/Or ask the AI:/)).toBeInTheDocument();
    const chips = [
      'How do I receive a purchase order?',
      'Walk me through picking an order',
      'What does the Schedule do?',
    ].map((name) => screen.getByRole('link', { name }));
    for (const chip of chips) {
      expect(chip).toHaveClass('hover:bg-muted');
      expect(chip.className).not.toMatch(/bg-accent/);
      expect(chip.getAttribute('href')).toMatch(/^\/dashboard\/ai\?q=/);
    }
  });
});
