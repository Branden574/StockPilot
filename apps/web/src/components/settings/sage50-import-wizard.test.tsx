/**
 * Migrate from Sage 50: the three numbered steps keep their words, the CSV
 * input stays a real, named, keyboard-reachable file input that takes several
 * .csv files, and Import stays disabled until the item list is loaded.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/sage50-import', () => ({ importSage50Action: vi.fn() }));

import { Sage50ImportWizard } from './sage50-import-wizard';

describe('Sage50ImportWizard', () => {
  it('shows the three steps, a named multi-file CSV input and a disabled Import', () => {
    render(
      <Sage50ImportWizard
        warehouses={[{ id: 'w1', name: 'Main' }]}
        userId="user-1"
        organizationId="org-1"
      />,
    );
    expect(screen.getByRole('heading', { name: '1 · Export from Sage 50' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '2 · Drop the files here' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '3 · Import' })).toBeInTheDocument();

    const input = screen.getByLabelText('Sage 50 CSV files') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('.csv,text/csv');
    expect(input.tabIndex).not.toBe(-1);

    expect(screen.getAllByText('not loaded')).toHaveLength(3);
    expect(
      screen.getByText('Load the Inventory Item List first — it is the only required file.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import into StockPilot' })).toBeDisabled();
  });

  it('says to create a warehouse first when the caller can write to none', () => {
    render(<Sage50ImportWizard warehouses={[]} userId="user-1" organizationId="org-1" />);
    expect(
      screen.getByText('Create a warehouse first — imported items need one to belong to.'),
    ).toBeInTheDocument();
  });
});
