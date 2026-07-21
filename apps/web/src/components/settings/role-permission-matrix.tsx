'use client';

import { AlertTriangle, Check, Loader2, RotateCcw } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import {
  applyAuditorPresetAction,
  setRolePermissionOverrideAction,
  setUserPermissionOverrideAction,
} from '@/server/actions/permissions';

import { AUDITOR_PRESET_PERMISSIONS } from '@/lib/auditor-preset';
import { Button } from '@/components/ui/button';

import {
  FULLY_GRANTABLE_PERMISSIONS,
  PERMISSION_GROUP_ORDER,
  PERMISSION_META,
  PERMISSIONS,
  ROLE_DEFINITIONS,
  ROLES,
  effectivePermissions,
  hasPermission,
  type Permission,
  type Role,
} from '@stockpilot/core';

type EditableRole = Exclude<Role, 'owner'>;

export interface PermOverrideRow {
  role?: string;
  user_id?: string;
  permission: string;
  granted: boolean;
}

export interface MemberLite {
  userId: string;
  name: string;
  role: Role;
}

interface Props {
  /** Saved role-level overrides. */
  roleOverrides: PermOverrideRow[];
  /** Saved per-user overrides. */
  userOverrides: PermOverrideRow[];
  /** Org members (for the per-user exceptions picker). */
  members: MemberLite[];
}

interface GroupedRow {
  group: string;
  permissions: Array<{ id: Permission; label: string; description: string }>;
}

function groupedPermissions(): GroupedRow[] {
  const byGroup = new Map<string, GroupedRow>();
  for (const id of PERMISSIONS) {
    const meta = PERMISSION_META[id];
    const row = byGroup.get(meta.group) ?? { group: meta.group, permissions: [] };
    row.permissions.push({ id, label: meta.label, description: meta.description });
    byGroup.set(meta.group, row);
  }
  const known = PERMISSION_GROUP_ORDER.filter((g) => byGroup.has(g));
  const extras = [...byGroup.keys()].filter((g) => !PERMISSION_GROUP_ORDER.includes(g)).sort();
  return [...known, ...extras].map((g) => byGroup.get(g)!);
}

const EDITABLE_ROLES: EditableRole[] = ROLES.filter((r): r is EditableRole => r !== 'owner');

const rk = (role: string, perm: string) => `${role}::${perm}`;
const uk = (userId: string, perm: string) => `${userId}::${perm}`;

// Single reused toast id so rapid toggles update ONE bottom-right toast
// (Saving… → Saved / error) instead of stacking — and it's visible no matter
// how far down the (long) matrix you've scrolled.
const SAVE_TOAST = 'perm-save';

export function RolePermissionMatrix({ roleOverrides, userOverrides, members }: Props) {
  const groups = React.useMemo(() => groupedPermissions(), []);

  // Override maps keyed for O(1) lookup. Value = granted (true/false). Absent = no override.
  const [roleMap, setRoleMap] = React.useState<Map<string, boolean>>(
    () => new Map(roleOverrides.filter((o) => o.role).map((o) => [rk(o.role!, o.permission), o.granted])),
  );
  const [userMap, setUserMap] = React.useState<Map<string, boolean>>(
    () => new Map(userOverrides.filter((o) => o.user_id).map((o) => [uk(o.user_id!, o.permission), o.granted])),
  );

  const [isSaving, startTransition] = React.useTransition();
  const [busy, setBusy] = React.useState<Set<string>>(new Set());

  // Save confirmation. Each toggle saves instantly; on success we flash a
  // transient "Saved" so the change is visibly confirmed (errors already toast
  // + revert). aria-live announces it for screen readers.
  const [justSaved, setJustSaved] = React.useState(false);
  const savedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSaved = React.useCallback(() => {
    setJustSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setJustSaved(false), 2000);
  }, []);
  React.useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const selectableMembers = members.filter((m) => m.role !== 'owner');
  const [selectedUserId, setSelectedUserId] = React.useState<string>(
    () => selectableMembers[0]?.userId ?? '',
  );
  const selectedMember = selectableMembers.find((m) => m.userId === selectedUserId) ?? null;

  function markBusy(key: string, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  // ── Role cell toggle ─────────────────────────────────────────────────────
  function toggleRole(role: EditableRole, perm: Permission) {
    const key = rk(role, perm);
    const def = hasPermission(role, perm);
    const current = roleMap.has(key) ? roleMap.get(key)! : def;
    const next = !current;
    // ALWAYS persist the explicit choice (true/false) — never clear the row.
    // Clearing is a DELETE, and Supabase Realtime delivers DELETE events
    // unreliably (RLS can't authorize a row that's already gone), so a revoke
    // wouldn't push live. An explicit granted=false is an INSERT/UPDATE, which
    // pushes reliably. effectivePermissions treats granted=false === default as
    // a no-op, so persisting a "matches default" row is harmless.
    const granted = next;

    const prevMap = roleMap;
    const optimistic = new Map(prevMap);
    optimistic.set(key, granted);
    setRoleMap(optimistic);
    markBusy(key, true);
    toast.loading('Saving…', { id: SAVE_TOAST });

    startTransition(async () => {
      const res = await setRolePermissionOverrideAction({ role, permission: perm, granted });
      markBusy(key, false);
      if (!res.ok) {
        setRoleMap(prevMap); // revert
        toast.error(res.error.message, { id: SAVE_TOAST });
      } else {
        flashSaved();
        toast.success('Saved', { id: SAVE_TOAST, duration: 1500 });
      }
    });
  }

  // ── User cell toggle ─────────────────────────────────────────────────────
  function toggleUser(member: MemberLite, perm: Permission) {
    const key = uk(member.userId, perm);
    // Baseline = the member's ROLE-effective permission (role defaults + role overrides).
    const roleEff = roleEffectiveSet(member.role, roleMap);
    const base = roleEff.has(perm);
    const current = userMap.has(key) ? userMap.get(key)! : base;
    const next = !current;
    // Always persist the explicit choice (see toggleRole — avoids DELETE so the
    // change pushes live over realtime).
    const granted = next;

    const prevMap = userMap;
    const optimistic = new Map(prevMap);
    optimistic.set(key, granted);
    setUserMap(optimistic);
    markBusy(key, true);
    toast.loading('Saving…', { id: SAVE_TOAST });

    startTransition(async () => {
      const res = await setUserPermissionOverrideAction({
        userId: member.userId,
        permission: perm,
        granted,
      });
      markBusy(key, false);
      if (!res.ok) {
        setUserMap(prevMap);
        toast.error(res.error.message, { id: SAVE_TOAST });
      } else {
        flashSaved();
        toast.success('Saved', { id: SAVE_TOAST, duration: 1500 });
      }
    });
  }

  // ── Auditor preset (bulk viewer grants) ──────────────────────────────────
  const [presetBusy, setPresetBusy] = React.useState(false);
  function applyAuditorPreset() {
    // Matches the repo's confirm pattern for one-click bulk/destructive
    // settings actions (webhooks/api-keys panels use window.confirm too).
    const confirmed = window.confirm(
      'Apply the Auditor preset? This grants the Read-Only Auditor (Viewer) role read access to every reporting and operations surface, plus item and report CSV exports. Individual toggles can still be changed afterward.',
    );
    if (!confirmed) return;
    setPresetBusy(true);
    toast.loading('Applying Auditor preset…', { id: SAVE_TOAST });
    startTransition(async () => {
      const res = await applyAuditorPresetAction();
      setPresetBusy(false);
      if (!res.ok) {
        toast.error(res.error.message, { id: SAVE_TOAST });
      } else {
        // Reflect the persisted grants locally so the viewer column's boxes
        // check immediately — same optimistic-map shape the single toggles
        // maintain (granted=true rows now exist for each preset permission).
        setRoleMap((prev) => {
          const next = new Map(prev);
          for (const perm of AUDITOR_PRESET_PERMISSIONS) next.set(rk('viewer', perm), true);
          return next;
        });
        flashSaved();
        toast.success('Auditor preset applied', { id: SAVE_TOAST, duration: 1500 });
      }
    });
  }

  // Compute a role's effective set from defaults + the current role override map.
  function roleEffectiveSet(role: Role, map: Map<string, boolean>): Set<Permission> {
    if (role === 'owner') return new Set<Permission>(PERMISSIONS);
    const overrides = PERMISSIONS.flatMap((perm) => {
      const key = rk(role, perm);
      return map.has(key) ? [{ permission: perm, granted: map.get(key)! }] : [];
    });
    return effectivePermissions(role, overrides);
  }

  return (
    <div className="space-y-10">
      {/* ── Role matrix ──────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Permissions by role</h2>
          <div className="flex shrink-0 items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={applyAuditorPreset}
              disabled={presetBusy}
            >
              {presetBusy ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Applying…
                </>
              ) : (
                'Apply Auditor preset'
              )}
            </Button>
            <SaveStatus isSaving={isSaving} justSaved={justSaved} />
          </div>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Toggle a box to grant or revoke a permission for an entire role. Changes save instantly.
          A dot marks a permission you&apos;ve changed from its default. Owner always has every
          permission and can&apos;t be edited.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Apply Auditor preset: grants the Read-Only Auditor role read access to every reporting
          and operations surface, plus item and report CSV exports. Individual toggles can still
          be changed afterward.
        </p>
        <Legend />

        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[680px] text-[12.5px]">
            <thead className="bg-muted/40">
              <tr>
                <th className="sticky left-0 z-10 bg-muted/40 px-4 py-2 text-left font-medium text-[var(--ed-ink-3)]">
                  Permission
                </th>
                {ROLES.map((r) => (
                  <th key={r} className="px-3 py-2 text-center font-medium text-[var(--ed-ink-3)]">
                    {ROLE_DEFINITIONS[r].name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <React.Fragment key={g.group}>
                  <tr className="border-t border-border bg-background">
                    <td
                      colSpan={1 + ROLES.length}
                      className="bg-background px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--ed-ink-4)]"
                    >
                      {g.group}
                    </td>
                  </tr>
                  {g.permissions.map((p) => (
                    <tr key={p.id} className="border-t border-border hover:bg-muted/30">
                      <th
                        scope="row"
                        className="sticky left-0 z-10 bg-background px-4 py-2 text-left align-top font-normal"
                        title={`${p.description}\n(${p.id})`}
                      >
                        <div className="text-foreground">{p.label}</div>
                        <div className="mt-0.5 hidden text-[11px] text-muted-foreground sm:block">
                          {p.description}
                        </div>
                      </th>
                      {/* Owner: always on, disabled. */}
                      <td className="px-3 py-2 text-center align-middle">
                        <Check className="mx-auto h-4 w-4 text-[var(--ed-ink-4)]/50" aria-label="Owner always has this" />
                      </td>
                      {EDITABLE_ROLES.map((role) => {
                        const key = rk(role, p.id);
                        const def = hasPermission(role, p.id);
                        const eff = roleMap.has(key) ? roleMap.get(key)! : def;
                        // "Changed from default" — a persisted row that matches
                        // the default (after a toggle back) is NOT a change.
                        const overridden = roleMap.has(key) && roleMap.get(key) !== def;
                        const isRollingOutGrant = eff && !def && !FULLY_GRANTABLE_PERMISSIONS.has(p.id);
                        return (
                          <td key={role} className="px-3 py-2 text-center align-middle">
                            <Cell
                              checked={eff}
                              overridden={overridden}
                              rollingOut={isRollingOutGrant}
                              busy={busy.has(key)}
                              label={`${ROLE_DEFINITIONS[role].name} — ${p.label}`}
                              onToggle={() => toggleRole(role, p.id)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Per-user exceptions ──────────────────────────────────────── */}
      {selectableMembers.length > 0 && (
        <section>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Per-user exceptions</h2>
            <SaveStatus isSaving={isSaving} justSaved={justSaved} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Override a single person&apos;s access on top of their role. A user exception always
            wins over the role setting.
          </p>

          <div className="mt-3 max-w-sm">
            <label htmlFor="perm-user" className="text-xs font-medium">
              Member
            </label>
            <select
              id="perm-user"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {selectableMembers.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} · {ROLE_DEFINITIONS[m.role].name}
                </option>
              ))}
            </select>
          </div>

          {selectedMember && (
            <div className="mt-4 overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[480px] text-[12.5px]">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-[var(--ed-ink-3)]">
                      Permission
                    </th>
                    <th className="px-3 py-2 text-center font-medium text-[var(--ed-ink-3)]">
                      {selectedMember.name}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const roleEff = roleEffectiveSet(selectedMember.role, roleMap);
                    return (
                      <React.Fragment key={g.group}>
                        <tr className="border-t border-border bg-background">
                          <td
                            colSpan={2}
                            className="bg-background px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--ed-ink-4)]"
                          >
                            {g.group}
                          </td>
                        </tr>
                        {g.permissions.map((p) => {
                          const key = uk(selectedMember.userId, p.id);
                          const base = roleEff.has(p.id);
                          const eff = userMap.has(key) ? userMap.get(key)! : base;
                          const overridden = userMap.has(key) && userMap.get(key) !== base;
                          const isRollingOutGrant =
                            eff && !base && !FULLY_GRANTABLE_PERMISSIONS.has(p.id);
                          return (
                            <tr key={p.id} className="border-t border-border hover:bg-muted/30">
                              <th
                                scope="row"
                                className="px-4 py-2 text-left align-middle font-normal text-foreground"
                                title={`${p.description}\n(${p.id})`}
                              >
                                {p.label}
                              </th>
                              <td className="px-3 py-2 text-center align-middle">
                                <Cell
                                  checked={eff}
                                  overridden={overridden}
                                  rollingOut={isRollingOutGrant}
                                  busy={busy.has(key)}
                                  label={`${selectedMember.name} — ${p.label}`}
                                  onToggle={() => toggleUser(selectedMember, p.id)}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Cell({
  checked,
  overridden,
  rollingOut,
  busy,
  label,
  onToggle,
}: {
  checked: boolean;
  overridden: boolean;
  rollingOut: boolean;
  busy: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span className="relative inline-flex items-center justify-center">
      {busy ? (
        // Saving THIS box — show a spinner right where the click happened, so
        // the save is visible even when the header status is scrolled away.
        <Loader2
          className="h-4 w-4 animate-spin text-[hsl(var(--accent))]"
          aria-label={`Saving ${label}`}
        />
      ) : (
        <input
          type="checkbox"
          checked={checked}
          aria-label={label}
          onChange={onToggle}
          className="h-4 w-4 cursor-pointer rounded border-border accent-[hsl(var(--accent))]"
        />
      )}
      {overridden && !busy && (
        <span
          className="absolute -right-2 -top-1 h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]"
          aria-label="Changed from default"
          title="Changed from default"
        />
      )}
      {rollingOut && !busy && (
        <span
          className="absolute -right-4 top-0"
          title="Granted at the app level. Full data-write access for this permission is rolling out — purchase orders are already fully enabled."
        >
          <AlertTriangle
            className="h-3 w-3 text-amber-500"
            aria-label="Grant takes full effect after the row-level enforcement rollout"
          />
        </span>
      )}
    </span>
  );
}

function SaveStatus({ isSaving, justSaved }: { isSaving: boolean; justSaved: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 text-[11px]"
      aria-live="polite"
    >
      {isSaving ? (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Saving…
        </span>
      ) : justSaved ? (
        <span className="inline-flex items-center gap-1.5 text-[hsl(var(--accent))]">
          <Check className="h-3 w-3" /> Saved
        </span>
      ) : (
        <span className="text-[var(--ed-ink-4)]">Changes save automatically</span>
      )}
    </span>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" /> Changed from default
      </span>
      <span className="inline-flex items-center gap-1.5">
        <AlertTriangle className="h-3 w-3 text-amber-500" /> Grant rolling out (app-level today)
      </span>
      <span className="inline-flex items-center gap-1.5">
        <RotateCcw className="h-3 w-3" /> Toggle back to default to clear an override
      </span>
    </div>
  );
}
