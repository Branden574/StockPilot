'use client';

import { PanelLeft } from 'lucide-react';

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
      aria-label={hidden ? 'Show sidebar' : 'Hide sidebar'}
      className={cn(
        'hover:bg-muted hover:text-foreground grid h-[30px] w-[30px] place-items-center rounded-md text-[var(--ed-ink-3)] transition-colors',
        className,
      )}
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  );
}
