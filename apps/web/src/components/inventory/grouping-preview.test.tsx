import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Sports Task 11 — the Add Item "this will be saved as" grouping preview.
// The "Serial: not required" line is the reassurance that stops staff from
// inventing placeholder serials for a quantity-tracked product (requirement
// 12). Candidate linking must always require an explicit click — nothing may
// auto-link (requirement 6 / 13).
// ---------------------------------------------------------------------------

import { GroupingPreview } from './grouping-preview';

describe('GroupingPreview', () => {
  it('renders "Serial: not required" for a QUANTITY_BY_VARIANT product', () => {
    render(
      <GroupingPreview
        groupName="Nike Pegasus 41"
        variantLabel="Size 10.5"
        mode="QUANTITY_BY_VARIANT"
        countingUnit="pair"
      />,
    );
    expect(screen.getByText('Serial: not required')).toBeInTheDocument();
  });

  it('renders "Serial: required, one per unit" for a SERIALIZED product', () => {
    render(
      <GroupingPreview
        groupName={null}
        variantLabel={null}
        mode="SERIALIZED"
        countingUnit="each"
      />,
    );
    expect(screen.getByText('Serial: required, one per unit')).toBeInTheDocument();
  });

  it('renders the same required serial line for INDIVIDUALLY_TAGGED', () => {
    render(
      <GroupingPreview
        groupName={null}
        variantLabel={null}
        mode="INDIVIDUALLY_TAGGED"
        countingUnit="each"
      />,
    );
    expect(screen.getByText('Serial: required, one per unit')).toBeInTheDocument();
  });

  it('renders "Serial: optional" for an OPTIONAL_SERIALIZED product', () => {
    render(
      <GroupingPreview
        groupName="Rawlings helmets"
        variantLabel="Size L"
        mode="OPTIONAL_SERIALIZED"
        countingUnit="each"
      />,
    );
    expect(screen.getByText('Serial: optional')).toBeInTheDocument();
  });

  it('pluralizes a pair counting unit as "pairs"', () => {
    render(
      <GroupingPreview
        groupName="Nike Pegasus 41"
        variantLabel="Size 10.5"
        mode="QUANTITY_BY_VARIANT"
        countingUnit="pair"
      />,
    );
    expect(screen.getByText('pairs')).toBeInTheDocument();
  });

  it('falls back to "New group" and "Single variant" when there is nothing to preview yet', () => {
    render(
      <GroupingPreview groupName={null} variantLabel={null} mode="QUANTITY" countingUnit="unit" />,
    );
    expect(screen.getByText('New group')).toBeInTheDocument();
    expect(screen.getByText('Single variant')).toBeInTheDocument();
  });

  it('renders candidates with a "Use this group" control, and firing it calls onUseCandidate with the id', async () => {
    const onUseCandidate = vi.fn();
    render(
      <GroupingPreview
        groupName="Nike Pegasus 41"
        variantLabel="Size 10.5"
        mode="QUANTITY_BY_VARIANT"
        countingUnit="pair"
        candidates={[
          { id: 'grp-1', name: 'Nike Pegasus 40' },
          { id: 'grp-2', name: 'Nike Pegasus 41 (2025)' },
        ]}
        onUseCandidate={onUseCandidate}
      />,
    );

    expect(screen.getByText('Nike Pegasus 40')).toBeInTheDocument();
    expect(screen.getByText('Nike Pegasus 41 (2025)')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Use this group' });
    expect(buttons).toHaveLength(2);

    const user = userEvent.setup();
    await user.click(buttons[1]!);

    // Nothing links without the explicit click, and the click passes the
    // RIGHT candidate's id — proving selection, not a blanket auto-link.
    expect(onUseCandidate).toHaveBeenCalledTimes(1);
    expect(onUseCandidate).toHaveBeenCalledWith('grp-2');
  });

  it('renders no candidates section when the list is empty', () => {
    render(
      <GroupingPreview
        groupName="New group"
        variantLabel={null}
        mode="QUANTITY"
        countingUnit="unit"
      />,
    );
    expect(screen.queryByText(/look similar/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this group' })).not.toBeInTheDocument();
  });
});
