import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Orders list's server chain before rows: the service context (whose
 * GoTrue factors read the list waits on) starts beside the module gate, not
 * after it, and the gate still answers before any order is read. Same change
 * and reasoning as the Books page (books/page.chain.test.tsx): each serial
 * Supabase level is another chance at a 1-8 s gateway stall (3-5% of calls
 * from Vercel on weekday daytimes, 2026-09-22), and started after the gate
 * the GoTrue request waited for the gate's own round trip.
 */

const events: string[] = [];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0));
};

const h = vi.hoisted(() => ({
  enabled: true,
  gate: null as null | Promise<void>,
  contextFails: false,
}));

const m = vi.hoisted(() => ({
  checkModuleAccess: vi.fn(),
  requireOrgContext: vi.fn(),
  withContext: vi.fn(),
  list: vi.fn(),
  myRequests: vi.fn(),
  notEnabledProps: vi.fn(),
}));

function logged<T>(name: string, fn: () => Promise<T>): Promise<T> {
  events.push(`${name}:start`);
  return fn().then(
    (v) => {
      events.push(`${name}:end`);
      return v;
    },
    (e: unknown) => {
      events.push(`${name}:error`);
      throw e;
    },
  );
}

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: m.checkModuleAccess }));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: (props: Record<string, unknown>) => {
    m.notEnabledProps(props);
    return null;
  },
}));
vi.mock('@/components/orders/orders-export-menu', () => ({ OrdersExportMenu: () => null }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/perf/perf-useful', () => ({
  PerfUseful: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: m.requireOrgContext }));
vi.mock('@/server/services/context', () => ({ withContext: m.withContext }));
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: {
    forCurrentUser: vi.fn(async () => {
      // forCurrentUser resolves auth through the request-cached withContext.
      await m.withContext();
      return { list: m.list, myRequests: m.myRequests };
    }),
  },
}));

import OrdersPage from './page';

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  h.enabled = true;
  h.gate = null;
  h.contextFails = false;
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  m.checkModuleAccess.mockImplementation((id: string) =>
    logged(`module:${id}`, async () => {
      if (h.gate) await h.gate;
      return { enabled: h.enabled, canManage: true };
    }),
  );
  m.requireOrgContext.mockImplementation(() =>
    logged('ctx', async () => ({
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'admin',
      permissions: new Set(['orders:approve']),
    })),
  );
  // Request-cached in production: every call gets the same promise.
  let started: Promise<unknown> | null = null;
  m.withContext.mockImplementation(() => {
    started ??= logged('withContext', async () => {
      if (h.contextFails) throw new Error('context read failed');
      return { organizationId: 'org-1' };
    });
    return started;
  });
  m.list.mockImplementation(() => logged('list', async () => []));
  m.myRequests.mockImplementation(() => logged('myRequests', async () => []));
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

function callPage(params: Record<string, string> = {}) {
  return OrdersPage({ searchParams: Promise.resolve(params) });
}

describe('Orders page: server chain before rows', () => {
  it('the service context starts beside the orders gate, before it answers', async () => {
    const gate = deferred<void>();
    h.gate = gate.promise;

    const page = callPage();
    await flush();
    expect(events).toContain('withContext:start');
    expect(events).not.toContain('module:orders:end');
    expect(m.list).not.toHaveBeenCalled();

    gate.resolve();
    render(await page);
    expect(m.list).toHaveBeenCalledTimes(1);
    // One context for the whole render, the early one.
    expect(events.filter((e) => e === 'withContext:start')).toHaveLength(1);
  });

  it('nothing is read when the gate says no, and a failing early context is observed', async () => {
    h.enabled = false;
    h.contextFails = true;

    render(await callPage());
    await flush();
    expect(m.notEnabledProps).toHaveBeenCalledWith(expect.objectContaining({ moduleId: 'orders' }));
    expect(m.list).not.toHaveBeenCalled();
    expect(m.myRequests).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
