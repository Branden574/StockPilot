import { render, screen } from '@testing-library/react';
import { redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceError } from '@/server/services/context';

import { RECEIVING_CHECKLIST_COPY as C } from '@stockpilot/core';

/**
 * F4-1: the two receiving checklist pages fail closed (recurring bug pattern
 * #1). A failed read renders "The checklist didn't load" with Try again on
 * the same page, never the dashboard error boundary and never "no checklist
 * yet"; a run the caller cannot see is not found; Next's own control flow (a
 * sign-in redirect) still escapes.
 */

const svc = vi.hoisted(() => ({
  getEditor: vi.fn(),
  getRun: vi.fn(),
}));
const moduleOn = vi.hoisted(() => ({ value: true }));
const reportError = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: moduleOn.value, canManage: false })),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: () => <div data-testid="module-not-enabled" />,
}));
vi.mock('@/components/po/receiving-checklist-editor', () => ({
  ReceivingChecklistEditor: () => <div data-testid="editor" />,
}));
vi.mock('@/components/po/receiving-check-form', () => ({
  ReceivingCheckForm: () => <div data-testid="check-form" />,
}));
vi.mock('@/server/services/receiving-checklist', () => ({
  ReceivingChecklistService: { forCurrentUser: vi.fn(async () => svc) },
}));

const { default: EditorPage } = await import('./receiving-checklist/page');
const { default: RunPage } = await import('./receiving-checks/[runId]/page');

const RUN_ID = '0a0f2100-0000-4000-8000-000000000401';

function redirectError(): unknown {
  try {
    redirect('/signin');
  } catch (e) {
    return e;
  }
  throw new Error('redirect did not throw');
}

const runView = {
  run: { id: RUN_ID, revision: 2, status: 'in_progress' },
  version: { versionNumber: 3, title: 'Delivery checks' },
  receipt: { receiptNumber: 'R-1001' },
  po: { id: 'po-1', poNumber: 'PO-2026-0052', supplierName: 'Acme Supply' },
};

beforeEach(() => {
  vi.clearAllMocks();
  moduleOn.value = true;
});

describe('the receiving checklist page', () => {
  it('renders the editor when the read answers', async () => {
    svc.getEditor.mockResolvedValueOnce({ live: null });
    render(await EditorPage());
    expect(screen.getByTestId('editor')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Mutation caught: getEditor awaited bare (a read error crashes the page
  // into the error boundary).
  it('a failed read says the checklist did not load, offers the same page, and is reported', async () => {
    svc.getEditor.mockRejectedValueOnce(new ServiceError('internal_error', 'db down'));
    render(await EditorPage());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(C.loadFailed);
    expect(screen.getByRole('link', { name: C.tryAgain })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/receiving-checklist',
    );
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.queryByText(C.editorEmpty)).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(ServiceError),
      expect.objectContaining({ tag: 'dashboard.receiving_checklist.load' }),
    );
  });

  it('a sign-in redirect still escapes', async () => {
    const r = redirectError();
    svc.getEditor.mockRejectedValueOnce(r);
    await expect(EditorPage()).rejects.toBe(r);
  });

  it('Receiving off shows the module notice and reads nothing', async () => {
    moduleOn.value = false;
    render(await EditorPage());
    expect(screen.getByTestId('module-not-enabled')).toBeInTheDocument();
    expect(svc.getEditor).not.toHaveBeenCalled();
  });
});

describe("one receipt's checklist page", () => {
  const params = (runId: string) => ({ params: Promise.resolve({ runId }) });

  it('renders the run when the read answers', async () => {
    svc.getRun.mockResolvedValueOnce(runView);
    render(await RunPage(params(RUN_ID)));
    expect(screen.getByTestId('check-form')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /PO-2026-0052/ })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/po-1',
    );
  });

  it('a run id that is not a uuid is not found, before any read', async () => {
    await expect(RunPage(params('not-a-uuid'))).rejects.toThrow('notFound');
    expect(svc.getRun).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'forbidden'] as const)('%s is not found', async (code) => {
    svc.getRun.mockRejectedValueOnce(new ServiceError(code, 'x'));
    await expect(RunPage(params(RUN_ID))).rejects.toThrow('notFound');
    expect(reportError).not.toHaveBeenCalled();
  });

  // Mutation caught: getRun awaited bare.
  it('a failed read says the checklist did not load and offers this run again', async () => {
    svc.getRun.mockRejectedValueOnce(new ServiceError('internal_error', 'db down'));
    render(await RunPage(params(RUN_ID)));
    expect(screen.getByRole('alert')).toHaveTextContent(C.loadFailed);
    expect(screen.getByRole('link', { name: C.tryAgain })).toHaveAttribute(
      'href',
      `/dashboard/purchase-orders/receiving-checks/${RUN_ID}`,
    );
    expect(screen.queryByTestId('check-form')).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(ServiceError),
      expect.objectContaining({ tag: 'dashboard.receiving_check.load' }),
    );
  });

  it('a sign-in redirect still escapes', async () => {
    const r = redirectError();
    svc.getRun.mockRejectedValueOnce(r);
    await expect(RunPage(params(RUN_ID))).rejects.toBe(r);
  });
});
