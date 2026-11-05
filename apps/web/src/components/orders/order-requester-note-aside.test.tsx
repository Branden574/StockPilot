import { render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrderRequesterNoteAside } from './order-requester-note-aside';

/**
 * The requester's note in the order page's side column, where
 * Order-Detail.dc.html draws it (plan 4.6, a stateless block): a glass-only
 * copy, words only, beside the main column's Classic-only note. Rendered
 * only when the build offers Liquid Glass and the order has notes; not at
 * all under the `off` rollout.
 */
afterEach(() => vi.unstubAllEnvs());

const NOTES = 'Please leave the boxes at the side door.\nRing twice.';

describe('OrderRequesterNoteAside', () => {
  it('renders nothing at all under the off rollout (and with the flag unset)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    expect(render(<OrderRequesterNoteAside notes={NOTES} />).container.innerHTML).toBe('');
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', '');
    expect(render(<OrderRequesterNoteAside notes={NOTES} />).container.innerHTML).toBe('');
  });

  it('renders nothing for an order without notes, as the main column does', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    expect(render(<OrderRequesterNoteAside notes={null} />).container.innerHTML).toBe('');
    expect(render(<OrderRequesterNoteAside notes="" />).container.innerHTML).toBe('');
  });

  for (const rollout of ['opt-in', 'default'] as const) {
    it(`under ${rollout}: one glass-only block holding the heading and the words, and no control`, () => {
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
      const { container } = render(<OrderRequesterNoteAside notes={NOTES} />);
      const block = container.firstElementChild as HTMLElement;
      // A div among the side column's sections: no Classic section changes
      // its place among its siblings (or its *-of-type place).
      expect(block.tagName).toBe('DIV');
      expect(block).toHaveAttribute('data-glass-only', '');
      expect(block).toHaveAttribute('data-glass', 'order-requester-note-aside');
      expect(block).not.toHaveAttribute('hidden');
      expect(block).not.toHaveAttribute('class');
      const section = within(block);
      expect(section.getByRole('heading', { level: 2, name: 'Requester note' })).toBeVisible();
      expect(block.querySelector('p')?.textContent).toBe(NOTES);
      // The card the main column's note is, with its glass role, and no
      // test id (the page's own note keeps data-testid="order-requester-note").
      expect(block.querySelector('section')).toHaveAttribute(
        'data-glass-role',
        'order-requester-note',
      );
      expect(block.querySelector('[data-testid]')).toBeNull();
      // Words only: nothing to press, follow or type into.
      expect(block.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
    });
  }
});
