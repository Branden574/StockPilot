'use client';

import { Gift } from 'lucide-react';

import { openWhatsNew, useUpdateState } from '@/lib/updates/update-store';

import { WHATS_NEW_ENTRY_ID } from './constants';

/**
 * The PERMANENT way back to What's New, for after the notice is closed. Lives in
 * the topbar, not the sidebar: the sidebar is subject to per-organization
 * nav_overrides (hide, rename, reorder) and is rendered twice (desktop and the
 * mobile sheet), so it cannot promise to be there.
 *
 * A dot, not a count, in the primary colour: it must not compete with the
 * notifications badge next to it, and "you have 3 unread release notes" is not a
 * number anyone should feel pressed by. The unread fact is in the accessible
 * name, because a dot alone says nothing to a screen reader or to anyone who
 * cannot see the colour.
 */
export function WhatsNewButton() {
  const { releases } = useUpdateState();
  const unread = releases?.unreadCount ?? 0;
  const label = unread > 0 ? `What’s new, ${unread} unread` : 'What’s new';
  return (
    <button
      id={WHATS_NEW_ENTRY_ID}
      type="button"
      aria-label={label}
      title={label}
      onClick={() => openWhatsNew(null, 'topbar')}
      className="hover:bg-muted hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
    >
      <Gift className="h-3.5 w-3.5" aria-hidden />
      {unread > 0 ? (
        <span
          aria-hidden
          className="bg-primary ring-background absolute right-1 top-1 size-2 rounded-full ring-2"
        />
      ) : null}
    </button>
  );
}
