import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

// B40: the item page's Public visibility select set `busy`, showed the new
// value at once, awaited the action with no catch and cleared `busy` only when
// it answered. A change that got no answer (offline, a server error, a
// deploy) left the select disabled for good, showing a value that was never
// saved, with no message.

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/item-visibility', () => ({ setItemPublicVisibilityAction: vi.fn() }));

import { toast } from 'sonner';

import { setItemPublicVisibilityAction } from '@/server/actions/item-visibility';

import { PublicVisibilityControl } from './public-visibility-control';

beforeAll(() => {
  // Radix Select needs pointer-capture APIs happy-dom doesn't implement.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PublicVisibilityControl when the change gets no answer', () => {
  it('puts the saved value back, says the change was not made, and the select works again', async () => {
    vi.mocked(setItemPublicVisibilityAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(
      <PublicVisibilityControl
        itemId="item-1"
        value="internal_only"
        categoryIsInternalOnly={false}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Public visibility' }));
    await user.click(await screen.findByRole('option', { name: 'Hidden' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'change the public visibility'),
    );
    const select = screen.getByRole('combobox', { name: 'Public visibility' });
    expect(select).toHaveTextContent('Internal only');
    expect(select).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
