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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { liquidGlassRollout } from './appearance-flag';
import { AppearanceDesignRadioGroup, useAppearanceChoice } from './appearance-select';

/**
 * The header appearance menu. `className` sizes the trigger to its bar (the
 * dashboard top bar passes its 32px icon-button look); without it the trigger
 * is the shared ghost icon button, as on the sign-in, onboarding, invite,
 * marketing and external-page headers.
 *
 * With Liquid Glass in the build (opt-in or default): the Design group
 * (a "Design" label, Liquid Glass and Classic as radios, a separator) in front
 * of origin/main's three Theme items, which keep their words, icons and
 * markup and go through the provider's chooseTheme (plans/REVISION-DEFAULT.md
 * R13, round 2 finding 9). The Design group is this menu's only difference
 * from today in Classic (R5: the declared selector exception; item 46a).
 * Under the `off` rollout: origin/main's three items with their direct
 * setTheme, verbatim, so a rollback gives today's pixels (R5).
 *
 * The trigger's name (DECISIONS.md F6): while <html> shows Liquid Glass, the
 * menu is named for what it holds, "Appearance: design and theme", as its
 * accessible name and its tooltip. In Classic, in every rollout, it keeps
 * origin/main's "Toggle theme" and no tooltip. The name follows the
 * provider's glassApplied, which is false on the server and in the first
 * client render, so the trigger hydrates as classic and is renamed after
 * mount; nothing here reads the cookie or <html>. Only attributes of the one
 * trigger change, never the tree, so an open menu, its focus and its return
 * focus survive a switch made from inside it. The pair is listed in
 * tests/e2e/appearance/glass-only-allowlist.json (a "renamed action").
 */
export function ThemeToggle({ className }: { className?: string } = {}) {
  if (liquidGlassRollout() === 'off') return <ClassicThemeToggle className={className} />;
  return <GlassBuildThemeToggle className={className} />;
}

/** The trigger's name in Classic: origin/main's words. */
const CLASSIC_NAME = 'Toggle theme';
/** Its name and tooltip while <html> shows Liquid Glass (DECISIONS.md F6). */
const GLASS_NAME = 'Appearance: design and theme';

/** The menu in a build with Liquid Glass: the Design group, then origin/main's items. */
function GlassBuildThemeToggle({ className }: { className?: string }) {
  const { chooseTheme, glassApplied } = useAppearanceChoice();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id="theme-toggle-trigger"
          variant="ghost"
          size="icon"
          aria-label={glassApplied ? GLASS_NAME : CLASSIC_NAME}
          title={glassApplied ? GLASS_NAME : undefined}
          className={className}
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* The Design group: the menu's one classic difference (R5). The dot
            of the one in use sits in the icon column, and pl-10 lines the
            names up with the items below (icon 16 + its margin + the item's
            gap), as in the account menu. The three parts sit in one inert
            wrapper that draws no box (display: contents), so the lab's parity
            run can take the group out of the menu by one selector and compare
            the rest with origin/main's (verify/allowances.json, the
            menu-design entries); nothing styles or reads it. */}
        <div data-appearance-design="" className="contents">
          <DropdownMenuLabel>Design</DropdownMenuLabel>
          <AppearanceDesignRadioGroup itemClassName="pl-10" />
          <DropdownMenuSeparator />
        </div>
        {/* origin/main's items, verbatim, through the provider (R13). */}
        <DropdownMenuItem onClick={() => chooseTheme('light')}>
          <Sun className="mr-2 h-4 w-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => chooseTheme('dark')}>
          <Moon className="mr-2 h-4 w-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => chooseTheme('system')}>
          <Monitor className="mr-2 h-4 w-4" />
          System
        </DropdownMenuItem>
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
