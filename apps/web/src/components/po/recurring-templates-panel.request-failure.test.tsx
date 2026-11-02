import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, recordEscapedRejections, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: recurring purchase order templates. The on/off switch, Delete and the
// template form's Create template / Save changes set a busy flag, awaited the
// action with no catch and cleared the flag only when it answered. A request
// that got no answer (offline, a server error, a deploy) left the control
// spinning, and the Delete confirm could not be closed, with nothing said.
// A template create has no rule against a second copy, so it says to look
// first; the others say they did not happen.
// ---------------------------------------------------------------------------

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
// The real unstable_rethrow stays, so isControlFlow recognises a redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/recurring-pos', () => ({
  setRecurringTemplateEnabledAction: vi.fn(),
  createRecurringTemplateAction: vi.fn(),
  updateRecurringTemplateAction: vi.fn(),
  deleteRecurringTemplateAction: vi.fn(),
}));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  formatRelative: () => 'just now',
}));

import { toast } from 'sonner';

import {
  createRecurringTemplateAction,
  deleteRecurringTemplateAction,
  setRecurringTemplateEnabledAction,
  updateRecurringTemplateAction,
} from '@/server/actions/recurring-pos';

import { RecurringTemplatesPanel, type RecurringTemplateRow } from './recurring-templates-panel';

const TEMPLATE: RecurringTemplateRow = {
  id: 'tpl-1',
  name: 'Weekly Supplies',
  supplier_id: null,
  destination_location_id: null,
  enabled: true,
  cadence: 'weekly',
  custom_days: null,
  send_mode: 'draft',
  max_auto_send_cents: null,
  line_items: [{ itemId: 'item-1', quantityOrdered: 2, unitCost: 10 }],
  notes: null,
  last_run_at: null,
  next_run_at: new Date().toISOString(),
};

const BASE_PROPS = {
  initial: [TEMPLATE],
  items: [{ id: 'item-1', name: 'Widget A', sku: 'WGT-A', unit_cost: 10 }],
  suppliers: [],
  locations: [],
  entitled: true,
  seed: null,
};

// A redirect handled by the page leaves nothing behind (see recordEscapedRejections).
const escaped = recordEscapedRejections();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recurring templates when a request gets no answer', () => {
  it('the switch says the template was not turned off, and works again', async () => {
    vi.mocked(setRecurringTemplateEnabledAction).mockRejectedValueOnce(offline());
    render(<RecurringTemplatesPanel {...BASE_PROPS} />);
    fireEvent.click(screen.getByTestId('toggle-tpl-1'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'turn the template off'),
      ),
    );
    expect(screen.getByTestId('toggle-tpl-1')).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Delete says why inside the confirm, which stays open and closes with Cancel', async () => {
    vi.mocked(deleteRecurringTemplateAction).mockRejectedValueOnce(offline());
    render(<RecurringTemplatesPanel {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const sentence = requestFailedMessage(offline(), 'delete the template');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence);
    expect(toast.error).toHaveBeenCalledWith(sentence);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Weekly Supplies')).toBeInTheDocument();
  });

  it('Create template says to look at the templates before trying again, and keeps the form', async () => {
    vi.mocked(createRecurringTemplateAction).mockRejectedValueOnce(offline());
    render(
      <RecurringTemplatesPanel
        {...BASE_PROPS}
        initial={[]}
        seed={{
          supplierId: null,
          destinationLocationId: null,
          lineItems: [{ itemId: 'item-1', quantityOrdered: 2, unitCost: 10 }],
        }}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('e.g. Weekly office supplies'), {
      target: { value: 'Monthly paper' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the template was created', 'the recurring templates'),
      ),
    );
    expect(screen.getByPlaceholderText('e.g. Weekly office supplies')).toHaveValue('Monthly paper');
    expect(screen.getByRole('button', { name: 'Create template' })).toBeEnabled();
  });

  it('Save changes says the template was not saved, and keeps the form', async () => {
    vi.mocked(updateRecurringTemplateAction).mockRejectedValueOnce(offline());
    render(<RecurringTemplatesPanel {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'save the template'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(setRecurringTemplateEnabledAction).mockRejectedValueOnce(signInRedirect());
    render(<RecurringTemplatesPanel {...BASE_PROPS} />);
    fireEvent.click(screen.getByTestId('toggle-tpl-1'));
    await waitFor(() => expect(setRecurringTemplateEnabledAction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(escaped, 'the redirect is handled, never left to escape').toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
