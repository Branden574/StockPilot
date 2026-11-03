'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { liquidGlassRollout } from './appearance-flag';
import { AppearanceMenuGroups } from './appearance-select';

/**
 * The header appearance menu. `className` sizes the trigger to its bar (the
 * dashboard top bar passes its 32px icon-button look); without it the trigger
 * is the shared ghost icon button, as on the sign-in, onboarding, invite,
 * marketing and external-page headers.
 *
 * With Liquid Glass in the build (opt-in or default): "Appearance", then the
 * Design group (Liquid Glass, Classic) and the Theme group (Light, Dark,
 * System), the Theme through the provider (appearance-select.tsx). Under the
 * `off` rollout: origin/main's three items with their direct setTheme,
 * verbatim, so a rollback gives today's pixels (plans/REVISION-DEFAULT.md R5).
 */
export function ThemeToggle({ className }: { className?: string } = {}) {
  if (liquidGlassRollout() === 'off') return <ClassicThemeToggle className={className} />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id="theme-toggle-trigger"
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          className={className}
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <AppearanceMenuGroups withIcons />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** origin/main's ThemeToggle, verbatim (the `off` rollout). */
function ClassicThemeToggle({ className }: { className?: string } = {}) {
  const { setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id="theme-toggle-trigger"
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          className={className}
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="mr-2 h-4 w-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="mr-2 h-4 w-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Monitor className="mr-2 h-4 w-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
