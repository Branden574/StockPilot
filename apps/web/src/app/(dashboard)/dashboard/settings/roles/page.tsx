import { Check, Lock, Minus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import {
  ORDER_ITEMS_ROLES_LOCK_NOTE_COPY,
  PERMISSIONS,
  PERMISSION_META,
  PERMISSION_GROUP_ORDER,
  ROLES,
  ROLE_DEFINITIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  isAdminRole,
  isPlatformManagedPermission,
  withoutPlatformManaged,
  type Permission,
  type Role,
} from '@stockpilot/core';

import { PageHeader } from '@/components/patterns/page-header';
import {
  RolePermissionMatrix,
  type MemberLite,
  type PermOverrideRow,
} from '@/components/settings/role-permission-matrix';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-nav';
import { cn } from '@/lib/utils';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

interface GroupedRow {
  group: string;
  permissions: Array<{ id: Permission; label: string; description: string }>;
}

/**
 * Groups permissions by their `group` and orders groups by
 * PERMISSION_GROUP_ORDER (any unknown group is appended alphabetically).
 */
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

export default async function RolesPage() {
  const ctx = await requireOrgContext();
  const groups = groupedPermissions();
  const myRole = ctx.role;
  const canConfigure = isAdminRole(myRole);

  // The "Your role can:" panel reflects the caller's EFFECTIVE permissions
  // (overrides applied), not just the static role defaults. The static
  // fallback drops platform-managed keys (0413): without the member's own rows
  // nobody can tell whether StockPilot denied it, the core rule for every
  // fallback set.
  const myPermissions: Permission[] = ctx.permissions
    ? [...ctx.permissions]
    : [...withoutPlatformManaged(new Set(ROLE_PERMISSIONS[myRole]))];
  const myPermSet = new Set(myPermissions);

  const myGrouped = groupedPermissions()
    .map((g) => ({
      ...g,
      permissions: g.permissions.filter((p) => myPermSet.has(p.id)),
    }))
    .filter((g) => g.permissions.length > 0);

  // Admins/owners get the editable matrix — load the org's override rows + members.
  let roleOverrides: PermOverrideRow[] = [];
  let userOverrides: PermOverrideRow[] = [];
  let members: MemberLite[] = [];
  if (canConfigure) {
    const supabase = await createClient();
    const [roRes, uoRes, memRes] = await Promise.all([
      supabase
        .from('role_permission_overrides')
        .select('role, permission, granted')
        .eq('organization_id', ctx.organizationId),
      supabase
        .from('user_permission_overrides')
        .select('user_id, permission, granted')
        .eq('organization_id', ctx.organizationId),
      supabase
        .from('organization_members')
        .select('user_id, role, user:user_id (full_name, email)')
        .eq('organization_id', ctx.organizationId)
        .not('accepted_at', 'is', null),
    ]);
    // The matrix draws every role and member from these rows. Without them it
    // would show every role at its defaults: a permission the organization
    // took away would read as granted, and an edit would start from there. So
    // a failed read throws to the settings boundary, which offers Try again
    // (docket S19). An answer with no error that is not a list (postgrest-js
    // resolves an empty body with data null) has failed too. The owner still
    // reaches this page while the reads fail.
    // Codes only: the PostgREST message can quote request details.
    const failed = (
      [
        ['role_permission_overrides', roRes],
        ['user_permission_overrides', uoRes],
        ['organization_members', memRes],
      ] as const
    ).filter(([, res]) => res.error || !Array.isArray(res.data));
    if (failed.length > 0) {
      console.error(
        '[settings/roles] read failed:',
        failed
          .map(
            ([table, res]) =>
              `${table} code=${res.error ? res.error.code || 'unknown' : 'unexpected'} status=${res.status}`,
          )
          .join('; '),
      );
      throw new Error('The permission overrides or the members could not be read.');
    }
    roleOverrides = (roRes.data ?? []) as PermOverrideRow[];
    userOverrides = (uoRes.data ?? []) as PermOverrideRow[];
    members = (
      (memRes.data ?? []) as Array<{
        user_id: string;
        role: Role;
        user: { full_name?: string | null; email?: string | null } | null;
      }>
    ).map((m) => ({
      userId: m.user_id,
      role: m.role,
      name: m.user?.full_name || m.user?.email || 'Member',
    }));
  }

  return (
    <SettingsPage width="wide">
      <PageHeader
        title="Roles & permissions"
        subline={
          canConfigure
            ? 'Grant or revoke what each role — and individual members — can do across StockPilot. Owner > Admin > Manager > Staff > Viewer.'
            : 'A reference for who can do what in StockPilot. Roles are assigned per organization member. Owner > Admin > Manager > Staff > Viewer.'
        }
        back={
          <div className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
            <Link href="/dashboard/settings" className="hover:text-foreground transition-colors">
              Settings
            </Link>
            <span aria-hidden className="text-ink-4">
              /
            </span>
            <span>Roles &amp; permissions</span>
          </div>
        }
      />

      {/* "Your role can:" panel */}
      <SettingsPanel
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck aria-hidden className="text-accent h-4 w-4 shrink-0" />
            <span>
              You&apos;re signed in as{' '}
              <span className="font-mono">{ROLE_DEFINITIONS[myRole].name}</span>
            </span>
          </span>
        }
        description={ROLE_DEFINITIONS[myRole].description}
        aside={
          <span className="border-line-strong bg-sunk text-ink-2 rounded-full border px-2.5 py-px font-mono text-[11px] leading-[18px]">
            {myPermissions.length} permission{myPermissions.length === 1 ? '' : 's'}
          </span>
        }
      >
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {myGrouped.map((g) => (
            <div key={g.group} className="min-w-0">
              <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
                {g.group}
              </div>
              <ul className="mt-1.5 space-y-1 text-[12.5px]">
                {g.permissions.map((p) => (
                  <li key={p.id} className="flex items-start gap-1.5">
                    <Check aria-hidden className="text-accent mt-0.5 h-3 w-3 shrink-0" />
                    <span>{p.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </SettingsPanel>

      {/* Editable matrix for admins/owners; read-only reference for everyone else. */}
      {canConfigure ? (
        <RolePermissionMatrix
          roleOverrides={roleOverrides}
          userOverrides={userOverrides}
          members={members}
        />
      ) : (
        // The matrix's scroll area is the region named All roles at a glance
        // (its rows hold no control, so it is a Tab stop); the card around it
        // stays unnamed, so the page lists that name once.
        <SettingsPanel
          title="All roles at a glance"
          landmark={false}
          description="Checkmark means the role has that permission. Hover any permission for a description."
          flush
        >
          <div
            role="region"
            aria-label="All roles at a glance"
            tabIndex={0}
            className="overflow-x-auto focus-visible:ring-inset focus-visible:ring-offset-0"
          >
            <table className="w-full min-w-[640px] text-[12.5px]">
              <caption className="sr-only">
                Roles and permissions matrix. Rows are permissions grouped by feature. Columns are
                the five roles: Owner, Admin, Manager, Staff, Viewer.
              </caption>
              <thead>
                <tr className="border-border border-b">
                  <th
                    scope="col"
                    className="bg-card text-muted-foreground sticky left-0 z-10 px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.06em]"
                  >
                    Permission
                  </th>
                  {ROLES.map((r) => (
                    <th
                      key={r}
                      scope="col"
                      className={cn(
                        'px-3 py-2.5 text-center text-[11px] font-medium uppercase tracking-[0.06em]',
                        r === myRole ? 'text-foreground bg-muted' : 'text-muted-foreground',
                      )}
                    >
                      {ROLE_DEFINITIONS[r].name}
                      {r === myRole && (
                        <span className="text-accent ml-1 align-middle text-[10px] font-normal normal-case tracking-normal">
                          you
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <RoleGroupRows key={g.group} group={g} myRole={myRole} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground border-border border-t px-[18px] py-3 text-[12px]">
            Need a role changed? Owners and Admins can update roles from the{' '}
            <a href="/dashboard/team" className="text-foreground font-medium hover:underline">
              team page
            </a>
            .
          </p>
        </SettingsPanel>
      )}
    </SettingsPage>
  );
}

function RoleGroupRows({ group, myRole }: { group: GroupedRow; myRole: Role }) {
  return (
    <>
      <tr className="border-border bg-sunk border-b">
        <td
          colSpan={1 + ROLES.length}
          className="text-muted-foreground px-4 py-2 text-[10.5px] font-medium uppercase tracking-[0.08em]"
        >
          {group.group}
        </td>
      </tr>
      {group.permissions.map((p) => (
        <tr key={p.id} className="border-border hover:bg-muted group/row border-b last:border-b-0">
          <th
            scope="row"
            className="bg-card group-hover/row:bg-muted sticky left-0 z-10 px-4 py-2.5 text-left align-top font-normal"
            title={`${p.description}\n(${p.id})`}
          >
            <div className="text-foreground">{p.label}</div>
            <div className="text-muted-foreground mt-0.5 text-[11.5px]">{p.description}</div>
            {isPlatformManagedPermission(p.id) ? (
              // A role's box here is its DEFAULT; StockPilot support can
              // allow or deny it for one member (0413).
              <div className="text-muted-foreground mt-0.5 flex items-start gap-1 text-[11.5px]">
                <Lock aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{ORDER_ITEMS_ROLES_LOCK_NOTE_COPY}</span>
              </div>
            ) : null}
          </th>
          {ROLES.map((r) => {
            const granted = hasPermission(r, p.id);
            return (
              <td
                key={r}
                className={cn('px-3 py-2.5 text-center align-top', r === myRole && 'bg-muted/60')}
              >
                {granted ? (
                  <>
                    <Check
                      className={cn('mx-auto h-4 w-4', r === myRole ? 'text-accent' : 'text-ink-2')}
                      aria-hidden="true"
                    />
                    <span className="sr-only">
                      {ROLE_DEFINITIONS[r].name} can {p.label}
                    </span>
                  </>
                ) : (
                  <>
                    <Minus className="text-ink-4 mx-auto h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">
                      {ROLE_DEFINITIONS[r].name} cannot {p.label}
                    </span>
                  </>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
