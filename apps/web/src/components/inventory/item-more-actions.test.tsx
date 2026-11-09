import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ITEM_MORE_ACTIONS_NAME, ItemMoreActions } from './item-more-actions';

/**
 * The item page's More actions (Item-Detail.dc.html .acts): a glass-only
 * disclosure that holds no action of its own. pages/item-detail.css reads its
 * aria-expanded to show or hide the classic actions it holds back, in place.
 */
afterEach(() => vi.unstubAllEnvs());

describe('ItemMoreActions', () => {
  it('renders nothing at all under the off rollout (and with the flag unset)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    expect(render(<ItemMoreActions />).container.innerHTML).toBe('');
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    expect(render(<ItemMoreActions />).container.innerHTML).toBe('');
  });

  for (const rollout of ['opt-in', 'default'] as const) {
    it(`under ${rollout}: one glass-only span holding one button, closed, that opens and closes on each press`, () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const { container } = render(<ItemMoreActions />);
      const span = container.firstElementChild as HTMLElement;
      // A span among the page head's divs: no Classic element changes its
      // place among its siblings (or its *-of-type place).
      expect(span.tagName).toBe('SPAN');
      expect(span).toHaveAttribute('data-glass-only', '');
      expect(span).toHaveAttribute('data-glass', 'item-more');
      expect(span).not.toHaveAttribute('hidden');
      expect(span).not.toHaveAttribute('class');
      expect(span.querySelectorAll('a, button, input, select, textarea')).toHaveLength(1);
      const button = screen.getByRole('button', { name: ITEM_MORE_ACTIONS_NAME });
      expect(ITEM_MORE_ACTIONS_NAME).toBe('More actions');
      expect(button).toHaveAttribute('type', 'button');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');
      // It never closes on its own: only a second press closes it.
      fireEvent.blur(button);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(button).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });
  }

  it('its open state survives every appearance switch: same node, still open, mounted once (plan 4.6 identity)', () => {
    // The one glass-only element on the page that holds state (open or
    // closed). Plan 4.6 keeps stateful leaves out of glass-only elements so a
    // switch cannot lose their state; this one is rendered in every
    // appearance (only CSS hides it in Classic) and reads no appearance while
    // rendering, so a switch never unmounts it and the state stays.
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    const html = document.documentElement;
    const before = html.getAttribute('data-appearance');
    let mounts = 0;
    function Probe() {
      React.useEffect(() => {
        mounts += 1;
      }, []);
      return <ItemMoreActions />;
    }
    try {
      html.setAttribute('data-appearance', 'liquid-glass');
      const { rerender } = render(<Probe />);
      const button = screen.getByRole('button', { name: ITEM_MORE_ACTIONS_NAME });
      fireEvent.click(button);
      for (const look of ['classic', 'liquid-glass', 'classic', 'liquid-glass']) {
        html.setAttribute('data-appearance', look);
        rerender(<Probe />);
        const now = screen.getByRole('button', { name: ITEM_MORE_ACTIONS_NAME, hidden: true });
        expect(now).toBe(button);
        expect(now).toHaveAttribute('aria-expanded', 'true');
      }
      expect(mounts).toBe(1);
    } finally {
      if (before === null) html.removeAttribute('data-appearance');
      else html.setAttribute('data-appearance', before);
    }
  });
});
