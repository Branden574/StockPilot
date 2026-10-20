'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { IntentLink } from '@/components/ui/intent-link';
import { cn } from '@/lib/utils';

import type { Permission } from '@stockpilot/core';

/**
 * The settings area's frame (matrix W-ST-01 and W-ST-01a): ONE gate table for
 * the grouped index on /dashboard/settings and the sub-nav on every page under
 * it, so the two can never disagree about who sees which destination.
 *
 * THE GATES ARE TODAY'S HUB TILE GATES, unchanged (owner decision O3: keep
 * visibility exactly as it is). Where a tile's gate and its page's gate differ
 * (settings.md section 7), the tile's rule is kept here on purpose; a page
 * still applies its own gate on the server.
 *
 * WHO DECIDES. The server does: the hub page and the settings layout resolve
 * `access` from the React-cached request context (`can(ctx, ...)` over every
 * permission) and the request-cached module set (`checkModuleAccess`), the
 * reads the dashboard layout and the settings pages make anyway. This module
 * only filters the table with that answer; it reads nothing.
 *
 * Every destination is a real link (`IntentLink`: an `<a href>` warmed on
 * intent, never prefetched on sight, so a page of 21 links costs no requests
 * until someone reaches for one). The Settings tour targets the hub tiles by
 * `a[href="/dashboard/settings/..."]`.
 */

export const SETTINGS_HUB_HREF = '/dashboard/settings';

export interface SettingsNavEntry {
  href: string;
  title: string;
  description: string;
  /** Shown only to a caller holding this permission (overrides applied). */
  permission?: Permission;
  /** Shown only while this module is on (Maintenance requests needs both gates). */
  module?: 'maintenance_requests';
  /** Other paths this destination stands for in the sub-nav. */
  alsoActiveFor?: readonly string[];
}

export interface SettingsNavGroup {
  id: string;
  label: string;
  entries: readonly SettingsNavEntry[];
}

/** What the server worked out for the caller; plain data, no reads here. */
export interface SettingsNavAccess {
  /** Every permission `can(ctx, p)` grants the caller. */
  permissions: readonly string[];
  /** The gated modules that are on for the organization. */
  modules: readonly 'maintenance_requests'[];
}

/**
 * The gate table. Titles and descriptions are the hub tiles' words, verbatim;
 * the groups are the settings area's proposal (settings.md section 10).
 */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  {
    id: 'account',
    label: 'Account',
    entries: [
      {
        href: '/dashboard/settings/profile',
        title: 'Profile',
        description: 'Your name, avatar, and sign-in email.',
      },
      {
        href: '/dashboard/settings/security',
        title: 'Security',
        description: 'Two-factor authentication and org MFA policy.',
      },
      {
        href: '/dashboard/settings/notifications',
        title: 'Notifications',
        description: 'Weekly digest email and preferences.',
      },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    entries: [
      {
        href: '/dashboard/settings/organization',
        title: 'Organization',
        description: 'Name, labels for charters and warehouses.',
      },
      {
        href: '/dashboard/settings/industry',
        title: 'Industry template',
        description:
          'Set up StockPilot for your industry in one click — Books, Distribution, Apparel, Food & Ag, or 3PL.',
        permission: 'organization:update',
      },
      {
        href: '/dashboard/settings/modules',
        title: 'Modules',
        description: 'Turn features on or off for your whole organization.',
        permission: 'organization:update',
      },
      {
        href: '/dashboard/settings/navigation',
        title: 'Navigation',
        description: 'Customize the sidebar — hide, rename, and reorder items or add custom links.',
        permission: 'organization:update',
      },
      {
        href: '/dashboard/settings/dashboard',
        title: 'Dashboard',
        description: 'Choose which cards appear on the dashboard and in what order.',
        permission: 'organization:update',
      },
      {
        href: '/dashboard/settings/custom-fields',
        title: 'Custom fields',
        description: 'Define extra item fields — warranty, voltage, color, and more.',
        permission: 'organization:update',
      },
      {
        href: '/dashboard/settings/order-statuses',
        title: 'Order statuses',
        description: 'Rename and recolor the status badges shown on order requests.',
        permission: 'organization:update',
      },
    ],
  },
  {
    id: 'access',
    label: 'Access',
    entries: [
      {
        href: '/dashboard/settings/roles',
        title: 'Roles & permissions',
        description: 'Reference for what each role can see and do across StockPilot.',
      },
      {
        href: '/dashboard/audit',
        title: 'Audit log',
        description: 'Every privileged action across the org.',
        permission: 'activity_logs:read',
      },
    ],
  },
  {
    id: 'requests',
    label: 'Requests and email',
    entries: [
      {
        href: '/dashboard/settings/public-requests',
        title: 'Public requests',
        description:
          'Shareable link external partners use to submit order requests — no account required.',
        permission: 'orders:approve',
      },
      {
        // Deliberately not module-gated: delivery requests belong to the core
        // orders module, and an unconfigured org's admins need this entry to
        // learn why their email actions are hidden.
        href: '/dashboard/settings/email-routing',
        title: 'Email routing',
        description:
          'Where delivery and maintenance request emails are addressed for your organization.',
        permission: 'organization:update',
      },
      {
        // Owner-only by default (configure is filtered out of admin's derived
        // set) AND only while the off-by-default module is on.
        href: '/dashboard/settings/maintenance',
        title: 'Maintenance requests',
        description: 'Categories, notification audiences, and photo link settings.',
        permission: 'maintenance_requests:configure',
        module: 'maintenance_requests',
      },
    ],
  },
  {
    id: 'data-safety',
    label: 'Data safety',
    entries: [
      {
        href: '/dashboard/settings/recovery',
        title: 'Recovery',
        description: 'Restore soft-deleted items, categories, suppliers, and locations.',
        permission: 'items:delete',
      },
      {
        href: '/dashboard/settings/restore-points',
        title: 'Backups & restore',
        description:
          'Point-in-time snapshots of your inventory you can roll back to. Business plan.',
        permission: 'items:delete',
      },
      {
        href: '/dashboard/settings/inventory-cleanup',
        title: 'Archived item cleanup',
        description:
          'Automatically delete items that have stayed archived past a set time. Recoverable.',
        permission: 'items:delete',
      },
    ],
  },
  {
    id: 'connections',
    label: 'Connections',
    entries: [
      {
        href: '/dashboard/settings/integrations',
        title: 'Integrations',
        description: 'Connect QuickBooks Online and other tools to export your data.',
        permission: 'integrations:manage',
        // The Sage 50 migration is reached from the Integrations page.
        alsoActiveFor: ['/dashboard/settings/migrate'],
      },
      {
        href: '/dashboard/settings/ai',
        title: 'AI',
        description: 'Semantic-search embeddings and AI assistant configuration.',
        permission: 'ai:manage',
      },
    ],
  },
  {
    id: 'plan',
    label: 'Plan',
    entries: [
      {
        href: '/dashboard/settings/billing',
        title: 'Billing',
        description: 'Plan, invoices, payment method.',
        permission: 'billing:read',
      },
    ],
  },
];

/** The table filtered to what the caller may use; empty groups drop out. */
export function visibleSettingsGroups(access: SettingsNavAccess): SettingsNavGroup[] {
  const granted = new Set(access.permissions);
  const modules = new Set<string>(access.modules);
  return SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    entries: group.entries.filter(
      (entry) =>
        (entry.permission === undefined || granted.has(entry.permission)) &&
        (entry.module === undefined || modules.has(entry.module)),
    ),
  })).filter((group) => group.entries.length > 0);
}

function within(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** The destination a settings path belongs to, for the sub-nav's current mark. */
export function activeSettingsEntry(
  groups: readonly SettingsNavGroup[],
  pathname: string | null,
): SettingsNavEntry | null {
  if (!pathname) return null;
  for (const group of groups) {
    for (const entry of group.entries) {
      if (within(pathname, entry.href)) return entry;
      if (entry.alsoActiveFor?.some((base) => within(pathname, base))) return entry;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The hub: a grouped index of real links.
// ---------------------------------------------------------------------------

export function SettingsIndex({ access }: { access: SettingsNavAccess }) {
  const groups = visibleSettingsGroups(access);
  return (
    <div data-slot="settings-index" className="gap-4 lg:columns-2">
      {groups.map((group) => {
        const headingId = `settings-group-${group.id}`;
        return (
          <section
            key={group.id}
            aria-labelledby={headingId}
            className="bg-card mb-4 break-inside-avoid overflow-hidden rounded-lg border"
          >
            <h2
              id={headingId}
              className="border-border text-foreground border-b px-[18px] py-3.5 text-[13.5px] font-medium leading-5"
            >
              {group.label}
            </h2>
            <ul className="divide-border divide-y">
              {group.entries.map((entry) => (
                <li key={entry.href}>
                  <IntentLink
                    href={entry.href}
                    className="hover:bg-muted group flex min-h-11 items-center gap-3 px-[18px] py-3 transition-colors focus-visible:ring-inset focus-visible:ring-offset-0"
                  >
                    <span className="min-w-0 flex-1">
                      <h3 className="text-foreground block text-[13.5px] font-medium leading-5">
                        {entry.title}
                      </h3>
                      <span className="text-muted-foreground mt-0.5 block text-[12.5px] leading-[18px]">
                        {entry.description}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden
                      strokeWidth={1.8}
                      className="text-ink-4 group-hover:text-foreground size-3.5 shrink-0 transition-colors"
                    />
                  </IntentLink>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sub-nav on every settings page except the hub.
// ---------------------------------------------------------------------------

/**
 * A left rail from 1280 px up; below that, one 44 px "Settings" button that
 * opens the same grouped list over the page's top. The current destination
 * carries `aria-current="page"`. It is a `<nav>` with no heading, so `main`
 * keeps the page's single h1. Each link draws its focus ring inside its own
 * edge (ring-inset), as the settings index rows do: the rail is a 248 px
 * scroller whose links run to its right edge, and it cut the right side off
 * the ring drawn outside the link (P68-KBD-02).
 */
export function SettingsSubNav({ access }: { access: SettingsNavAccess }) {
  const groups = visibleSettingsGroups(access);
  const pathname = usePathname();
  const current = activeSettingsEntry(groups, pathname);
  const listId = React.useId();
  const [open, setOpen] = React.useState(false);

  // Close the phone menu whenever the page changes (adjusting state while
  // rendering, so no frame shows the old menu over the new page).
  const [openedOn, setOpenedOn] = React.useState(pathname);
  if (openedOn !== pathname) {
    setOpenedOn(pathname);
    if (open) setOpen(false);
  }

  return (
    <nav aria-label="Settings" data-slot="settings-subnav" className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="bg-card hover:bg-muted flex min-h-11 w-full items-center gap-2 rounded-lg border px-3.5 text-left text-[13.5px] transition-colors xl:hidden"
      >
        <span className="text-muted-foreground shrink-0">Settings</span>
        {current ? (
          <>
            <span aria-hidden className="text-ink-4 shrink-0">
              /
            </span>
            <span className="text-foreground min-w-0 flex-1 truncate font-medium">
              {current.title}
            </span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronDown
          aria-hidden
          strokeWidth={1.8}
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      <div
        id={listId}
        className={cn(
          open ? 'bg-card mt-2 block rounded-lg border p-2' : 'hidden',
          'xl:mt-0 xl:block xl:rounded-none xl:border-0 xl:bg-transparent xl:p-0',
        )}
      >
        <SettingsHubLink onNavigate={() => setOpen(false)} />
        {groups.map((group) => (
          <div key={group.id} className="mt-3 first:mt-0">
            <p
              id={`${listId}-${group.id}`}
              className="text-muted-foreground px-2.5 pb-1 pt-2 text-[10.5px] font-medium uppercase leading-4 tracking-[0.1em]"
            >
              {group.label}
            </p>
            <ul aria-labelledby={`${listId}-${group.id}`} className="grid gap-px">
              {group.entries.map((entry) => {
                const active = current?.href === entry.href;
                return (
                  <li key={entry.href}>
                    <IntentLink
                      href={entry.href}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                      className={cn(
                        'flex min-h-8 items-center rounded-md px-2.5 py-1.5 text-[13.5px] leading-5 transition-colors focus-visible:ring-inset focus-visible:ring-offset-0 max-xl:min-h-11 [@media(pointer:coarse)]:min-h-11',
                        active
                          ? 'bg-muted text-foreground font-medium'
                          : 'text-ink-2 hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {entry.title}
                    </IntentLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

/** "All settings": the way back to the grouped index, first in the list. */
function SettingsHubLink({ onNavigate }: { onNavigate: () => void }) {
  return (
    <IntentLink
      href={SETTINGS_HUB_HREF}
      onClick={onNavigate}
      className="text-ink-2 hover:bg-muted hover:text-foreground flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13.5px] leading-5 transition-colors focus-visible:ring-inset focus-visible:ring-offset-0 max-xl:min-h-11 [@media(pointer:coarse)]:min-h-11"
    >
      All settings
    </IntentLink>
  );
}

/** Holds the sub-nav's place while its gates resolve, so nothing shifts. */
export function SettingsSubNavPlaceholder() {
  return <div aria-hidden className="min-h-11 xl:min-h-0" />;
}

/**
 * The settings layout's frame: the sub-nav beside (from 1280 px) or above the
 * page, on every settings page except the hub, which IS the grouped index.
 * The page keeps its own padding and width, so pages written before this
 * frame existed render inside it unchanged.
 */
export function SettingsFrame({
  nav,
  children,
}: {
  nav: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  if (pathname === SETTINGS_HUB_HREF) return <>{children}</>;
  return (
    <div data-slot="settings-frame" className="xl:flex xl:items-start">
      <div className="px-4 pt-6 sm:px-8 sm:pt-7 xl:sticky xl:top-0 xl:max-h-[calc(100dvh-56px)] xl:w-[248px] xl:shrink-0 xl:overflow-y-auto xl:pb-8 xl:pr-0">
        {nav}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The settings page body and panel (P-SET).
// ---------------------------------------------------------------------------

/**
 * A settings page's column: the dashboard gutters (16 px on phones, 32 px from
 * sm), 28 px above the header, 64 px below the last panel, panels 16 px apart.
 * `form` pages read at 880 px at most; `wide` (Roles, Billing) at 1120 px.
 */
export function SettingsPage({
  width = 'form',
  className,
  children,
}: {
  width?: 'form' | 'wide';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-slot="settings-page"
      className={cn(
        'flex w-full min-w-0 flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7',
        width === 'form' ? 'max-w-[944px]' : 'max-w-[1184px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface SettingsPanelProps {
  title: React.ReactNode;
  /** id on the title's heading, for an `aria-labelledby` elsewhere (a table's scroll region). */
  headingId?: string;
  /**
   * Whether the card is a `region` landmark named by its title (the default).
   * Pass `false` when a region inside the card already takes the title as its
   * name (a wide table's scroll region named by `headingId`), so the page
   * lists that name once: the <section> then carries no name. The title stays
   * the card's h2 either way.
   */
  landmark?: boolean;
  description?: React.ReactNode;
  /** Right side of the header: a badge, a status, a small button. */
  aside?: React.ReactNode;
  /** `danger`: the account deletion card (destructive edge and title). */
  tone?: 'default' | 'danger';
  /** Rows that bring their own padding (lists, tables). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
}

/**
 * One settings card: the elevated surface with a hairline and radius 8, a
 * 14 x 18 header (title as an h2 under the page's h1, the card's own
 * explanation under it) and an 18 px body. Each card keeps its own Save.
 */
export function SettingsPanel({
  title,
  headingId: headingIdProp,
  landmark = true,
  description,
  aside,
  tone = 'default',
  flush = false,
  className,
  bodyClassName,
  children,
}: SettingsPanelProps) {
  const autoHeadingId = React.useId();
  const headingId = headingIdProp ?? autoHeadingId;
  return (
    <section
      data-slot="settings-panel"
      aria-labelledby={landmark ? headingId : undefined}
      className={cn(
        'bg-card text-card-foreground min-w-0 rounded-lg border',
        tone === 'danger' && 'border-destructive/40',
        className,
      )}
    >
      <div className="border-border flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b px-[18px] py-3.5">
        <div className="min-w-0 flex-1">
          <h2
            id={headingId}
            className={cn(
              'text-[13.5px] font-medium leading-5',
              tone === 'danger' ? 'text-destructive' : 'text-foreground',
            )}
          >
            {title}
          </h2>
          {description != null ? (
            <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-[18px]">
              {description}
            </div>
          ) : null}
        </div>
        {aside}
      </div>
      {children != null ? (
        <div className={cn(flush ? null : 'p-[18px]', bodyClassName)}>{children}</div>
      ) : null}
    </section>
  );
}
