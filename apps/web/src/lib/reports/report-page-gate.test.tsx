import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UnreadableModuleSet } from '@/lib/modules/module-state';

/**
 * A report page's own check and the modules its report reads.
 *
 * It asks the page gate (checkModuleAccess), which has three answers: on, off
 * and "could not check". Off draws the module-not-enabled card; "could not
 * check" draws "We couldn't check whether this module is on" with Try again.
 * It never asks the context's own set, which throws for a state that was not
 * read, so the page keeps its own state for that instead of an error page.
 */

const h = vi.hoisted(() => ({
  access: {} as Record<string, { enabled: boolean; canManage: boolean; checkFailed?: boolean }>,
  ctx: null as unknown,
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (moduleId: string) => h.access[moduleId]),
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => h.ctx),
}));
vi.mock('@/components/dashboard/module-unavailable', () => ({
  ModuleUnavailable: () => null,
}));
vi.mock('@/components/reports/report-mfa-state', () => ({ ReportMfaCard: () => null }));

import { reportPageGate } from './report-page-gate';

type AnyElement = ReactElement<{
  moduleId: string;
  access: { enabled: boolean; canManage: boolean; checkFailed?: boolean };
}>;

function context(over: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'owner',
    permissions: new Set(['reports:read']),
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(['orders', 'books', 'purchase_orders']),
    ...over,
  };
}

beforeEach(() => {
  h.ctx = context();
  h.access = {
    orders: { enabled: true, canManage: true },
    books: { enabled: true, canManage: true },
    purchase_orders: { enabled: true, canManage: true },
  };
});

describe('reportPageGate', () => {
  it('every module the report reads is on: the page may render', async () => {
    expect(await reportPageGate('book-order-totals')).toBeNull();
    expect(await reportPageGate('stock-movements')).toBeNull();
  });

  it('a module that is off: the module-unavailable card for that module, as "off"', async () => {
    h.access.books = { enabled: false, canManage: true };
    const card = (await reportPageGate('book-order-totals')) as AnyElement;
    expect(card.props.moduleId).toBe('books');
    expect(card.props.access).toEqual({ enabled: false, canManage: true });
  });

  it('a module state that could not be read: the same card as "could not check", and no error is thrown', async () => {
    // The context holds the state as unknown: asking it would throw.
    h.ctx = context({ enabledModules: new UnreadableModuleSet([]) });
    h.access.orders = { enabled: false, canManage: true, checkFailed: true };
    h.access.books = { enabled: false, canManage: true, checkFailed: true };
    const card = (await reportPageGate('book-order-totals')) as AnyElement;
    expect(card.props.moduleId).toBe('orders');
    expect(card.props.access).toEqual({ enabled: false, canManage: true, checkFailed: true });
  });

  it('a report that reads no optional module renders whatever the module state is', async () => {
    h.ctx = context({ enabledModules: new UnreadableModuleSet([]) });
    expect(await reportPageGate('stock-movements')).toBeNull();
  });
});
