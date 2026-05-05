import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GetStartedChecklist } from './get-started-checklist';

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
    const fill = container.querySelector('.bg-foreground.h-full') as HTMLElement;
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
});
