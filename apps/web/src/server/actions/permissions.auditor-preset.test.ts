import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import { AUDITOR_PRESET_PERMISSIONS } from '@/lib/auditor-preset';

import type { Permission } from '@stockpilot/core';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session state so per-test role / MFA / effective-permission
// overrides work (mirrors dashboard-settings.test.ts).
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
  // undefined → can() falls back to the static role defaults (owner/admin
  // hold every preset permission). Tests covering the anti-escalation guard
  // set an explicit effective set that LACKS one of the preset grants.
  permissions: undefined as Set<Permission> | undefined,
};

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = {
  stub: null,
};

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastPermissionsChanged: vi.fn(async () => undefined),
}));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: sessionState.role,
      permissions: sessionState.permissions,
      supabase: stubHolder.stub!.client,
      mfaRequired: sessionState.mfaRequired,
      mfaSatisfied: sessionState.mfaSatisfied,
      enabledModules: new Set(),
    })),
  };
});

import { audit } from '@/server/services/audit';
import { broadcastPermissionsChanged } from '@/lib/realtime/broadcast';

import { applyAuditorPresetAction } from './permissions';

interface OverrideRow {
  organization_id: string;
  role: string;
  permission: Permission;
  granted: boolean;
  updated_by: string;
  updated_at: string;
}

/** The recorded role_permission_overrides upsert calls: [rows, options][].
 *  Uses chainArgsAll (one entry per chain) so repeated applies are all
 *  visible — chainArgs only reflects the LAST chain per (table, op). */
function upsertCalls(stub: ReturnType<typeof makeSupabaseStub>): unknown[][] {
  const all = stub.chainArgsAll.get('role_permission_overrides.insert') ?? [];
  // Each chain is a single `.upsert(rows, options)` call — its first (only)
  // recorded method's args are the [rows, options] pair.
  return all.map((chainArgs) => chainArgs[0]!);
}

describe('applyAuditorPresetAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.permissions = undefined;
    stubHolder.stub = makeSupabaseStub();
  });

  it('grants exactly the 9 preset permissions to the viewer role via upsert', async () => {
    const result = await applyAuditorPresetAction();
    expect(result.ok).toBe(true);

    const calls = upsertCalls(stubHolder.stub!);
    expect(calls).toHaveLength(1);
    const [rows, options] = calls[0]! as [OverrideRow[], { onConflict: string }];
    expect(options).toEqual({ onConflict: 'organization_id,role,permission' });
    expect(rows).toHaveLength(AUDITOR_PRESET_PERMISSIONS.length);
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.permission))).toEqual(new Set(AUDITOR_PRESET_PERMISSIONS));
    for (const row of rows) {
      expect(row.organization_id).toBe('org-1');
      expect(row.role).toBe('viewer');
      expect(row.granted).toBe(true);
      expect(row.updated_by).toBe('user-1');
    }

    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('permissions.auditor_preset');
    expect(broadcastPermissionsChanged).toHaveBeenCalledWith('org-1', {
      role: 'viewer',
      granted: true,
    });
  });

  it('is idempotent — a second apply upserts the identical grant set', async () => {
    const first = await applyAuditorPresetAction();
    const second = await applyAuditorPresetAction();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const calls = upsertCalls(stubHolder.stub!);
    expect(calls).toHaveLength(2);
    const rowsOf = (call: unknown[]) =>
      (call[0] as OverrideRow[]).map(({ updated_at: _t, ...rest }) => rest);
    // Same rows both times (timestamps aside) — upsert-on-conflict makes the
    // second apply a pure no-op at the DB level.
    expect(rowsOf(calls[1]!)).toEqual(rowsOf(calls[0]!));
  });

  it.each(['manager', 'staff', 'viewer'] as const)(
    'denies a non-admin (%s) with forbidden and writes nothing',
    async (role) => {
      sessionState.role = role;
      const result = await applyAuditorPresetAction();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('forbidden');
      expect(upsertCalls(stubHolder.stub!)).toHaveLength(0);
      expect(stubHolder.stub!.fromCalls).not.toContain('role_permission_overrides');
      expect(audit).not.toHaveBeenCalled();
      expect(broadcastPermissionsChanged).not.toHaveBeenCalled();
    },
  );

  it('rejects an AAL1 session when the org requires MFA (forbidden, no write)', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const result = await applyAuditorPresetAction();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(upsertCalls(stubHolder.stub!)).toHaveLength(0);
  });

  it('anti-escalation: an admin whose effective set lacks a preset grant is denied before any write', async () => {
    sessionState.role = 'admin';
    // Effective set missing 'reports:read' (e.g. revoked by a role override).
    sessionState.permissions = new Set(
      AUDITOR_PRESET_PERMISSIONS.filter((p) => p !== 'reports:read'),
    );
    const result = await applyAuditorPresetAction();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(upsertCalls(stubHolder.stub!)).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });
});
