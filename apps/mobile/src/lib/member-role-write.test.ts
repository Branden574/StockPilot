import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { canChangeMemberRoles, interpretMemberRoleWrite } from './member-role-write';

/**
 * Mobile admin role change — the FAIL-OPEN and the gate.
 *
 * The screen used to do a bare
 *   `const { error } = await supabase.from('organization_members').update(...)`
 * and painted the new role into the list BEFORE awaiting it. PostgREST answers
 * a row-count-0 UPDATE with 204 and `error === null`, so a write RLS refused —
 * or one whose member row had vanished — read as SUCCESS: the phone showed the
 * promotion, nothing had changed in the database, and a pull-to-refresh was the
 * only way to find out. Recurring pattern #2 in the bug-pattern reference.
 *
 * interpretMemberRoleWrite is the row-proof: 0 rows is a FAILURE.
 * canChangeMemberRoles is the app-layer gate that mirrors the web service's
 * `assertPermission(ctx, 'members:update_role')` — see the file's own note for
 * why it is parity, not enforcement.
 */
describe('interpretMemberRoleWrite', () => {
  it('treats a returned row as the proof the update landed', () => {
    expect(interpretMemberRoleWrite({ data: { user_id: 'u1' }, error: null })).toEqual({ ok: true });
  });

  it('FAILS on a 0-row update — the fail-open this fix exists for', () => {
    // PostgREST: 204, error null, data null. The old code called this success.
    const res = interpretMemberRoleWrite({ data: null, error: null });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toMatch(/did not|not applied|no longer|refused/i);
      // Never surface a bare "null"/"undefined" to a person.
      expect(res.message).not.toMatch(/null|undefined/);
    }
  });

  it('surfaces a real database error message', () => {
    const res = interpretMemberRoleWrite({ data: null, error: { message: 'boom' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('boom');
  });

  it('prefers the error over the row when both somehow arrive', () => {
    const res = interpretMemberRoleWrite({ data: { user_id: 'u1' }, error: { message: 'boom' } });
    expect(res.ok).toBe(false);
  });
});

describe('canChangeMemberRoles', () => {
  it('honours a revoked override even when the role is admin', () => {
    // mig 0207 user-level revoke: web refuses this admin; the phone must too.
    expect(canChangeMemberRoles('admin', new Set(['members:read'] as const))).toBe(false);
  });

  it('treats an EMPTY effective set as "not loaded", never as "revoked"', () => {
    // use-effective-permissions maps an empty persisted set back to undefined
    // for exactly this reason (no real member holds zero permissions); the
    // gate must agree or a half-written cache would lock every admin out.
    expect(canChangeMemberRoles('admin', new Set())).toBe(true);
  });

  it('allows an admin whose effective set still carries the permission', () => {
    expect(canChangeMemberRoles('admin', new Set(['members:update_role'] as const))).toBe(true);
  });

  it('falls back to the STATIC role permissions while the set is still loading', () => {
    // useEffectivePermissions returns undefined until the persisted set loads;
    // gating on that would hide the affordance from every admin on cold launch.
    expect(canChangeMemberRoles('admin', undefined)).toBe(true);
    expect(canChangeMemberRoles('staff', undefined)).toBe(false);
  });

  it('refuses when the role itself has not resolved yet', () => {
    expect(canChangeMemberRoles(null, undefined)).toBe(false);
  });

  it('grants a manager nothing here — role admin is admin-only', () => {
    expect(canChangeMemberRoles('manager', undefined)).toBe(false);
  });
});

/**
 * WIRING PINS. vitest cannot import an app/ screen (native modules at import
 * time), so the load-bearing connections in users.tsx are pinned at source
 * level — the pattern account-disabled-wiring.test.ts established.
 */
const screen = readFileSync(
  path.resolve(__dirname, '../../app/(drawer)/admin/users.tsx'),
  'utf8',
);
const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const flat = code.replace(/\s+/g, ' ');
const changeRoleAt = code.indexOf('async function changeRole');
const changeRole = code.slice(changeRoleAt, code.indexOf('return (', changeRoleAt));

describe('the admin users screen writes the role row-proof', () => {
  it('asks the update for the row back and routes it through interpretMemberRoleWrite', () => {
    expect(flat).toContain("import { canChangeMemberRoles, interpretMemberRoleWrite }");
    expect(flat).toContain(".update({ role: nextRole }) .eq('organization_id', orgId) .eq('user_id', member.user_id) .select('user_id') .maybeSingle()");
    expect(changeRole).toContain('interpretMemberRoleWrite(');
  });

  it('never treats an error-free response as success on its own', () => {
    // The exact old shape: destructure only `error` and branch on it. Scoped
    // to changeRole — the category grant/revoke below it still uses that shape
    // (a sibling of the same class, out of scope for this fix).
    expect(changeRole.replace(/\s+/g, ' ')).not.toContain('const { error } = await supabase');
  });

  it('paints the new role only AFTER the write is proven', () => {
    const writeAt = changeRole.indexOf('await supabase');
    const paintAt = changeRole.indexOf('setRows(');
    expect(writeAt).toBeGreaterThan(-1);
    expect(paintAt).toBeGreaterThan(-1);
    // Optimistic-before-write plus a fail-open check is how a failed change
    // stayed on screen looking saved.
    expect(paintAt).toBeGreaterThan(writeAt);
  });

  it('gates the change on members:update_role, not on isAdmin alone', () => {
    expect(flat).toContain('canChangeMemberRoles(role, permissions)');
    expect(changeRole).toContain('canChangeRoles');
  });
});
