// The viewer category-access grid on the shared Checkbox (P4.F2, row W-WS-09b):
// each category is one checkbox named by the category, zero boxes still
// means unrestricted (the count line says so), Select all / Clear all keep
// working, and Save sends exactly the ticked ids.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/user-categories', () => ({ setUserCategoryAccessAction: h.save }));

import { CategoryAccessCard } from './category-access-card';

const CATEGORIES = [
  { id: 'c-1', name: 'Tech' },
  { id: 'c-2', name: 'Books' },
  { id: 'c-3', name: 'Uniforms' },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue({ ok: true, data: { count: 1 } });
});

function renderCard(initiallyGranted: string[] = []) {
  render(
    <CategoryAccessCard
      targetUserId="u-9"
      targetUserName="Vera Viewer"
      allCategories={CATEGORIES}
      initiallyGranted={initiallyGranted}
    />,
  );
}

describe('CategoryAccessCard', () => {
  it('draws one checkbox per category, named by the category, seeded from the grants', () => {
    renderCard(['c-2']);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => b.textContent)).toEqual(['Tech', 'Books', 'Uniforms']);
    expect(screen.getByRole('checkbox', { name: 'Books' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'Tech' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('1 category selected.')).toBeInTheDocument();
  });

  it('zero boxes reads as unrestricted', () => {
    renderCard();
    expect(screen.getByText('No categories selected — sees everything.')).toBeInTheDocument();
  });

  it('one click toggles one box; Select all and Clear all still work', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('checkbox', { name: 'Tech' }));
    expect(screen.getByRole('checkbox', { name: 'Tech' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('1 category selected.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('3 categories selected.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByText('No categories selected — sees everything.')).toBeInTheDocument();
  });

  it('saves exactly the ticked ids', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('checkbox', { name: 'Uniforms' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith({ userId: 'u-9', categoryIds: ['c-3'] }),
    );
  });
});
