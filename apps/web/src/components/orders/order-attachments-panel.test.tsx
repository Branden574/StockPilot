import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { OrderAttachment } from '@/server/services/order-attachments';

// Redesign P4.B1: proof of delivery is a titled card (the kind picker and Add
// in its header), its empty line is the shared quiet state, and each tile
// keeps its kind label and its one control. Every word is the panel's own.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/image-variants', () => ({ compressImageVariants: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/server/actions/order-attachments', () => ({
  addOrderAttachmentAction: vi.fn(),
  deleteOrderAttachmentAction: vi.fn(async () => ({ ok: true, data: null })),
}));

import { deleteOrderAttachmentAction } from '@/server/actions/order-attachments';

import { OrderAttachmentsPanel } from './order-attachments-panel';

const ORDER = '11111111-1111-4111-8111-111111111111';

function attachment(id: string, over: Partial<OrderAttachment> = {}): OrderAttachment {
  return {
    id,
    orderRequestId: ORDER,
    storagePath: `org/${ORDER}/${id}.webp`,
    fileName: `${id}.webp`,
    contentType: 'image/webp',
    sizeBytes: 1000,
    kind: 'dropoff_photo',
    uploadedBy: null,
    createdAt: '2026-10-18T17:00:00Z',
    url: `https://storage.test/${id}`,
    thumbUrl: `https://storage.test/${id}?w=400`,
    ...over,
  };
}

function renderPanel(props: {
  attachments?: OrderAttachment[];
  canManage?: boolean;
  canAttach?: boolean;
}) {
  return render(
    <OrderAttachmentsPanel
      orderId={ORDER}
      organizationId="org-1"
      attachments={props.attachments ?? []}
      canManage={props.canManage ?? false}
      canAttach={props.canAttach ?? false}
    />,
  );
}

describe('OrderAttachmentsPanel — the redesigned proof of delivery card (P4.B1)', () => {
  it('someone who may attach: the titled card, the named kind picker and Add, and the empty line', () => {
    renderPanel({ canAttach: true, canManage: true });
    const card = screen.getByRole('heading', { name: 'Proof of delivery' }).closest('section')!;
    expect(card).toHaveAttribute('data-slot', 'detail-section');
    expect(card).toHaveTextContent(
      'Wet signatures, photos of dropped-off items, and where they were left.',
    );
    expect(within(card).getByRole('combobox', { name: 'Attachment kind' })).toHaveTextContent(
      'Items dropped off',
    );
    expect(within(card).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    const empty = card.querySelector('[data-slot="state-panel"]')!;
    expect(empty).toHaveAttribute('data-state-kind', 'empty');
    expect(empty).toHaveTextContent(
      'No attachments yet. Add photos or a signed slip as proof of delivery.',
    );
  });

  // The 1280 shots: the 32 px picker made this card's header 53 px beside
  // the 49 px of every other titled card with a small control aside.
  it('the kind picker is the small size, like Add beside it', () => {
    renderPanel({ canAttach: true, canManage: true });
    const picker = screen.getByRole('combobox', { name: 'Attachment kind' });
    expect(picker.className).toMatch(/(^|\s)h-7(\s|$)/);
    expect(picker.className).not.toMatch(/(^|\s)h-8(\s|$)/);
    expect(screen.getByRole('button', { name: 'Add' }).className).toMatch(/(^|\s)h-7(\s|$)/);
  });

  it('a reader who may not attach: no picker, no Add, and the short empty line', () => {
    renderPanel({});
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.getByText('No attachments.')).toBeInTheDocument();
  });

  it('each tile keeps its kind label, and a manager deletes through the tile control', async () => {
    const user = userEvent.setup();
    renderPanel({
      canManage: true,
      attachments: [
        attachment('a1'),
        attachment('a2', { kind: 'signature', contentType: 'application/pdf', thumbUrl: null }),
      ],
    });
    expect(screen.getByRole('img', { name: 'a1.webp' })).toBeInTheDocument();
    expect(screen.getByText('Items dropped off')).toBeInTheDocument();
    expect(screen.getByText('Wet signature')).toBeInTheDocument();
    const deletes = screen.getAllByRole('button', { name: 'Delete attachment' });
    expect(deletes).toHaveLength(2);
    await user.click(deletes[0]!);
    expect(vi.mocked(deleteOrderAttachmentAction)).toHaveBeenCalledWith({
      attachmentId: 'a1',
      orderRequestId: ORDER,
    });
  });

  it('a reader sees the tiles without the delete control', () => {
    renderPanel({ attachments: [attachment('a1')] });
    expect(screen.getByText('Items dropped off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete attachment' })).toBeNull();
  });
});
