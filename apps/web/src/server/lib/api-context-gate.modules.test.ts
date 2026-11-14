import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contextUnavailableBody, type ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { UnreadableModuleSet } from '@/lib/modules/module-state';

import { apiContextGate } from './api-context-gate';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

/**
 * The gate's `modules` option (docket S81): a module the route needs whose
 * state could not be read is the gate's marker, before any work. A module
 * really off, and a route that names no module, pass through as before.
 */

function req() {
  return new Request('https://app.example.test/api/v1/rentals', { method: 'POST' });
}

function ctxWith(enabledModules: Set<ModuleId>) {
  return { organizationId: 'org-1', userId: 'u-1', enabledModules } as never;
}

/** The context a gate let through (compared by identity: a Set that refuses cannot be deep-compared). */
function passed(gate: Awaited<ReturnType<typeof apiContextGate>>) {
  return 'ctx' in gate ? gate.ctx : 'refused';
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('apiContextGate with { modules }', () => {
  it('a named module whose state is unknown: the marker, and one line naming the class', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(ctxWith(new UnreadableModuleSet([])));

    const gate = await apiContextGate(req(), { modules: ['rentals'] });

    expect('response' in gate).toBe(true);
    if (!('response' in gate)) return;
    expect(gate.response.status).toBe(503);
    expect(await gate.response.json()).toEqual(contextUnavailableBody());
    expect(gate.response.headers.get('retry-after')).toBe('5');
    expect(gate.response.headers.get('cache-control')).toBe('no-store');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls[0])).toContain(
      'ModulesUnavailableError',
    );
  });

  it('a named module known to be on while others are unknown: the context', async () => {
    const ctx = ctxWith(new UnreadableModuleSet(['rentals']));
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
    expect(passed(await apiContextGate(req(), { modules: ['rentals'] }))).toBe(ctx);
  });

  it('a named module really off: the context, so the route answers its own 403', async () => {
    const ctx = ctxWith(new Set<ModuleId>(['orders']));
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
    expect(passed(await apiContextGate(req(), { modules: ['rentals'] }))).toBe(ctx);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('no module named (the stock adjustment): never refused for the module state', async () => {
    const ctx = ctxWith(new UnreadableModuleSet([]));
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx);
    expect(passed(await apiContextGate(req()))).toBe(ctx);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('a null context stays { ctx: null }, the route its own 401', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    expect(await apiContextGate(req(), { modules: ['rentals'] })).toEqual({ ctx: null });
  });
});
