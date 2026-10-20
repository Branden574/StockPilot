'use client';

import { Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { userMenuRoleLabel } from '@/lib/auth/user-menu-role';
import { switchOrganizationAction } from '@/server/actions/org-switcher';

import { ROLE_LABELS, type Role } from '@stockpilot/core';

export interface OrgMembership {
  id: string;
  name: string;
  logoUrl: string | null;
  role: string;
}

interface OrgSwitcherProps {
  orgs: OrgMembership[];
  activeId: string;
}

/**
 * The role a membership row carries, in the words the rest of the app uses
 * (the sidebar foot and the account menu: "Super Admin (Owner)", "Warehouse
 * User", "Read-Only Auditor"), not the raw database token. A token this build
 * does not know is shown as it is rather than hidden.
 */
export function membershipRoleLabel(role: string): string {
  return Object.hasOwn(ROLE_LABELS, role) ? userMenuRoleLabel(role as Role) : role;
}

/**
 * Sidebar org selector: a full-width control under the brand row. Interactive
 * when the user belongs to >1 org, otherwise a static label so single-org
 * users (the common case for L4L right now) don't see a useless menu.
 *
 * The name is in the ink, as the reference's switcher draws it (DESIGN-SPEC
 * 5.1; FX12: it was ink 2). Only the name: the row keeps ink 2, so the static
 * row's faint chevron and the button's loading spinner keep their colours.
 */
export function OrgSwitcher({ orgs, activeId }: OrgSwitcherProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];
  const single = orgs.length <= 1;

  function pick(id: string) {
    if (id === activeId) return;
    startTransition(async () => {
      const res = await switchOrganizationAction({ organizationId: id });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      router.replace('/dashboard');
      router.refresh();
    });
  }

  if (!active) return null;

  const mark = active.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={active.logoUrl}
      alt=""
      aria-hidden
      className="size-4 shrink-0 rounded-[3px] object-cover"
    />
  ) : (
    <span aria-hidden className="bg-accent size-1.5 shrink-0 rounded-full" />
  );

  if (single) {
    return (
      <div
        role="presentation"
        className="border-border bg-card flex h-[34px] w-full items-center gap-2 rounded-md border px-2.5 text-[13px] text-[var(--ed-ink-2)]"
      >
        {mark}
        <span className="text-foreground min-w-0 flex-1 truncate text-left">
          <span className="sr-only">Organization: </span>
          {active.name}
        </span>
        <ChevronsUpDown aria-hidden className="size-3 shrink-0 opacity-30" />
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        className="border-border bg-card flex h-[34px] w-full items-center gap-2 rounded-md border px-2.5 text-[13px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)] disabled:opacity-60"
        aria-label="Switch organization"
      >
        {pending ? <Loader2 aria-hidden className="size-3 shrink-0 animate-spin" /> : mark}
        <span className="text-foreground min-w-0 flex-1 truncate text-left">{active.name}</span>
        <ChevronsUpDown
          aria-hidden
          strokeWidth={2}
          className="text-muted-foreground size-3 shrink-0"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        <DropdownMenuLabel className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
          Switch organization
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {orgs.map((o) => (
          <DropdownMenuItem
            key={o.id}
            onSelect={() => pick(o.id)}
            className="flex items-center gap-2"
          >
            {o.id === activeId ? (
              <Check aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <span aria-hidden className="inline-block size-3.5 shrink-0" />
            )}
            {o.logoUrl ? (
              <Image
                src={o.logoUrl}
                alt=""
                width={32}
                height={32}
                sizes="16px"
                className="size-4 shrink-0 rounded-[3px] object-cover"
              />
            ) : (
              <span aria-hidden className="bg-sunk inline-block size-4 shrink-0 rounded-[3px]" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{o.name}</div>
              <div className="text-muted-foreground text-[11.5px]">
                {membershipRoleLabel(o.role)}
              </div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
