'use client';

import { AlertTriangle, Check, Loader2, RotateCcw } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import {
  applyAuditorPresetAction,
  setRolePermissionOverrideAction,
  setUserPermissionOverrideAction,
} from '@/server/actions/permissions';

import { SettingsPanel } from '@/components/settings/settings-nav';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { AUDITOR_PRESET_PERMISSIONS } from '@/lib/auditor-preset';
import { cn } from '@/lib/utils';

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

/** Put one cell back as it was before its save: its old value, or no row at all. */
function revertKey(
  map: Map<string, boolean>,
  key: string,
  hadOverride: boolean,
  previous: boolean | undefined,
): Map<string, boolean> {
  const next = new Map(map);
  if (hadOverride && previous !== undefined) next.set(key, previous);
  else next.delete(key);
  return next;
}
const uk = (userId: string, perm: string) => `${userId}::${perm}`;

// Single reused toast id so rapid toggles update ONE bottom-right toast
// (Saving… → Saved / error) instead of stacking — and it's visible no matter
// how far down the (long) matrix you've scrolled.
const SAVE_TOAST = 'perm-save';

export function RolePermissionMatrix({ roleOverrides, userOverrides, members }: Props) {
  const groups = React.useMemo(() => groupedPermissions(), []);

  // Override maps keyed for O(1) lookup. Value = granted (true/false). Absent = no override.
  const [roleMap, setRoleMap] = React.useState<Map<string, boolean>>(
    () =>
      new Map(
        roleOverrides.filter((o) => o.role).map((o) => [rk(o.role!, o.permission), o.granted]),
      ),
  );
  const [userMap, setUserMap] = React.useState<Map<string, boolean>>(
    () =>
      new Map(
        userOverrides
          .filter((o) => o.user_id)
          .map((o) => [uk(o.user_id!, o.permission), o.granted]),
      ),
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
    if (busy.has(key)) return; // one save per cell at a time
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

    // Optimistic, and reverted for THIS cell only: a refused save must not
    // undo another cell that was toggled (and saved) while it was in flight.
    const hadOverride = roleMap.has(key);
    const previous = roleMap.get(key);
    setRoleMap((prev) => new Map(prev).set(key, granted));
    markBusy(key, true);
    toast.loading('Saving…', { id: SAVE_TOAST });

    startTransition(async () => {
      const res = await setRolePermissionOverrideAction({ role, permission: perm, granted });
      markBusy(key, false);
      if (!res.ok) {
        setRoleMap((prev) => revertKey(prev, key, hadOverride, previous)); // revert
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
    if (busy.has(key)) return; // one save per cell at a time
    // Baseline = the member's ROLE-effective permission (role defaults + role overrides).
    const roleEff = roleEffectiveSet(member.role, roleMap);
    const base = roleEff.has(perm);
    const current = userMap.has(key) ? userMap.get(key)! : base;
    const next = !current;
    // Always persist the explicit choice (see toggleRole — avoids DELETE so the
    // change pushes live over realtime).
    const granted = next;

    const hadOverride = userMap.has(key);
    const previous = userMap.get(key);
    setUserMap((prev) => new Map(prev).set(key, granted));
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
        setUserMap((prev) => revertKey(prev, key, hadOverride, previous));
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
    <>
      {/* ── Role matrix ──────────────────────────────────────────────── */}
      <SettingsPanel
        title="Permissions by role"
        description={
          <>
            <p>
              Toggle a box to grant or revoke a permission for an entire role. Changes save
              instantly. A dot marks a permission you&apos;ve changed from its default. Owner always
              has every permission and can&apos;t be edited.
            </p>
            <p className="mt-1">
              Apply Auditor preset: grants the Read-Only Auditor role read access to every reporting
              and operations surface, plus item and report CSV exports. Individual toggles can still
              be changed afterward.
            </p>
          </>
        }
        aside={
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <SaveStatus isSaving={isSaving} justSaved={justSaved} />
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
          </div>
        }
        flush
      >
        <Legend />
        <MatrixScroll label="Permissions by role">
          <table className="w-full min-w-[680px] text-[12.5px]">
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className={cn(HEAD_CELL, 'bg-card sticky left-0 z-10 text-left')}>
                  Permission
                </th>
                {ROLES.map((r) => (
                  <th key={r} scope="col" className={cn(HEAD_CELL, 'w-[88px] text-center')}>
                    {ROLE_DEFINITIONS[r].name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <React.Fragment key={g.group}>
                  <GroupRow label={g.group} span={1 + ROLES.length} />
                  {g.permissions.map((p) => (
                    <tr key={p.id} className={ROW}>
                      <th
                        scope="row"
                        className={cn(ROW_HEAD, 'sticky left-0 z-10')}
                        title={`${p.description}\n(${p.id})`}
                      >
                        <div className="text-foreground">{p.label}</div>
                        <div className="text-muted-foreground mt-0.5 text-[11.5px]">
                          {p.description}
                        </div>
                      </th>
                      {/* Owner: always on, disabled. */}
                      <td className={CELL}>
                        <Check
                          className="text-ink-4 mx-auto h-4 w-4"
                          aria-label="Owner always has this"
                        />
                      </td>
                      {EDITABLE_ROLES.map((role) => {
                        const key = rk(role, p.id);
                        const def = hasPermission(role, p.id);
                        const eff = roleMap.has(key) ? roleMap.get(key)! : def;
                        // "Changed from default" — a persisted row that matches
                        // the default (after a toggle back) is NOT a change.
                        const overridden = roleMap.has(key) && roleMap.get(key) !== def;
                        const isRollingOutGrant =
                          eff && !def && !FULLY_GRANTABLE_PERMISSIONS.has(p.id);
                        return (
                          <td key={role} className={CELL}>
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
        </MatrixScroll>
      </SettingsPanel>

      {/* ── Per-user exceptions ──────────────────────────────────────── */}
      {selectableMembers.length > 0 && (
        <SettingsPanel
          title="Per-user exceptions"
          description="Override a single person's access on top of their role. A user exception always wins over the role setting."
          aside={<SaveStatus isSaving={isSaving} justSaved={justSaved} />}
          flush
        >
          <div className="border-border border-b px-[18px] py-3.5">
            <div className="max-w-sm">
              <Label htmlFor="perm-user">Member</Label>
              <select
                id="perm-user"
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="border-line-strong bg-card focus-visible:ring-ring focus-visible:ring-offset-background mt-1.5 h-8 w-full rounded-md border px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 max-sm:h-11 max-sm:text-base"
              >
                {selectableMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name} · {ROLE_DEFINITIONS[m.role].name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {selectedMember && (
            <MatrixScroll label={`Permissions for ${selectedMember.name}`}>
              <table className="w-full min-w-[480px] text-[12.5px]">
                <thead>
                  <tr className="border-border border-b">
                    <th scope="col" className={cn(HEAD_CELL, 'text-left')}>
                      Permission
                    </th>
                    <th
                      scope="col"
                      className={cn(HEAD_CELL, 'w-[160px] text-center normal-case tracking-normal')}
                    >
                      {selectedMember.name}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const roleEff = roleEffectiveSet(selectedMember.role, roleMap);
                    return (
                      <React.Fragment key={g.group}>
                        <GroupRow label={g.group} span={2} />
                        {g.permissions.map((p) => {
                          const key = uk(selectedMember.userId, p.id);
                          const base = roleEff.has(p.id);
                          const eff = userMap.has(key) ? userMap.get(key)! : base;
                          const overridden = userMap.has(key) && userMap.get(key) !== base;
                          const isRollingOutGrant =
                            eff && !base && !FULLY_GRANTABLE_PERMISSIONS.has(p.id);
                          return (
                            <tr key={p.id} className={ROW}>
                              <th
                                scope="row"
                                className={cn(ROW_HEAD, 'align-middle')}
                                title={`${p.description}\n(${p.id})`}
                              >
                                <div className="text-foreground">{p.label}</div>
                              </th>
                              <td className={CELL}>
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
            </MatrixScroll>
          )}
        </SettingsPanel>
      )}
    </>
  );
}

// The matrices keep the comfortable density on every screen (no shrinking
// boxes): 20 px checkboxes in 44 px rows, 11 px uppercase column heads.
const HEAD_CELL =
  'text-muted-foreground px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.06em] first:px-4';
const ROW = 'border-border hover:bg-muted group/row border-b last:border-b-0';
const ROW_HEAD =
  'bg-card group-hover/row:bg-muted px-4 py-2.5 text-left align-top font-normal transition-colors';
const CELL = 'px-3 py-2.5 text-center align-middle';

/** A wide table's contained sideways scroll: a named, keyboard-reachable region. */
function MatrixScroll({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="overflow-x-auto focus-visible:ring-inset focus-visible:ring-offset-0"
    >
      {children}
    </div>
  );
}

function GroupRow({ label, span }: { label: string; span: number }) {
  return (
    <tr className="border-border bg-sunk border-b">
      <td
        colSpan={span}
        className="text-muted-foreground px-4 py-2 text-[10.5px] font-medium uppercase tracking-[0.08em]"
      >
        {label}
      </td>
    </tr>
  );
}

/**
 * One permission box. While its save is out the box stays where it is (so a
 * keyboard user keeps focus on it and Space cannot fire a second save) and a
 * spinner covers it; a refused save puts the old value back.
 */
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
    <span className="relative inline-grid place-items-center align-middle">
      <Checkbox
        checked={checked}
        label={label}
        aria-busy={busy || undefined}
        onCheckedChange={() => {
          if (!busy) onToggle();
        }}
        className={cn(busy && 'cursor-progress [&>span]:opacity-0')}
      />
      {busy && (
        // Saving THIS box — show a spinner right where the click happened, so
        // the save is visible even when the header status is scrolled away.
        <Loader2
          className="text-accent pointer-events-none absolute h-4 w-4 animate-spin"
          aria-label={`Saving ${label}`}
        />
      )}
      {overridden && !busy && (
        <span
          className="bg-accent absolute -right-2 -top-1 h-1.5 w-1.5 rounded-full"
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
            className="text-warning h-3 w-3"
            aria-label="Grant takes full effect after the row-level enforcement rollout"
          />
        </span>
      )}
    </span>
  );
}

function SaveStatus({ isSaving, justSaved }: { isSaving: boolean; justSaved: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px]" aria-live="polite">
      {isSaving ? (
        <span className="text-muted-foreground inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" /> Saving…
        </span>
      ) : justSaved ? (
        <span className="text-accent inline-flex items-center gap-1.5">
          <Check className="h-3 w-3" /> Saved
        </span>
      ) : (
        <span className="text-muted-foreground">Changes save automatically</span>
      )}
    </span>
  );
}

function Legend() {
  return (
    <div className="text-muted-foreground border-border flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b px-[18px] py-2.5 text-[12px]">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="bg-accent h-1.5 w-1.5 rounded-full" /> Changed from default
      </span>
      <span className="inline-flex items-center gap-1.5">
        <AlertTriangle aria-hidden className="text-warning h-3 w-3" /> Grant rolling out (app-level
        today)
      </span>
      <span className="inline-flex items-center gap-1.5">
        <RotateCcw aria-hidden className="h-3 w-3" /> Toggle back to default to clear an override
      </span>
    </div>
  );
}
