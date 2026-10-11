import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UNGROUP_COPY } from '@stockpilot/core';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  props: [] as Array<{
    open: boolean;
    itemIds: readonly string[];
    onDone: () => void;
    onOpenChange: (v: boolean) => void;
  }>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }));
vi.mock('./ungroup-dialog', () => ({
  UngroupDialog: (p: (typeof h.props)[number]) => {
    h.props.push(p);
    return <div data-testid="dialog">{p.itemIds.join(',')}</div>;
  },
}));

import { MakeOwnItemButton } from './make-own-item-button';

beforeEach(() => {
  vi.clearAllMocks();
  h.props.length = 0;
});

describe('MakeOwnItemButton', () => {
  it('opens the Ungroup review for this one record and refreshes the page after a split', async () => {
    render(<MakeOwnItemButton itemId="item-1" offer />);
    expect(screen.queryByTestId('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.makeOwnItem }));
    expect(screen.getByTestId('dialog')).toHaveTextContent('item-1');
    h.props.at(-1)!.onDone();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  // Fix round 1, P1: after a split the record's SKU is its own, so the page
  // stops offering the action (offer turns false). The host stays mounted and
  // keeps the open dialog, whose result (the new SKU, Print labels) must stay
  // on screen until the person closes it.
  it('offers nothing when not offered and nothing is open', () => {
    render(<MakeOwnItemButton itemId="item-1" offer={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('dialog')).toBeNull();
  });

  it('keeps an open dialog, and its result, when the offer goes away after the split, until it is closed', async () => {
    const { rerender } = render(<MakeOwnItemButton itemId="item-1" offer />);
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.makeOwnItem }));
    h.props.at(-1)!.onDone();
    rerender(<MakeOwnItemButton itemId="item-1" offer={false} />);
    expect(screen.getByTestId('dialog')).toHaveTextContent('item-1');
    expect(screen.queryByRole('button', { name: UNGROUP_COPY.makeOwnItem })).toBeNull();
    act(() => h.props.at(-1)!.onOpenChange(false));
    expect(screen.queryByTestId('dialog')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
