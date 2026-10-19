import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bins in the redesign (W-AD-04): the add form on the shared field and
 * checkbox primitives, one titled card per warehouse, and the Default column
 * named for a screen reader.
 */

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const actions = vi.hoisted(() => ({ create: vi.fn(), archive: vi.fn() }));
vi.mock('@/server/actions/bins', () => ({
  createBinAction: actions.create,
  archiveBinAction: actions.archive,
}));

import { BinsManager } from './bins-manager';

const WAREHOUSES = [
  { id: 'w1', name: 'North DC' },
  { id: 'w2', name: 'South DC' },
];
const BINS = [
  {
    id: 'b1',
    warehouse_id: 'w1',
    code: 'RCV',
    name: 'Receiving dock',
    bin_type: 'receiving',
    is_default: true,
  },
] as never;

beforeEach(() => vi.clearAllMocks());

describe('BinsManager', () => {
  it('groups bins under one titled card per warehouse with their count, and names the Default tick', () => {
    render(<BinsManager warehouses={WAREHOUSES} bins={BINS} />);
    const north = screen.getByRole('heading', { level: 3, name: 'North DC' }).closest('section')!;
    expect(within(north).getByText('1 bin')).toBeInTheDocument();
    expect(within(north).getByText('Default', { selector: '.sr-only' })).toBeInTheDocument();
    expect(within(north).queryByText('✓')).toBeNull();
    const south = screen.getByRole('heading', { level: 3, name: 'South DC' }).closest('section')!;
    expect(within(south).getByText('0 bins')).toBeInTheDocument();
    expect(within(south).getByText('No bins yet.')).toBeInTheDocument();
  });

  it('sends the Default checkbox with the bin and resets code, name and the box after a save', async () => {
    actions.create.mockResolvedValue({ ok: true });
    render(<BinsManager warehouses={WAREHOUSES} bins={BINS} />);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'sto-1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Shelf one' } });
    const box = screen.getByRole('checkbox', {
      name: 'Default for this storage type (one allowed per warehouse)',
    });
    expect(box).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save bin' }));
    await waitFor(() =>
      expect(actions.create).toHaveBeenCalledWith({
        warehouseId: 'w1',
        code: 'sto-1',
        name: 'Shelf one',
        binType: 'storage',
        isDefault: true,
      }),
    );
    await waitFor(() => expect(box).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByLabelText('Code')).toHaveValue('');
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('keeps the archive confirm and shows a refusal inside it', async () => {
    actions.archive.mockResolvedValue({ ok: false, error: { message: 'Bin still holds stock.' } });
    render(<BinsManager warehouses={WAREHOUSES} bins={BINS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Archive bin "RCV"?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Bin still holds stock.');
  });
});
