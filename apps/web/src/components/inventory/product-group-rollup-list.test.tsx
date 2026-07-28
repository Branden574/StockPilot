import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Task 18 review fixes, both visible here:
//   • variants load ON EXPAND, one group at a time — a collapsed page reads
//     none, so it can neither waste a query nor hit PostgREST's max_rows and
//     under-report an expansion;
//   • Unlink is wired into the linked-items view (the brief requires unlink
//     support in the tool, not only on the API).

const { routerMock, loadVariantsMock, unlinkMock, toastMock } = vi.hoisted(() => ({
  routerMock: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
  loadVariantsMock: vi.fn(),
  unlinkMock: vi.fn(),
  toastMock: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/server/actions/product-groups', () => ({
  loadGroupVariantsAction: loadVariantsMock,
}));
vi.mock('@/server/actions/product-group-linking', () => ({
  unlinkItemsAction: unlinkMock,
}));

import { ProductGroupRollupList, type RollupGroup, type RollupVariant } from './product-group-rollup-list';

function group(over: Partial<RollupGroup> = {}): RollupGroup {
  return {
    id: 'grp-1',
    name: 'Nike Pegasus 41',
    brand: 'Nike',
    model: 'Pegasus 41',
    styleNumber: null,
    team: null,
    subcategoryKey: 'shoes',
    trackingMode: null,
    countingUnit: 'pair',
    variantCount: 2,
    totalQuantity: 52,
    ...over,
  };
}

function variant(over: Partial<RollupVariant> = {}): RollupVariant {
  return {
    id: 'itm-9',
    sku: 'PEG-9',
    name: 'Nike Pegasus 41 - 9',
    quantity: 32,
    variantSize: '9',
    variantSizeSystem: null,
    variantWidth: null,
    variantColor: null,
    jerseyNumber: null,
    trackingType: 'none',
    unitOfMeasure: 'pair',
    status: 'active',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadVariantsMock.mockResolvedValue({
    ok: true,
    data: { variants: [variant(), variant({ id: 'itm-10', sku: 'PEG-10', variantSize: '10', quantity: 20 })] },
  });
  unlinkMock.mockResolvedValue({ ok: true, data: { unlinked: 1 } });
});

describe('ProductGroupRollupList — on-demand expansion', () => {
  it('reads NO variants until a group is expanded', () => {
    render(<ProductGroupRollupList groups={[group()]} />);
    // The header is fully rendered from the roll-up view alone.
    expect(screen.getByText('2 variants · 52 pairs total')).toBeInTheDocument();
    expect(loadVariantsMock).not.toHaveBeenCalled();
  });

  it('fetches that ONE group on expand, and does not re-fetch on a second open', async () => {
    const user = userEvent.setup();
    render(<ProductGroupRollupList groups={[group(), group({ id: 'grp-2', name: 'Other' })]} />);

    await user.click(screen.getByRole('button', { name: /expand nike pegasus 41/i }));
    await screen.findByText('PEG-9');
    expect(loadVariantsMock).toHaveBeenCalledTimes(1);
    expect(loadVariantsMock).toHaveBeenCalledWith('grp-1');

    await user.click(screen.getByRole('button', { name: /collapse nike pegasus 41/i }));
    await user.click(screen.getByRole('button', { name: /expand nike pegasus 41/i }));
    expect(loadVariantsMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed read instead of rendering an empty group', async () => {
    const user = userEvent.setup();
    loadVariantsMock.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'Could not load variants.' },
    });
    render(<ProductGroupRollupList groups={[group()]} />);
    await user.click(screen.getByRole('button', { name: /expand/i }));

    expect(await screen.findByText('Could not load variants.')).toBeInTheDocument();
    expect(screen.queryByText('No items are linked to this group yet.')).not.toBeInTheDocument();
  });
});

describe('ProductGroupRollupList — unlink', () => {
  it('requires a reason and sends the item id the reviewer chose', async () => {
    const user = userEvent.setup();
    render(<ProductGroupRollupList groups={[group()]} />);
    await user.click(screen.getByRole('button', { name: /expand/i }));
    await screen.findByText('PEG-9');

    await user.click(screen.getByRole('button', { name: /unlink size 9 from nike pegasus 41/i }));
    // Empty reason: the confirm stays disabled, exactly as the server demands.
    const confirm = screen.getByRole('button', { name: 'Confirm unlink' });
    expect(confirm).toBeDisabled();
    expect(unlinkMock).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: /reason for unlinking/i }), 'Wrong style');
    await user.click(screen.getByRole('button', { name: 'Confirm unlink' }));

    await waitFor(() =>
      expect(unlinkMock).toHaveBeenCalledWith({ itemIds: ['itm-9'], reason: 'Wrong style' }),
    );
    // The row goes, and the header's figures are re-read from the server
    // rather than guessed at here.
    await waitFor(() => expect(screen.queryByText('PEG-9')).not.toBeInTheDocument());
    expect(screen.getByText('PEG-10')).toBeInTheDocument();
    expect(routerMock.refresh).toHaveBeenCalled();
  });

  it('keeps the row when the server refuses the unlink', async () => {
    const user = userEvent.setup();
    unlinkMock.mockResolvedValue({ ok: false, error: { code: 'forbidden', message: 'Not allowed.' } });
    render(<ProductGroupRollupList groups={[group()]} />);
    await user.click(screen.getByRole('button', { name: /expand/i }));
    await screen.findByText('PEG-9');

    await user.click(screen.getByRole('button', { name: /unlink size 9 from/i }));
    await user.type(screen.getByRole('textbox', { name: /reason for unlinking/i }), 'oops');
    await user.click(screen.getByRole('button', { name: 'Confirm unlink' }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Not allowed.'));
    expect(screen.getByText('PEG-9')).toBeInTheDocument();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });
});
