'use client';

import { Moon, Sun } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { AppearanceMenuRadioGroup } from './appearance-select';

/**
 * The header appearance menu: Dark, Light, Liquid Glass (when this build
 * offers it) and System, the choice in use marked and announced as checked
 * (appearance-select.tsx). The trigger is the same icon button as before, so
 * every bar keeps its look. `className` sizes the trigger to its bar (the
 * dashboard top bar passes its 32px icon-button look); without it the trigger
 * is the shared ghost icon button, as on the sign-in, onboarding, invite and
 * marketing headers.
 */
export function ThemeToggle({ className }: { className?: string } = {}) {
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
        <AppearanceMenuRadioGroup withIcons />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
