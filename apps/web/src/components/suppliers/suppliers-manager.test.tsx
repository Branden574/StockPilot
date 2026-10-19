/**
 * The Suppliers page body (P4.C2 redesign): the page header with its words per
 * view, Active / Archived, the manage-only buttons, the table columns, the
 * dialog fields and both confirmations, and the email link that fails closed
 * (HANDOFFS P4.C2, from the P5.8 verify).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => '/dashboard/suppliers',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const archive = vi.fn(async (_id: string) => ({ ok: true as const, data: undefined }));
const restore = vi.fn(async (_id: string) => ({ ok: true as const, data: undefined }));
const create = vi.fn(async (_p: unknown) => ({ ok: true as const, data: { id: 'new' } }));
vi.mock('@/server/actions/suppliers', () => ({
  archiveSupplierAction: (id: string) => archive(id),
  restoreSupplierAction: (id: string) => restore(id),
  createSupplierAction: (p: unknown) => create(p),
  updateSupplierAction: vi.fn(async () => ({ ok: true as const, data: { id: 's1' } })),
}));

import { SuppliersManager } from './suppliers-manager';

const ROW = (over: Partial<Record<string, string | null>> = {}) => ({
  id: 's1',
  name: 'Acme Supplies',
  contact_name: 'Ana',
  email: 'orders@acme.com',
  phone: '555-010-0100',
  website: null,
  notes: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('SuppliersManager', () => {
  it('draws the header, the toggle and the table for a manager on the active view', () => {
    render(<SuppliersManager initial={[ROW()]} view="active" canManage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeInTheDocument();
    expect(screen.getByText('Vendors, contacts, and where to reorder from.')).toBeInTheDocument();
    const toggle = screen.getByRole('tablist', { name: 'View filter' });
    expect(within(toggle).getByRole('tab', { name: 'Archived' })).toHaveAttribute(
      'href',
      '/dashboard/suppliers?view=archived',
    );
    expect(screen.getByRole('button', { name: /New supplier/ })).toBeInTheDocument();
    for (const name of ['Name', 'Contact', 'Email', 'Phone', 'Actions']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'orders@acme.com' })).toHaveAttribute(
      'href',
      'mailto:orders@acme.com',
    );
    expect(screen.getByText('555-010-0100')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive Acme Supplies' })).toBeInTheDocument();
  });

  it('shows a stored email that is not one plain address as text, never a link', () => {
    render(
      <SuppliersManager
        initial={[
          ROW({ id: 'a', name: 'A', email: 'a@b.com?bcc=x@y.z' }),
          ROW({ id: 'b', name: 'B', email: 'a@b.com,x@y.z' }),
          ROW({ id: 'c', name: 'C', email: 'orders@аcme.com' }),
        ]}
      />,
    );
    expect(screen.getByText('a@b.com?bcc=x@y.z')).toBeInTheDocument();
    expect(screen.getByText('a@b.com,x@y.z')).toBeInTheDocument();
    expect(screen.getByText('orders@аcme.com')).toBeInTheDocument();
    expect(
      screen.queryAllByRole('link').filter((l) => l.getAttribute('href')?.startsWith('mailto:')),
    ).toEqual([]);
  });

  it('hides every manage button without suppliers:manage', () => {
    render(<SuppliersManager initial={[ROW()]} view="active" canManage={false} />);
    expect(screen.queryByRole('button', { name: /New supplier/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull();
  });

  it('archived view: its own words, Restore with a confirmation, no New supplier', async () => {
    render(<SuppliersManager initial={[ROW()]} view="archived" canManage />);
    expect(
      screen.getByText('Suppliers you archived. Restore one to bring it back into pick lists.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New supplier/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Restore/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Restore "Acme Supplies"?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('s1'));
  });

  it('Archive asks first with its words', async () => {
    render(<SuppliersManager initial={[ROW()]} canManage />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive Acme Supplies' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Archive "Acme Supplies"?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/hidden from pick lists and new purchase orders/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('s1'));
  });

  it('empty states keep their words per view', () => {
    const { unmount } = render(<SuppliersManager initial={[]} />);
    expect(screen.getByText('No suppliers yet')).toBeInTheDocument();
    unmount();
    render(<SuppliersManager initial={[]} view="archived" />);
    expect(screen.getByText('No archived suppliers')).toBeInTheDocument();
  });

  it('the New supplier dialog keeps every field and requires a name', async () => {
    render(<SuppliersManager initial={[]} canManage />);
    fireEvent.click(screen.getByRole('button', { name: /New supplier/ }));
    const dialog = await screen.findByRole('dialog');
    for (const label of ['Name', /Contact name/, /Phone/, /Email/, /Website/, /Notes/]) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create supplier' }));
    expect(await within(dialog).findByText('Name is required.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});
