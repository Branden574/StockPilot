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

import { ReceivingChecklistEditor } from './receiving-checklist-editor';

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
/** Someone else published version 2 while version 1 was being edited. */
const LIVE_V2 = {
  ...LIVE,
  id: 'v2',
  versionNumber: 2,
  title: 'Delivery checks (theirs)',
  publishedAt: '2026-10-02T15:00:00Z',
  publishedByName: 'Sam Ortiz',
  runCount: 0,
};
const RETIRED_V1 = { ...LIVE, retiredAt: '2026-10-02T15:00:00Z', retiredByName: 'Sam Ortiz' };

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

  // Desk check F2 (mutation caught: the expected id read from the props at
  // publish time). Editing began on v1; a refresh then brought v2 live. The
  // publish still names v1, so the database refuses it as checklist_changed
  // instead of replacing v2 with edits made from v1.
  it('publishing names the version editing began on, even after a refresh brings a newer one', async () => {
    const user = userEvent.setup();
    const view = render(
      <ReceivingChecklistEditor editor={editor({ live: LIVE, nextVersionNumber: 2 })} />,
    );
    await user.click(screen.getByRole('button', { name: C.prepareVersion(2) }));
    view.rerender(
      <ReceivingChecklistEditor
        editor={editor({ live: LIVE_V2, history: [RETIRED_V1], nextVersionNumber: 3 })}
      />,
    );
    await user.click(screen.getByRole('button', { name: C.publishVersion(3) }));
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(3) }).at(-1)!);
    await waitFor(() => expect(publishReceivingChecklistAction).toHaveBeenCalledTimes(1));
    expect(publishReceivingChecklistAction.mock.calls[0]![0].expectedCurrentId).toBe('v1');
  });

  // Desk check F2: only the explicit Reload after checklist_changed moves the
  // base, to the version that reload brought; the edits stay.
  it('Reload after a conflict keeps the edits and re-bases them on the version it loaded', async () => {
    publishReceivingChecklistAction.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'x', details: { reason: 'checklist_changed' } },
    });
    const user = userEvent.setup();
    const before = editor({ live: LIVE, nextVersionNumber: 2 });
    const view = render(<ReceivingChecklistEditor editor={before} />);
    await user.click(screen.getByRole('button', { name: C.prepareVersion(2) }));
    const title = screen.getByRole('textbox', { name: C.titleLabel });
    await user.clear(title);
    await user.type(title, 'Edited title');
    await user.click(screen.getByRole('button', { name: C.publishVersion(2) }));
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(2) }).at(-1)!);
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: C.reload }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // A re-render before the reload lands carries the same props: nothing moves.
    view.rerender(<ReceivingChecklistEditor editor={before} />);
    expect(screen.getByRole('alert').textContent).toContain(C.publishChanged);
    // The reload lands (new props from the server): v2 is live.
    view.rerender(
      <ReceivingChecklistEditor
        editor={editor({ live: LIVE_V2, history: [RETIRED_V1], nextVersionNumber: 3 })}
      />,
    );
    expect((screen.getByRole('textbox', { name: C.titleLabel }) as HTMLInputElement).value).toBe(
      'Edited title',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: C.publishVersion(3) }));
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(3) }).at(-1)!);
    await waitFor(() => expect(publishReceivingChecklistAction).toHaveBeenCalledTimes(2));
    expect(publishReceivingChecklistAction.mock.calls[0]![0].expectedCurrentId).toBe('v1');
    expect(publishReceivingChecklistAction.mock.calls[1]![0].expectedCurrentId).toBe('v2');
    expect(publishReceivingChecklistAction.mock.calls[1]![0].title).toBe('Edited title');
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

  // pattern #28: a list that did not load is said, never shown as "no procedures".
  it('procedures that did not load are said in place of the picker', async () => {
    const user = userEvent.setup();
    render(
      <ReceivingChecklistEditor
        editor={editor({ procedures: null, proceduresUnavailable: true })}
      />,
    );
    await user.click(screen.getByRole('button', { name: C.startSuggested }));
    expect(screen.getByText(C.proceduresUnavailable)).toBeTruthy();
    expect(screen.queryByLabelText(C.procedureLabel)).toBeNull();
  });

  // Review 2026-10-24: the redraw put the live version and the earlier
  // versions in DetailSections that named only their headings, so neither was
  // a region any more.
  it('the live version and the earlier versions are regions named by their headings', () => {
    const view = render(
      <ReceivingChecklistEditor
        editor={editor({ live: LIVE_V2, history: [RETIRED_V1], nextVersionNumber: 3 })}
      />,
    );
    expect(
      screen.getByRole('region', { name: `${C.liveVersion(2)} Delivery checks (theirs)` }),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: C.history })).toBeTruthy();
    view.unmount();
    render(<ReceivingChecklistEditor editor={editor()} />);
    expect(screen.getByRole('region', { name: C.noLiveVersion })).toBeTruthy();
  });

  // Review 2026-10-24: the busy button showed its spinner alone, so it had no
  // name until the call came back.
  it('Publish version N keeps its name while it works', async () => {
    publishReceivingChecklistAction.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor()} />);
    await user.click(screen.getByRole('button', { name: C.startSuggested }));
    await user.click(screen.getByRole('button', { name: C.publishVersion(1) }));
    await user.click(screen.getAllByRole('button', { name: C.publishVersion(1) }).at(-1)!);
    await waitFor(() => expect(publishReceivingChecklistAction).toHaveBeenCalledTimes(1));
    const busy = screen.getByRole('button', { name: C.publishVersion(1) });
    expect(busy).toBeDisabled();
    expect(busy.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  // Review 2026-10-24 (WCAG 3.3.2): a new step's text field was an empty box
  // named only for screen readers. It has the phone's visible "Step N" label.
  it('names each step field with a visible "Step N" label, as the phone does', async () => {
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor()} />);
    await user.click(screen.getByRole('button', { name: C.startBlank }));
    await user.click(screen.getByRole('button', { name: new RegExp(C.addStep) }));
    for (const n of [1, 2]) {
      const field = screen.getByRole('textbox', { name: `${C.stepLabel} ${n}` });
      const label = screen.getByText(`${C.stepLabel} ${n}`, { selector: 'label' });
      expect(label.getAttribute('for')).toBe(field.id);
      expect(field.getAttribute('aria-label')).toBeNull();
    }
  });

  // Review 2026-10-24, measured at 390 px in Chromium on a coarse pointer:
  // the step's field column was 222 px, the Answer select kept its own 244 px
  // and ran under the Move down and Remove buttons and out of the card, and
  // the three 32 px icon buttons were stacked 4 px apart, so each 44 px touch
  // area covered the edge of the one before it (a tap on the foot of Move
  // down pressed Remove, which asks nothing). Now the buttons sit in a row in
  // the step's header, 44 px on phones and coarse pointers, so the fields
  // take the card's whole width, and below sm the word sits over a select
  // that fills the row. The geometry needs a layout engine; these pin the
  // classes that make it, and the PR records the 390, 375 and 360 px
  // measurements.
  it('at phone width the step buttons are 44 px in a row over the fields, and the select fills its row', async () => {
    const user = userEvent.setup();
    render(<ReceivingChecklistEditor editor={editor()} />);
    await user.click(screen.getByRole('button', { name: C.startSuggested }));
    const step = screen.getByRole('textbox', { name: `${C.stepLabel} 2` }).closest('li')!;
    const buttons = [C.moveStepUp(2), C.moveStepDown(2), C.removeStep(2)].map((name) =>
      within(step).getByRole('button', { name }),
    );
    const classes = (el: Element) => el.className.split(/\s+/);
    for (const b of buttons) {
      expect(classes(b)).toEqual(
        expect.arrayContaining(['max-sm:size-11', 'pointer-coarse:size-11']),
      );
    }
    const row = buttons[0]!.parentElement!;
    expect(buttons.every((b) => b.parentElement === row)).toBe(true);
    expect(classes(row)).toEqual(expect.arrayContaining(['flex', 'gap-1.5']));
    expect(classes(row)).not.toContain('flex-col');
    // The row comes before the step's fields, not beside them.
    const field = within(step).getByRole('textbox', { name: `${C.stepLabel} 2` });
    expect(row.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.contains(field)).toBe(false);
    const select = within(step).getByRole('combobox');
    expect(classes(select)).toEqual(expect.arrayContaining(['min-w-0', 'max-sm:w-full']));
    expect(classes(select.closest('label')!)).toEqual(
      expect.arrayContaining(['max-sm:w-full', 'max-sm:flex-col', 'max-sm:items-stretch']),
    );
  });

  // The row helpers themselves (checklistEditorStepsFrom, moveChecklistStep,
  // checklistPublishPayload) are tested in core, where the phone uses them too.
});
