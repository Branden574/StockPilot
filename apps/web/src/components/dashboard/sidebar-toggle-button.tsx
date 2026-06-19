'use client';

import { PanelLeft } from 'lucide-react';

import { SIDEBAR_DOM_ID } from '@/components/dashboard/sidebar-pref';
import { cn } from '@/lib/utils';

interface SidebarToggleButtonProps {
  /** Desktop sidebar visibility — drives the label/expanded state. */
  hidden: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * The single topbar control for the sidebar. Always rendered; the parent
 * decides what `onToggle` does per viewport (desktop hides/shows the sidebar,
 * mobile opens the drawer).
 */
export function SidebarToggleButton({ hidden, onToggle, className }: SidebarToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!hidden}
      // Reference the sidebar only while it's in the DOM (it's conditionally
      // rendered on desktop) — omit when hidden to avoid a dangling reference.
      aria-controls={hidden ? undefined : SIDEBAR_DOM_ID}
      aria-label={hidden ? 'Show sidebar' : 'Hide sidebar'}
      className={cn(
        'hover:bg-muted hover:text-foreground grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
    >
      <PanelLeft className="h-4 w-4" aria-hidden />
    </button>
  );
}
