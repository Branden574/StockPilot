import { render, screen } from '@testing-library/react';
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
    render(<MakeOwnItemButton itemId="item-1" />);
    expect(screen.queryByTestId('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: UNGROUP_COPY.makeOwnItem }));
    expect(screen.getByTestId('dialog')).toHaveTextContent('item-1');
    h.props.at(-1)!.onDone();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
