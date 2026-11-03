import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrderFulfilmentBadge } from './order-fulfilment-badge';

/**
 * The order's fulfilment beside its status in the page head, as
 * Order-Detail.dc.html draws it (an outline badge: a truck and "Delivery").
 * Glass-only words and an icon (no link, button or field): rendered only when
 * the build offers Liquid Glass, hidden in Classic by visibility.css, and not
 * rendered at all under the `off` rollout.
 */
afterEach(() => vi.unstubAllEnvs());

describe('OrderFulfilmentBadge', () => {
  it('renders nothing at all under the off rollout (and with the flag unset)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    expect(render(<OrderFulfilmentBadge fulfillmentType="delivery" />).container.innerHTML).toBe(
      '',
    );
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    expect(render(<OrderFulfilmentBadge fulfillmentType="pickup" />).container.innerHTML).toBe('');
  });

  for (const rollout of ['opt-in', 'default'] as const) {
    it(`under ${rollout}: one glass-only badge with the word and a decorative icon`, () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const { container } = render(<OrderFulfilmentBadge fulfillmentType="delivery" />);
      const badge = container.firstElementChild!;
      // A div: it sits between the title and the status aside span in the
      // head's row, so it takes no Classic element's *-of-type place.
      expect(badge.tagName).toBe('DIV');
      expect(badge).toHaveAttribute('data-glass-only', '');
      expect(badge).toHaveAttribute('data-glass', 'order-fulfilment');
      expect(badge).toHaveTextContent(/^Delivery$/);
      // Words only: no control, no link, the icon hidden from the a11y tree.
      expect(badge.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
      expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      // Never the HTML hidden attribute, and no class that sets display.
      expect(badge).not.toHaveAttribute('hidden');
      expect(badge).not.toHaveAttribute('class');
    });
  }

  it('says Pickup for a pickup order and nothing for an unknown or missing type', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    expect(render(<OrderFulfilmentBadge fulfillmentType="pickup" />).container).toHaveTextContent(
      /^Pickup$/,
    );
    expect(render(<OrderFulfilmentBadge fulfillmentType={null} />).container.innerHTML).toBe('');
    expect(render(<OrderFulfilmentBadge fulfillmentType="ship" />).container.innerHTML).toBe('');
  });
});
