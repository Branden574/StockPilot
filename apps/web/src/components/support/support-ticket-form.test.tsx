import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}));

vi.mock('@/server/actions/support-tickets', () => ({
  submitDashboardTicketAction: vi.fn(),
}));

import { SupportTicketForm } from './support-ticket-form';

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:support-preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.clearAllMocks();
});

function pickPng(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('#support-screenshot');
  expect(input).not.toBeNull();
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  fireEvent.change(input!, { target: { files: [file] } });
}

describe('SupportTicketForm screenshot preview', () => {
  it('pins the Remove screenshot button over the preview corner (absolute wins over the touch target relative)', () => {
    const { container } = render(<SupportTicketForm userId="user-1" />);
    pickPng(container);

    expect(screen.getByAltText('Screenshot preview')).toHaveAttribute(
      'src',
      'blob:support-preview',
    );
    const remove = screen.getByRole('button', { name: 'Remove screenshot' });
    const classes = remove.className.split(/\s+/);
    expect(classes).toContain('absolute');
    expect(classes).not.toContain('relative');
    expect(classes).toEqual(expect.arrayContaining(['right-1.5', 'top-1.5']));
  });

  it('removes the preview and revokes its object URL when Remove screenshot is pressed', () => {
    const { container } = render(<SupportTicketForm userId="user-1" />);
    pickPng(container);

    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot' }));

    expect(screen.queryByAltText('Screenshot preview')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:support-preview');
  });
});
