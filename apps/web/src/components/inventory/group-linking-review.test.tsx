import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The family review (P4.A1, matrix W-IT-09), redrawn as one card per
// suggestion. What the owner decided stays exactly as it was: members start
// unticked, there is no select-all and no accept-all, a reason is required,
// "Not a family" hides the card for this visit only, and Link sends only the
// ticked ids. The Include box is now the shared checkbox.

const { linkFamilyAction, refresh } = vi.hoisted(() => ({
  linkFamilyAction: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/actions/product-group-linking', () => ({ linkFamilyAction }));

import { GroupLinkingReview, type ReviewSuggestion } from './group-linking-review';

const SUGGESTION: ReviewSuggestion = {
  styleKey: 'pegasus',
  baseName: 'Nike Pegasus 41',
  confidence: 'low',
  caveats: ['Two of these have different colours in their names.'],
  members: [
    { id: 'i-9', name: 'Nike Pegasus 41 - 9', sku: 'PEG-9', parsedSize: '9', quantity: 4 },
    { id: 'i-10', name: 'Nike Pegasus 41 - 10', sku: 'PEG-10', parsedSize: '10', quantity: 2 },
  ],
};

function renderReview(groupsTruncated = false) {
  return render(
    <GroupLinkingReview
      suggestions={[SUGGESTION]}
      existingGroups={[{ id: 'g-1', name: 'Pegasus', brand: 'Nike', model: null }]}
      groupsTruncated={groupsTruncated}
      subcategoryKeys={['shoes']}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('GroupLinkingReview', () => {
  it('draws one card per family with its confidence, caveats and members, all unticked', () => {
    renderReview();
    const card = screen.getByRole('region', { name: 'Nike Pegasus 41' });
    expect(within(card).getByText('Suggestion · check this one carefully')).toBeInTheDocument();
    expect(
      within(card).getByText('2 candidate items. Nothing here is linked yet.'),
    ).toBeInTheDocument();
    expect(
      within(card).getByText('Two of these have different colours in their names.'),
    ).toBeInTheDocument();
    const boxes = within(card).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Include Nike Pegasus 41 - 9 in this family',
      'Include Nike Pegasus 41 - 10 in this family',
    ]);
    for (const box of boxes) expect(box).toHaveAttribute('aria-checked', 'false');
    expect(
      within(card).getByText('Tick the items that really are one product.'),
    ).toBeInTheDocument();
  });

  it('has no select-all and no accept-all', () => {
    renderReview();
    expect(screen.queryByRole('checkbox', { name: /all/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /all/i })).not.toBeInTheDocument();
  });

  it('links only the ticked members, and only once a reason is typed', async () => {
    linkFamilyAction.mockResolvedValue({ ok: true, data: { linked: 1 } });
    const user = userEvent.setup();
    renderReview();
    const link = () => screen.getByRole('button', { name: /^Link/ });
    expect(link()).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', { name: 'Include Nike Pegasus 41 - 10 in this family' }),
    );
    expect(screen.getByText('1 of 2 items selected.')).toBeInTheDocument();
    expect(link()).toHaveTextContent('Link 1 selected');
    expect(link()).toBeDisabled();
    await user.type(
      screen.getByRole('textbox', { name: /Why are these one product\?/ }),
      'Checked the rack',
    );
    await user.click(link());
    expect(linkFamilyAction).toHaveBeenCalledWith({
      group: { name: 'Nike Pegasus 41', subcategoryKey: 'shoes', defaultCountingUnit: 'each' },
      members: [
        {
          itemId: 'i-10',
          variantSize: '10',
          variantSizeOriginal: '10',
          variantSizeSystem: null,
          jerseyNumber: null,
        },
      ],
      reason: 'Checked the rack',
    });
    expect(refresh).toHaveBeenCalled();
    expect(
      await screen.findByText(
        'Every suggestion on this page has been handled. Reload to look again.',
      ),
    ).toBeInTheDocument();
  });

  it('"Not a family" hides the card for this visit', async () => {
    const user = userEvent.setup();
    renderReview();
    await user.click(screen.getByRole('button', { name: 'Not a family' }));
    expect(screen.queryByRole('region', { name: 'Nike Pegasus 41' })).not.toBeInTheDocument();
    expect(linkFamilyAction).not.toHaveBeenCalled();
  });

  it('says so when the destination list is capped', () => {
    renderReview(true);
    expect(screen.getByText(/Showing the first 1 groups\./)).toBeInTheDocument();
  });
});
