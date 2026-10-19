import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DemoScenarios } from './demo-scenarios';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

/** The Demo Co scenario card keeps its name, words and five guided links. */
describe('DemoScenarios', () => {
  it('keeps the labelled section, its heading and the five ?tour= links', () => {
    render(<DemoScenarios />);
    expect(screen.getByRole('region', { name: 'Demo scenarios' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Explore the demo' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'This workspace is sample data — try anything, break nothing. Five guided scenarios:',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard/inventory/new?tour=new-item-form',
      '/dashboard/purchase-orders/imports?tour=po-imports',
      '/dashboard/orders/new?tour=order-create',
      '/dashboard/settings?tour=settings-hub',
      '/dashboard/ai?tour=ai-assistant',
    ]);
    expect(screen.getByRole('link', { name: /Fulfill an order/ })).toHaveTextContent(
      'Start an order →',
    );
  });
});
