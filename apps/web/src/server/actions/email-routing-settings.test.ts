import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session state so per-test role / MFA overrides work (the
// auto-archive-settings.test.ts pattern).
const sessionState = {
  role: 'admin' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
};

const dbState: {
  existingRouting: unknown;
  updatePayload: unknown;
  updateRowExists: boolean;
} = {
  existingRouting: null,
  updatePayload: undefined,
  updateRowExists: true,
};
const updateSpy = vi.fn();

function makeClient() {
  return {
    from: vi.fn((table: string) => {
      if (table !== 'organizations') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { email_routing: dbState.existingRouting },
              error: null,
            }),
          }),
        }),
        update: (payload: unknown) => {
          updateSpy(payload);
          dbState.updatePayload = payload;
          return {
            eq: () => ({
              select: () => ({
                maybeSingle: async () => ({
                  data: dbState.updateRowExists ? { id: 'org-1' } : null,
                  error: null,
                }),
              }),
            }),
          };
        },
      };
    }),
  };
}

const auditSpy = vi.fn(async () => undefined);
vi.mock('@/server/services/audit', () => ({ audit: (...a: unknown[]) => auditSpy(...(a as [])) }));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  const { ROLE_PERMISSIONS } = await vi.importActual<typeof import('@stockpilot/core')>(
    '@stockpilot/core',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: sessionState.role,
      permissions: new Set(ROLE_PERMISSIONS[sessionState.role]),
      supabase: makeClient(),
      mfaRequired: sessionState.mfaRequired,
      mfaSatisfied: sessionState.mfaSatisfied,
      enabledModules: new Set(['orders']),
    })),
  };
});

import { setOrgEmailRoutingAction } from './email-routing-settings';

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.role = 'admin';
  sessionState.mfaRequired = false;
  sessionState.mfaSatisfied = true;
  dbState.existingRouting = null;
  dbState.updatePayload = undefined;
  dbState.updateRowExists = true;
});

const VALID_RECIPIENTS = {
  to: 'intake@example-tenant.invalid',
  cc: 'copy@example-tenant.invalid',
  toName: 'Intake Desk',
  ccName: 'Ops Manager',
};

describe('setOrgEmailRoutingAction — validation runs THE READER-SIDE guards', () => {
  it('saves a factory-passing value under its feature key', async () => {
    const res = await setOrgEmailRoutingAction({
      feature: 'delivery_request',
      recipients: VALID_RECIPIENTS,
    });
    expect(res).toMatchObject({ ok: true });
    expect(dbState.updatePayload).toEqual({
      email_routing: { delivery_request: VALID_RECIPIENTS },
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it('REFUSES to save what the read path would reject — the guard message verbatim, no write, no audit', async () => {
    const res = await setOrgEmailRoutingAction({
      feature: 'delivery_request',
      recipients: { to: 'intake@ok.invalid', cc: 'a?cc=attacker@evil.test' },
    });
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: 'validation_error',
        message:
          'Email recipient "cc" must be exactly one plain email address with no display name, separator or whitespace.',
      },
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('refuses an unsafe display name (the silent-CC-drop class) before any I/O', async () => {
    const res = await setOrgEmailRoutingAction({
      feature: 'maintenance_request',
      recipients: { to: 'intake@ok.invalid', cc: 'copy@ok.invalid', ccName: 'Ops, Manager' },
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect((res as { error: { message: string } }).error.message).toMatch(/RFC 5322 specials/);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('trims fields and drops empty display names instead of storing ""', async () => {
    await setOrgEmailRoutingAction({
      feature: 'delivery_request',
      recipients: { to: '  intake@ok.invalid  ', cc: ' copy@ok.invalid ', toName: '   ' },
    });
    expect(dbState.updatePayload).toEqual({
      email_routing: { delivery_request: { to: 'intake@ok.invalid', cc: 'copy@ok.invalid' } },
    });
  });
});

describe('setOrgEmailRoutingAction — merge semantics', () => {
  it('never clobbers the SIBLING feature key', async () => {
    dbState.existingRouting = {
      maintenance_request: { to: 'facilities@ok.invalid', cc: 'copy@ok.invalid' },
    };
    await setOrgEmailRoutingAction({ feature: 'delivery_request', recipients: VALID_RECIPIENTS });
    expect(dbState.updatePayload).toEqual({
      email_routing: {
        maintenance_request: { to: 'facilities@ok.invalid', cc: 'copy@ok.invalid' },
        delivery_request: VALID_RECIPIENTS,
      },
    });
  });

  it('recipients: null clears ONLY that feature key; the last cleared key nulls the column', async () => {
    dbState.existingRouting = {
      delivery_request: { to: 'a@b.invalid', cc: 'c@d.invalid' },
      maintenance_request: { to: 'e@f.invalid', cc: 'g@h.invalid' },
    };
    await setOrgEmailRoutingAction({ feature: 'delivery_request', recipients: null });
    expect(dbState.updatePayload).toEqual({
      email_routing: { maintenance_request: { to: 'e@f.invalid', cc: 'g@h.invalid' } },
    });

    dbState.existingRouting = { delivery_request: { to: 'a@b.invalid', cc: 'c@d.invalid' } };
    await setOrgEmailRoutingAction({ feature: 'delivery_request', recipients: null });
    expect(dbState.updatePayload).toEqual({ email_routing: null });
  });
});

describe('setOrgEmailRoutingAction — gates fail closed', () => {
  it('MFA required-but-unsatisfied refuses before any read or write', async () => {
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const res = await setOrgEmailRoutingAction({
      feature: 'delivery_request',
      recipients: VALID_RECIPIENTS,
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('a role without organization:update is refused (manager)', async () => {
    sessionState.role = 'manager';
    const res = await setOrgEmailRoutingAction({
      feature: 'delivery_request',
      recipients: VALID_RECIPIENTS,
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('a 0-row update fails CLOSED (pattern #22: RLS "success" with no row is not a write)', async () => {
    dbState.updateRowExists = false;
    const res = await setOrgEmailRoutingAction({
      feature: 'delivery_request',
      recipients: VALID_RECIPIENTS,
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('an unknown feature never reaches the database', async () => {
    const res = await setOrgEmailRoutingAction({
      feature: 'purchasing' as unknown as 'delivery_request',
      recipients: VALID_RECIPIENTS,
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
