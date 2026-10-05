// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CASE_TABLE_STEPS, RECEIVING_CHECKLIST_COPY as C } from '@stockpilot/core';

/**
 * F4-1: the run form. Pass, Fail and Not applicable are labelled radios (text,
 * not colour alone); the answers are checked in the server's words before
 * anything is sent; a refusal keeps the typed answers on screen (someone else
 * saved: Reload is offered, never forced); an incomplete completion names and
 * marks the steps; a completed run, or one this person may not record, is read
 * only; "About this delivery" never says "none" for a read that failed.
 */

const saveReceivingCheckAction = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('@/server/actions/receiving-checklist', () => ({ saveReceivingCheckAction }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ReceivingCheckForm, resultsFromDrafts } from './receiving-check-form';

import type { ReceivingRunView } from '@/server/services/receiving-checklist';

function view(
  over: Partial<ReceivingRunView> = {},
  run: Partial<ReceivingRunView['run']> = {},
): ReceivingRunView {
  return {
    run: {
      id: 'run-1',
      status: 'in_progress',
      results: { s1: { value: 'pass' } },
      note: null,
      revision: 1,
      startedAt: '2026-10-02T15:00:00Z',
      startedByName: 'Pat Lee',
      completedAt: null,
      completedByName: null,
      ...run,
    },
    version: {
      id: 'v1',
      versionNumber: 1,
      title: 'Delivery checks',
      steps: [...CASE_TABLE_STEPS],
      procedure: null,
    },
    newerVersionNumber: null,
    receipt: {
      id: 'r1',
      receiptNumber: 'R-1',
      status: 'posted',
      receivedAt: '2026-10-02T14:00:00Z',
      reversedAt: null,
    },
    po: { id: 'po-1', poNumber: 'PO-1', supplierName: 'Acme' },
    about: {
      unitsReceived: 48,
      lineCount: 3,
      warehouseName: 'Main',
      stockOwner: { kind: 'ok', value: ['North Charter'] },
      billTo: { kind: 'ok', value: 'South Charter' },
      stillToCome: { kind: 'ok', value: 2 },
    },
    lines: [],
    canRecord: true,
    timeZone: 'America/Los_Angeles',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  saveReceivingCheckAction.mockResolvedValue({
    ok: true,
    data: {
      id: 'run-1',
      status: 'in_progress',
      revision: 2,
      results: {},
      note: null,
      completedAt: null,
    },
  });
});

describe('ReceivingCheckForm', () => {
  it('says what it records, and what it knows about the delivery, with the stock owner and the bill-to apart', () => {
    render(<ReceivingCheckForm view={view()} />);
    expect(screen.getByText(C.honesty)).toBeTruthy();
    expect(screen.getByText(C.receivedOnReceipt(48, 3))).toBeTruthy();
    expect(screen.getByText(C.receivedInto('Main'))).toBeTruthy();
    expect(screen.getByText(C.stockOwner(['North Charter']))).toBeTruthy();
    expect(screen.getByText(C.billTo('South Charter'))).toBeTruthy();
    expect(screen.getByText(C.stillToCome(2))).toBeTruthy();
  });

  // pattern #28: a read that failed is never "none".
  it('a stock owner or still-to-come that did not load says so, never "none"', () => {
    render(
      <ReceivingCheckForm
        view={view({
          about: {
            ...view().about,
            stockOwner: { kind: 'unavailable' },
            stillToCome: { kind: 'unavailable' },
          },
        })}
      />,
    );
    expect(screen.getByText(C.stockOwnerUnavailable)).toBeTruthy();
    expect(screen.queryByText(C.stockOwnerNone)).toBeNull();
    expect(screen.getByText(C.stillToComeUnavailable)).toBeTruthy();
  });

  it('labels Pass, Fail and Not applicable as radios with words', () => {
    render(<ReceivingCheckForm view={view()} />);
    const pass = screen.getAllByRole('radio', { name: C.pass });
    expect(pass).toHaveLength(2);
    expect((pass[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole('radio', { name: C.notApplicable })).toHaveLength(2);
    expect(screen.getAllByRole('radiogroup')).toHaveLength(2);
  });

  it('saves the answers it holds, on the revision it loaded, with a save id', async () => {
    const user = userEvent.setup();
    render(<ReceivingCheckForm view={view()} />);
    await user.type(screen.getByRole('textbox', { name: 'Number of boxes received' }), '12');
    await user.click(screen.getByRole('button', { name: C.saveProgress }));
    await waitFor(() => expect(saveReceivingCheckAction).toHaveBeenCalledTimes(1));
    const [runId, body] = saveReceivingCheckAction.mock.calls[0]!;
    expect(runId).toBe('run-1');
    expect(body).toMatchObject({
      results: { s1: { value: 'pass' }, s3: { value: 12 } },
      expectedRevision: 1,
      complete: false,
    });
    expect(body.saveId).toMatch(/^[0-9a-f-]{36}$/);
    expect(router.refresh).toHaveBeenCalled();
  });

  // Mutation caught: a conflict that resets the form to the saved answers.
  it('when someone else saved first, the typed answers stay and Reload is offered', async () => {
    saveReceivingCheckAction.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message: 'x', details: { reason: 'checklist_run_changed' } },
    });
    const user = userEvent.setup();
    render(<ReceivingCheckForm view={view()} />);
    const count = screen.getByRole('textbox', { name: 'Number of boxes received' });
    await user.type(count, '7');
    await user.click(screen.getByRole('button', { name: C.saveProgress }));
    expect((await screen.findByRole('alert')).textContent).toContain(C.runChanged);
    expect((count as HTMLInputElement).value).toBe('7');
    expect(router.refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: C.reload }));
    expect(router.refresh).toHaveBeenCalled();
  });

  // Mutation caught: the save awaited bare (Save progress stayed busy for
  // good), and a fresh save id on the resend (a lost reply then a resend
  // would be two saves, the second refused as changed).
  it('a save whose reply never comes back says so, keeps the answers, and resends with the same save id', async () => {
    saveReceivingCheckAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<ReceivingCheckForm view={view()} />);
    const count = screen.getByRole('textbox', { name: 'Number of boxes received' });
    await user.type(count, '9');
    await user.click(screen.getByRole('button', { name: C.saveProgress }));
    expect((await screen.findByRole('alert')).textContent).toContain(C.didNotGoThrough);
    expect((count as HTMLInputElement).value).toBe('9');
    const again = screen.getByRole('button', { name: C.saveProgress });
    expect(again).not.toBeDisabled();
    await user.click(again);
    await waitFor(() => expect(saveReceivingCheckAction).toHaveBeenCalledTimes(2));
    const first = saveReceivingCheckAction.mock.calls[0]![1] as { saveId: string };
    const second = saveReceivingCheckAction.mock.calls[1]![1] as { saveId: string };
    expect(second.saveId).toBe(first.saveId);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('Complete names and marks what is missing before anything is sent', async () => {
    const user = userEvent.setup();
    render(<ReceivingCheckForm view={view({}, { results: {} })} />);
    await user.click(screen.getByRole('button', { name: C.completeChecklist }));
    await user.click(screen.getAllByRole('button', { name: C.completeChecklist }).at(-1)!);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Answer every required step before completing: Packing slip matches this purchase order.',
    );
    expect(saveReceivingCheckAction).not.toHaveBeenCalled();
    expect(document.querySelector('[data-step="s1"]')?.className).toContain('border-destructive');
  });

  it('a failed check asks what was wrong, and needs a note to complete', async () => {
    const user = userEvent.setup();
    render(<ReceivingCheckForm view={view()} />);
    await user.click(screen.getAllByRole('radio', { name: C.fail })[0]!);
    expect(screen.getByText(C.whatWasWrong)).toBeTruthy();
    expect(screen.getByText(C.reverseHint)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: C.completeChecklist }));
    await user.click(screen.getAllByRole('button', { name: C.completeChecklist }).at(-1)!);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Add a note to each failed check: Packing slip matches this purchase order.',
    );
  });

  it('a completed run is read only and says who completed it, in the organization zone', () => {
    render(
      <ReceivingCheckForm
        view={view(
          {},
          {
            status: 'completed',
            completedAt: '2026-10-05T22:04:00Z',
            completedByName: 'Sam Ortiz',
          },
        )}
      />,
    );
    expect(screen.getByText(C.completedBy('Sam Ortiz', 'October 5, 2026 at 3:04 PM'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: C.saveProgress })).toBeNull();
    expect(screen.queryByRole('button', { name: C.completeChecklist })).toBeNull();
    for (const r of screen.getAllByRole('radio'))
      expect((r.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  });

  it('someone who may not record sees it read only, and why', () => {
    render(<ReceivingCheckForm view={view({ canRecord: false })} />);
    expect(screen.getByText(C.readOnlyNotRecorder)).toBeTruthy();
    expect(screen.queryByRole('button', { name: C.saveProgress })).toBeNull();
  });

  it('says when it was recorded late, when the receipt was reversed after, and which version it keeps', () => {
    render(
      <ReceivingCheckForm
        view={view(
          {
            newerVersionNumber: 3,
            receipt: {
              id: 'r1',
              receiptNumber: 'R-1',
              status: 'reversed',
              receivedAt: '2026-09-28T14:00:00Z',
              reversedAt: '2026-10-04T00:00:00Z',
            },
          },
          {},
        )}
      />,
    );
    expect(screen.getByText(C.recordedLate(4))).toBeTruthy();
    expect(screen.getByText(C.reversedAfter)).toBeTruthy();
    expect(screen.getByText(C.keepsVersion(3, 1))).toBeTruthy();
  });

  it('resultsFromDrafts sends a count as a number only when it is whole, so a typo is refused by name', () => {
    const steps = [...CASE_TABLE_STEPS];
    expect(resultsFromDrafts(steps, { s3: { value: ' 12 ', note: '' } })).toEqual({
      s3: { value: 12 },
    });
    expect(resultsFromDrafts(steps, { s3: { value: '1.5', note: '' } })).toEqual({
      s3: { value: '1.5' },
    });
    expect(
      resultsFromDrafts(steps, { s2: { value: '', note: ' ' }, s4: { value: ' text ', note: '' } }),
    ).toEqual({
      s4: { value: ' text ' },
    });
  });
});
