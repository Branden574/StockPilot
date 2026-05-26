import { Check, Minus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import {
  PERMISSIONS,
  PERMISSION_META,
  PERMISSION_GROUP_ORDER,
  ROLES,
  ROLE_DEFINITIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  type Permission,
  type Role,
} from '@stockpilot/core';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { requireOrgContext } from '@/lib/auth/session';

interface GroupedRow {
  group: string;
  permissions: Array<{ id: Permission; label: string; description: string }>;
}

/**
 * Groups permissions by their `group` and orders groups by
 * PERMISSION_GROUP_ORDER (any unknown group is appended alphabetically).
 * Inside a group, permissions stay in the order they appear in the
 * PERMISSIONS tuple — which already reads naturally (read first, then
 * write, then admin-only).
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
  const extras = [...byGroup.keys()]
    .filter((g) => !PERMISSION_GROUP_ORDER.includes(g))
    .sort();
  return [...known, ...extras].map((g) => byGroup.get(g)!);
}

export default async function RolesPage() {
  const ctx = await requireOrgContext();
  const groups = groupedPermissions();
  const myRole = ctx.role;
  const myPermissions = ROLE_PERMISSIONS[myRole];

  // Group the current user's permissions for the "Your role can:" panel.
  const myGrouped = groupedPermissions()
    .map((g) => ({
      ...g,
      permissions: g.permissions.filter((p) => myPermissions.includes(p.id)),
    }))
    .filter((g) => g.permissions.length > 0);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/dashboard/settings" className="hover:text-foreground">
          Settings
        </Link>
        <span>/</span>
        <span>Roles &amp; permissions</span>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Roles &amp; permissions</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        A reference for who can do what in StockPilot. Roles are assigned per
        organization member. Owner &gt; Admin &gt; Manager &gt; Staff &gt; Viewer.
      </p>

      {/* "Your role can:" panel */}
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-4 w-4 text-[hsl(var(--accent))]" />
            <CardTitle className="text-base">
              You&apos;re signed in as{' '}
              <span className="font-mono">{ROLE_DEFINITIONS[myRole].name}</span>
            </CardTitle>
          </div>
          <span className="rounded-full border border-border bg-background px-2.5 py-0.5 font-mono text-[11px] text-[var(--ed-ink-2)]">
            {myPermissions.length} permission{myPermissions.length === 1 ? '' : 's'}
          </span>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            {ROLE_DEFINITIONS[myRole].description}
          </p>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {myGrouped.map((g) => (
              <div key={g.group} className="min-w-0">
                <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
                  {g.group}
                </div>
                <ul className="mt-1 space-y-0.5 text-[12.5px]">
                  {g.permissions.map((p) => (
                    <li key={p.id} className="flex items-start gap-1.5">
                      <Check className="mt-0.5 h-3 w-3 shrink-0 text-[hsl(var(--accent))]" />
                      <span>{p.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Full matrix */}
      <h2 className="mt-10 text-lg font-semibold">All roles at a glance</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Checkmark means the role has that permission. Hover any permission for a description.
      </p>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <caption className="sr-only">
            Roles and permissions matrix. Rows are permissions grouped by feature.
            Columns are the five roles: Owner, Admin, Manager, Staff, Viewer.
          </caption>
          <thead className="bg-muted/40">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 bg-muted/40 px-4 py-2 text-left font-medium text-[var(--ed-ink-3)]"
              >
                Permission
              </th>
              {ROLES.map((r) => (
                <th
                  key={r}
                  scope="col"
                  className={cn(
                    'px-3 py-2 text-center font-medium',
                    r === myRole ? 'text-foreground' : 'text-[var(--ed-ink-3)]',
                  )}
                >
                  {ROLE_DEFINITIONS[r].name}
                  {r === myRole && (
                    <span className="ml-1 align-middle text-[10px] font-normal text-[hsl(var(--accent))]">
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

      <p className="mt-4 text-[11.5px] text-muted-foreground">
        Need a role changed? Owners and Admins can update roles from the{' '}
        <a href="/dashboard/team" className="font-medium text-foreground hover:underline">
          team page
        </a>
        .
      </p>
    </div>
  );
}

function RoleGroupRows({ group, myRole }: { group: GroupedRow; myRole: Role }) {
  return (
    <>
      <tr className="border-t border-border bg-background">
        <td
          colSpan={1 + ROLES.length}
          className="bg-background px-4 py-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--ed-ink-4)]"
        >
          {group.group}
        </td>
      </tr>
      {group.permissions.map((p) => (
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
          {ROLES.map((r) => {
            const granted = hasPermission(r, p.id);
            return (
              <td
                key={r}
                className={cn(
                  'px-3 py-2 text-center align-top',
                  r === myRole && 'bg-[hsl(var(--accent)/0.08)]',
                )}
              >
                {granted ? (
                  <>
                    <Check
                      className={cn(
                        'mx-auto h-4 w-4',
                        r === myRole
                          ? 'text-[hsl(var(--accent))]'
                          : 'text-[var(--ed-ink-2)]',
                      )}
                      aria-hidden="true"
                    />
                    <span className="sr-only">
                      {ROLE_DEFINITIONS[r].name} can {p.label}
                    </span>
                  </>
                ) : (
                  <>
                    <Minus
                      className="mx-auto h-3.5 w-3.5 text-[var(--ed-ink-4)]/40"
                      aria-hidden="true"
                    />
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
