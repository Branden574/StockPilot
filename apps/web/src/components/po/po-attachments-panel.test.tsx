import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PoAttachment } from '@/server/services/po-attachments';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/server/actions/po-attachments', () => ({
  addPoAttachmentAction: vi.fn(),
  deletePoAttachmentAction: vi.fn(),
}));

import { PoAttachmentsList, PoFileActions } from './po-attachments-panel';

/**
 * The attachments card keeps its title and sentence, a row per file that
 * opens it, a named download link, and Delete only for those who manage
 * purchase orders; with no files there is no card. The header's file actions
 * keep Download all (only with files) and Attach file (managers).
 */

const FILES = [
  { id: 'a1', fileName: 'packing-slip.pdf', url: 'https://files.test/a1' },
  { id: 'a2', fileName: null, url: null },
] as unknown as PoAttachment[];

describe('PoAttachmentsList', () => {
  it('draws nothing without files', () => {
    const { container } = render(
      <PoAttachmentsList purchaseOrderId="po-1" attachments={[]} canManage />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each file with its open and download links, and Delete for a manager', () => {
    render(<PoAttachmentsList purchaseOrderId="po-1" attachments={FILES} canManage />);
    expect(screen.getByRole('heading', { name: 'Attachments' })).toBeInTheDocument();
    expect(
      screen.getByText('Packing slips, receipts, and other files for this purchase order.'),
    ).toBeInTheDocument();
    const [slip, unnamed] = screen.getAllByRole('listitem');
    const open = within(slip!).getByRole('link', { name: 'packing-slip.pdf' });
    expect(open).toHaveAttribute('href', 'https://files.test/a1');
    expect(open).toHaveAttribute('target', '_blank');
    const download = within(slip!).getByRole('link', { name: 'Download packing-slip.pdf' });
    expect(download).toHaveAttribute('download');
    expect(within(slip!).getByRole('button', { name: 'Delete packing-slip.pdf' })).toBeEnabled();
    // A file whose link could not be signed keeps its row, named "File".
    expect(within(unnamed!).getByRole('link', { name: 'File' })).toHaveAttribute('href', '#');
    expect(within(unnamed!).queryByRole('link', { name: /^Download/ })).toBeNull();
    expect(within(unnamed!).getByRole('button', { name: 'Delete file' })).toBeInTheDocument();
  });

  it('wraps a long file name instead of cutting its end, and keeps its title, name and new-tab link', () => {
    // P68-2: in the PO page's right column at 1280 the cut name hid the slip
    // number and ".pdf" ('Lantern Peak packing slip PS-44...').
    const name = 'Lantern Peak packing slip PS-44812.pdf';
    render(
      <PoAttachmentsList
        purchaseOrderId="po-1"
        attachments={[{ id: 'a3', fileName: name, url: 'https://files.test/a3' }] as PoAttachment[]}
        canManage={false}
      />,
    );
    const open = screen.getByRole('link', { name });
    expect(open).not.toHaveClass('truncate');
    expect(open).toHaveClass('min-w-0', 'flex-1', '[overflow-wrap:anywhere]');
    expect(open).toHaveTextContent(name);
    expect(open).toHaveAttribute('title', name);
    expect(open).toHaveAttribute('href', 'https://files.test/a3');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('gives a reader no Delete', () => {
    render(<PoAttachmentsList purchaseOrderId="po-1" attachments={FILES} canManage={false} />);
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });
});

describe('PoFileActions', () => {
  it('offers Download all only with files, and Attach file only to a manager', () => {
    const managing = render(
      <PoFileActions purchaseOrderId="po-1" organizationId="org-1" canManage hasAttachments />,
    );
    expect(screen.getByRole('link', { name: /download all/i })).toHaveAttribute(
      'href',
      '/api/purchase-orders/po-1/attachments.zip',
    );
    expect(screen.getByRole('button', { name: /attach file/i })).toBeInTheDocument();
    managing.unmount();
    render(
      <PoFileActions
        purchaseOrderId="po-1"
        organizationId="org-1"
        canManage={false}
        hasAttachments={false}
      />,
    );
    expect(screen.queryByRole('link', { name: /download all/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /attach file/i })).toBeNull();
  });
});
