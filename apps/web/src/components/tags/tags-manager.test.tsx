import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/tags',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/tags', () => ({
  createTagAction: vi.fn(),
  deleteTagAction: vi.fn(),
  updateTagAction: vi.fn(),
}));

import { createTagAction, deleteTagAction, updateTagAction } from '@/server/actions/tags';

import { TagsManager, type TagManagerRow } from './tags-manager';

/**
 * The Tags manager (W-BK-11), redrawn under the shared page header. Kept: New
 * tag; each row's colour dot, name (opens Edit), usage count, Edit and Delete;
 * the dialog's Name (required, 60 at most), eight swatches and the custom
 * colour; the delete confirm that names how many items lose the tag. Fixed:
 * Edit and Delete were invisible until hovered, so touch and keyboard users
 * never saw them (CONFLICTS D18).
 */
const ROWS: TagManagerRow[] = [
  { id: 't-1', name: 'Fragile', color: '#f97316', usage_count: 3 },
  { id: 't-2', name: 'Heavy', color: null, usage_count: 1 },
  { id: 't-3', name: 'Unused', color: '#6366f1', usage_count: 0 },
];

beforeEach(() => {
  vi.mocked(createTagAction).mockResolvedValue({ ok: true, data: { id: 'x' } } as never);
  vi.mocked(updateTagAction).mockResolvedValue({ ok: true, data: { id: 'x' } } as never);
  vi.mocked(deleteTagAction).mockResolvedValue({ ok: true, data: undefined } as never);
});

describe('TagsManager', () => {
  it('draws the page header with the h1, subline and New tag', () => {
    render(<TagsManager initial={ROWS} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Tags' })).toBeInTheDocument();
    expect(
      screen.getByText(/Flexible labels you can apply to many items at once/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New tag/ })).toBeInTheDocument();
  });

  it('each row keeps its name, usage count, Edit and Delete', () => {
    render(<TagsManager initial={ROWS} />);
    const rows = screen.getAllByTestId('tag-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole('button', { name: 'Fragile' })).toBeInTheDocument();
    expect(within(rows[0]!).getByText('3 items')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('1 item')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Delete Fragile' })).toBeInTheDocument();
  });

  it('D18: Edit and Delete hide only for a fine pointer, never on touch or for the keyboard', () => {
    render(<TagsManager initial={ROWS} />);
    const row = screen.getAllByTestId('tag-row')[0]!;
    for (const control of [
      within(row).getByRole('button', { name: 'Edit' }),
      within(row).getByRole('button', { name: 'Delete Fragile' }),
    ]) {
      // No element between the control and its row is hidden for every
      // pointer; a hiding class carries the pointer-fine: variant, and a
      // focus inside the row shows it again.
      for (let el: HTMLElement | null = control; el && el !== row; el = el.parentElement) {
        const classes = el.className.split(/\s+/);
        expect(classes).not.toContain('opacity-0');
        expect(classes.filter((c) => c.endsWith('opacity-0'))).toEqual(
          classes.some((c) => c.endsWith('opacity-0')) ? ['pointer-fine:opacity-0'] : [],
        );
        if (classes.includes('pointer-fine:opacity-0')) {
          // The descendant selector `.group:focus-within &`, whose group is the row.
          expect(classes).toContain('pointer-fine:[.group:focus-within_&]:opacity-100');
          expect(el.closest('.group')).toBe(row);
          expect(classes).toContain('pointer-fine:group-hover:opacity-100');
        }
      }
    }
  });

  it('the name and Edit open the dialog filled in; Save sends the new name', async () => {
    const user = userEvent.setup();
    render(<TagsManager initial={ROWS} />);
    await user.click(screen.getByRole('button', { name: 'Fragile' }));
    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Fragile');
    expect(name).toHaveAttribute('maxLength', '60');
    await user.clear(name);
    await user.type(name, 'Breakable');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateTagAction).toHaveBeenCalledWith('t-1', { name: 'Breakable', color: '#f97316' }),
    );
  });

  it('the dialog keeps the eight swatches and the custom colour', async () => {
    const user = userEvent.setup();
    render(<TagsManager initial={ROWS} />);
    await user.click(screen.getByRole('button', { name: /New tag/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByRole('button', { name: /^Use color #/ })).toHaveLength(8);
    expect(within(dialog).getByLabelText('Custom tag color')).toHaveAttribute('type', 'color');
    await user.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(await within(dialog).findByText('Name is required.')).toBeInTheDocument();
    expect(createTagAction).not.toHaveBeenCalled();
  });

  it('delete confirm names how many items lose the tag, then deletes', async () => {
    const user = userEvent.setup();
    render(<TagsManager initial={ROWS} />);
    await user.click(screen.getByRole('button', { name: 'Delete Fragile' }));
    expect(
      await screen.findByText(
        'This tag is currently applied to 3 items — those links will be removed. The items themselves stay intact.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteTagAction).toHaveBeenCalledWith('t-1'));
  });

  it('an unused tag says it will be removed from the workspace', async () => {
    const user = userEvent.setup();
    render(<TagsManager initial={ROWS} />);
    await user.click(screen.getByRole('button', { name: 'Delete Unused' }));
    expect(
      await screen.findByText('This tag will be removed from your workspace.'),
    ).toBeInTheDocument();
  });

  it('no tags: the empty state', () => {
    render(<TagsManager initial={[]} />);
    expect(screen.getByText('No tags yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New tag/ })).toBeInTheDocument();
  });
});
