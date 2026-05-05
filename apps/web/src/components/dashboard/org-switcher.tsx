'use client';

import { Check, ChevronDown, Loader2 } from 'lucide-react';
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
import { switchOrganizationAction } from '@/server/actions/org-switcher';

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
 * Sidebar org pill — interactive when the user belongs to >1 org,
 * otherwise renders as a static label so single-org users (the common
 * case for L4L right now) don't see a useless dropdown caret.
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

  if (single) {
    return (
      <div
        role="presentation"
        className="border-border bg-card mx-3 mt-3 flex items-center gap-2 rounded-md border px-2.5 py-2 text-[12px] text-[var(--ed-ink-2)]"
      >
        {active.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={active.logoUrl}
            alt=""
            aria-hidden
            className="h-4 w-4 shrink-0 rounded-[3px] object-cover"
          />
        ) : (
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />
        )}
        <span className="flex-1 truncate text-left">
          <span className="sr-only">Organization: </span>
          {active.name}
        </span>
        <ChevronDown aria-hidden className="h-3 w-3 opacity-30" />
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        className="border-border bg-card mx-3 mt-3 flex items-center gap-2 rounded-md border px-2.5 py-2 text-[12px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)] focus-visible:outline-2 focus-visible:outline-foreground/40 disabled:opacity-60"
        aria-label="Switch organization"
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : active.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={active.logoUrl}
            alt=""
            aria-hidden
            className="h-4 w-4 shrink-0 rounded-[3px] object-cover"
          />
        ) : (
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />
        )}
        <span className="flex-1 truncate text-left">{active.name}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        <DropdownMenuLabel className="text-muted-foreground text-[10px] uppercase tracking-wider">
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
              <Check className="h-3.5 w-3.5" />
            ) : (
              <span className="inline-block h-3.5 w-3.5" />
            )}
            {o.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={o.logoUrl} alt="" className="h-4 w-4 shrink-0 rounded-[3px] object-cover" />
            ) : (
              <span className="bg-muted inline-block h-4 w-4 shrink-0 rounded-[3px]" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{o.name}</div>
              <div className="text-muted-foreground text-[10.5px] capitalize">
                {o.role}
              </div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
