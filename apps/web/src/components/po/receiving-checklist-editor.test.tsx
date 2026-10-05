// @vitest-environment happy-dom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECEIVING_CHECKLIST_COPY as C, SUGGESTED_RECEIVING_STEPS } from '@stockpilot/core';

/**
 * F4-1: the receiving checklist editor. Start from suggested steps or blank;
 * add, remove and move steps with labelled buttons; publish sends exactly the
 * steps shown (no editor keys), names the version it replaces and a client
 * id, and asks first; a stale editor keeps its edits and offers Reload; only
 * a publisher sees any action.
 */

const publishReceivingChecklistAction = vi.hoisted(() => vi.fn());
const retireReceivingChecklistAction = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('@/server/actions/receiving-checklist', () => ({
  publishReceivingChecklistAction,
  retireReceivingChecklistAction,
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import {
  moveStep,
  publishPayload,
  ReceivingChecklistEditor,
  stepsFromDrafts,
} from './receiving-checklist-editor';

import type { ChecklistEditorView } from '@/server/services/receiving-checklist';

const PUBLISHER = {
  canPostReceipt: true,
  canRecordChecklist: true,
  canPublishChecklist: true,
  canAddPoFile: true,
};
const READER = {
  canPostReceipt: false,
  canRecordChecklist: false,
  canPublishChecklist: false,
  canAddPoFile: false,
};

const LIVE = {
  id: 'v1',
  versionNumber: 1,
  title: 'Delivery checks',
  steps: [{ key: 's1', kind: 'check' as const, label: 'Slip matches', help: null, required: true }],
  procedureId: null,
  procedureTitle: null,
  publishedAt: '2026-10-01T15:00:00Z',
  publishedByName: 'Pat Lee',
  retiredAt: null,
  retiredByName: null,
  runCount: 2,
};

function editor(over: Partial<ChecklistEditorView> = {}): ChecklistEditorView {
  return {
    live: null,
    history: [],
    nextVersionNumber: 1,
    gate: PUBLISHER,
    procedures: [{ id: 'p1', title: 'Receiving SOP' }],
    proceduresUnavailable: false,
    timeZone: 'America/Los_Angeles',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  publishReceivingChecklistAction.mockResolvedValue({
    ok: true,
    data: { id: 'v2', versionNumber: 1 },
  });
  retireReceivingChecklistAction.mockResolvedValue({
    ok: true,
    data: { id: 'v1', versionNumber: 1 },
  });
});

describe('ReceivingChecklistEditor', () => {
  it('with nothing live, a publisher starts from the suggested steps and publishes them as shown', async () => {
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor()} />);
    expect(screen.getByText(C.editorEmpty)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: C.startSuggested }));
    expect(screen.getAllByRole('textbox', { name: /^Step \d+$/ })).toHaveLength(
      SUGGESTED_RECEIVING_STEPS.length,
    );
    await user.click(screen.getByRole('button', { name: C.publishVersion(1) }));
    expect(screen.getByText(C.publishConfirm(1))).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(1) }).at(-1)!);
    await waitFor(() => expect(publishReceivingChecklistAction).toHaveBeenCalledTimes(1));
    const body = publishReceivingChecklistAction.mock.calls[0]![0];
    expect(body.expectedCurrentId).toBeNull();
    expect(body.clientPublishId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.procedureId).toBeNull();
    expect(body.steps).toEqual(
      SUGGESTED_RECEIVING_STEPS.map((s) => ({
        kind: s.kind,
        label: s.label,
        help: null,
        required: s.required === true,
      })),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it('adds, removes and moves steps with labelled buttons, and publishes that order', async () => {
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor()} />);
    await user.click(screen.getByRole('button', { name: C.startBlank }));
    await user.type(screen.getByRole('textbox', { name: 'Step 1' }), 'First');
    await user.click(screen.getByRole('button', { name: new RegExp(C.addStep) }));
    await user.type(screen.getByRole('textbox', { name: 'Step 2' }), 'Second');
    await user.click(screen.getByRole('button', { name: new RegExp(C.addStep) }));
    await user.type(screen.getByRole('textbox', { name: 'Step 3' }), 'Third');
    await user.click(screen.getByRole('button', { name: C.moveStepUp(3) }));
    await user.click(screen.getByRole('button', { name: C.removeStep(1) }));
    expect((screen.getByRole('textbox', { name: 'Step 1' }) as HTMLInputElement).value).toBe(
      'Third',
    );
    expect((screen.getByRole('textbox', { name: 'Step 2' }) as HTMLInputElement).value).toBe(
      'Second',
    );
    await user.click(screen.getByRole('button', { name: C.publishVersion(1) }));
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(1) }).at(-1)!);
    await waitFor(() => expect(publishReceivingChecklistAction).toHaveBeenCalled());
    expect(
      publishReceivingChecklistAction.mock.calls[0]![0].steps.map(
        (s: { label: string }) => s.label,
      ),
    ).toEqual(['Third', 'Second']);
  });

  it("refuses a blank step in the server's words before anything is sent", async () => {
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor()} />);
    await user.click(screen.getByRole('button', { name: C.startBlank }));
    await user.click(screen.getByRole('button', { name: C.publishVersion(1) }));
    expect((await screen.findByRole('alert')).textContent).toContain('Step 1 needs a label.');
    expect(publishReceivingChecklistAction).not.toHaveBeenCalled();
  });

  it('a live version shows read only with who published it; preparing the next one names it as replaced', async () => {
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor({ live: LIVE, nextVersionNumber: 2 })} />);
    expect(screen.getByText(`${C.liveVersion(1)} Delivery checks`)).toBeTruthy();
    expect(screen.getByText(/Published by Pat Lee on October 1, 2026 at 8:00 AM/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: C.prepareVersion(2) }));
    await user.click(screen.getByRole('button', { name: C.publishVersion(2) }));
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(2) }).at(-1)!);
    await waitFor(() => expect(publishReceivingChecklistAction).toHaveBeenCalled());
    expect(publishReceivingChecklistAction.mock.calls[0]![0].expectedCurrentId).toBe('v1');
  });

  it('a stale editor keeps its edits and offers Reload', async () => {
    publishReceivingChecklistAction.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message: 'x', details: { reason: 'checklist_changed' } },
    });
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor({ live: LIVE, nextVersionNumber: 2 })} />);
    await user.click(screen.getByRole('button', { name: C.prepareVersion(2) }));
    const title = screen.getByRole('textbox', { name: C.titleLabel });
    await user.clear(title);
    await user.type(title, 'Edited title');
    await user.click(screen.getByRole('button', { name: C.publishVersion(2) }));
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(2) }).at(-1)!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(C.publishChanged);
    expect((screen.getByRole('textbox', { name: C.titleLabel }) as HTMLInputElement).value).toBe(
      'Edited title',
    );
    await user.click(within(alert).getByRole('button', { name: C.reload }));
    expect(router.refresh).toHaveBeenCalled();
  });

  // Mutation caught: publish awaited bare (the button spun for good), and a
  // fresh publish id on the resend (a lost reply then a resend would publish
  // twice, the second refused as changed).
  it('a publish whose reply never comes back says so, keeps the edits, and resends with the same id', async () => {
    publishReceivingChecklistAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor()} />);
    await user.click(screen.getByRole('button', { name: C.startSuggested }));
    await user.click(screen.getByRole('button', { name: C.publishVersion(1) }));
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(1) }).at(-1)!);
    expect((await screen.findByRole('alert')).textContent).toContain(C.didNotGoThrough);
    expect(screen.getAllByRole('textbox', { name: /^Step \d+$/ })).toHaveLength(
      SUGGESTED_RECEIVING_STEPS.length,
    );
    const again = screen.getByRole('button', { name: C.publishVersion(1) });
    expect(again).not.toBeDisabled();
    await user.click(again);
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(1) }).at(-1)!);
    await waitFor(() => expect(publishReceivingChecklistAction).toHaveBeenCalledTimes(2));
    expect(publishReceivingChecklistAction.mock.calls[1]![0].clientPublishId).toBe(
      publishReceivingChecklistAction.mock.calls[0]![0].clientPublishId,
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('a turn off whose reply never comes back says so, and can be asked again', async () => {
    retireReceivingChecklistAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor({ live: LIVE, nextVersionNumber: 2 })} />);
    await user.click(screen.getByRole('button', { name: C.turnOff }));
    await user.click(screen.getAllByRole('button', { name: C.turnOff }).at(-1)!);
    expect((await screen.findByRole('alert')).textContent).toContain(C.didNotGoThrough);
    expect(screen.getByRole('button', { name: C.turnOff })).not.toBeDisabled();
  });

  it('Turn off asks first, then turns off the live version', async () => {
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor({ live: LIVE, nextVersionNumber: 2 })} />);
    await user.click(screen.getByRole('button', { name: C.turnOff }));
    expect(screen.getByText(C.turnOffConfirm)).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: C.turnOff }).at(-1)!);
    await waitFor(() =>
      expect(retireReceivingChecklistAction).toHaveBeenCalledWith({ versionId: 'v1' }),
    );
  });

  it('someone who may not publish sees the checklist read only, with no action', () => {
    render(
      <ReceivingChecklistEditor editor={editor({ live: LIVE, gate: READER, procedures: null })} />,
    );
    expect(screen.getByText(C.readOnlyEditor)).toBeTruthy();
    expect(screen.queryByRole('button', { name: C.prepareVersion(2) })).toBeNull();
    expect(screen.queryByRole('button', { name: C.turnOff })).toBeNull();
    expect(screen.queryByRole('button', { name: C.startSuggested })).toBeNull();
  });

  it('moveStep and publishPayload', () => {
    const steps = stepsFromDrafts([
      { kind: 'check', label: 'A' },
      { kind: 'count', label: 'B', help: '  ', required: true },
    ]);
    expect(moveStep(steps, 0, -1).map((s) => s.label)).toEqual(['A', 'B']);
    expect(moveStep(steps, 0, 1).map((s) => s.label)).toEqual(['B', 'A']);
    expect(publishPayload(steps)).toEqual([
      { kind: 'check', label: 'A', help: null, required: false },
      { kind: 'count', label: 'B', help: null, required: true },
    ]);
  });
});
