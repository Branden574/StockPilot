'use client';

import { LayoutPanelLeft, Monitor, Moon, Sparkles, Sun, type LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import * as React from 'react';

import {
  parseStyle,
  parseThemeSetting,
  type AppearanceStyle,
  type AppearanceSyncStatus,
  type GlassRollout,
  type ThemeSetting,
} from '@stockpilot/core';

import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

import { liquidGlassRollout } from './appearance-flag';
import { useAppearance } from './appearance-provider';

/**
 * The appearance selector (plans/REVISION-DEFAULT.md R1, R13; brief section
 * 4) in its places: the account menu (user-menu.tsx), the header icon menu
 * (theme-toggle.tsx), the external pages' corner menu (external-shell.tsx)
 * and Settings > Profile (components/settings/appearance-panel.tsx). Two
 * groups, everywhere, Design first:
 *
 *   Design   Liquid Glass, Classic
 *   Theme    Light, Dark, System
 *
 * Switching the Design never changes the Theme. Every Theme control goes
 * through the provider's chooseTheme (round 2, finding 9), so a Theme picked
 * anywhere is the person's own and is saved. Every option is a word, never an
 * icon alone; the choice in use is announced as checked.
 *
 * Under the `off` rollout none of this renders: the menus show origin/main's
 * Theme-only markup verbatim (theme-toggle.tsx, user-menu.tsx) and Settings >
 * Profile has no Appearance panel, so a rollback gives today's pixels.
 */

export interface DesignOption {
  value: AppearanceStyle;
  label: string;
  /** One line for the settings panel. */
  description: string;
  icon: LucideIcon;
}

export const DESIGN_OPTIONS: readonly DesignOption[] = [
  {
    value: 'liquid-glass',
    label: 'Liquid Glass',
    description: 'The standard StockPilot look. Day or Night follows your Theme.',
    icon: Sparkles,
  },
  {
    value: 'classic',
    label: 'Classic',
    description: 'The previous StockPilot design, unchanged.',
    icon: LayoutPanelLeft,
  },
];

export interface ThemeOption {
  value: ThemeSetting;
  label: string;
  icon: LucideIcon;
}

/** origin/main's order and words (user-menu.tsx, theme-toggle.tsx). */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export interface AppearanceChoice {
  rollout: GlassRollout;
  /** The Design to mark as selected (what is on screen), or undefined before hydrate. */
  style: AppearanceStyle | undefined;
  /** The Theme to mark as selected, or undefined before it is known (server render). */
  theme: ThemeSetting | undefined;
  chooseStyle: (style: AppearanceStyle) => void;
  chooseTheme: (theme: ThemeSetting) => void;
  status: AppearanceSyncStatus | null;
  retry: (() => void) | null;
}

/** The current choices and the way to change them, for every selector. */
export function useAppearanceChoice(): AppearanceChoice {
  const appearance = useAppearance();
  const { theme, setTheme } = useTheme();
  if (appearance) {
    return {
      rollout: appearance.rollout,
      // What is on screen, not the stored choice: during the one-time crash
      // fallback a stored Liquid Glass shows Classic, so Classic is the one
      // checked and Liquid Glass can be chosen to turn glass back on (a radio
      // that is already checked never fires its change).
      style: appearance.hydrated ? appearance.shownStyle : undefined,
      theme: appearance.theme,
      chooseStyle: appearance.chooseStyle,
      chooseTheme: appearance.chooseTheme,
      status: appearance.status,
      retry: appearance.retry,
    };
  }
  // No provider above (a component test, or a tree outside the root layout):
  // the Theme falls back to next-themes, as the old Theme radio did.
  return {
    rollout: liquidGlassRollout(),
    style: undefined,
    theme: parseThemeSetting(theme) ?? undefined,
    chooseStyle: () => {},
    chooseTheme: (next) => setTheme(next),
    status: null,
    retry: null,
  };
}

/**
 * The account-sync line under the settings panel's choices. It never claims
 * the account holds the choice unless the server said so (plan 3.4 rule 2).
 */
export function appearanceStatusText(status: AppearanceSyncStatus | null): string | null {
  switch (status) {
    case 'saving':
      return 'Saving to your account…';
    case 'synced':
      return 'Saved to your account.';
    case 'failed':
      return 'Saved on this device. Not saved to your account yet.';
    case 'unavailable':
      return 'Saved on this device only.';
    case 'signed-out':
      return 'Saved on this device.';
    default:
      return null;
  }
}

interface RadioGroupProps {
  /** Lines the names up with each menu's own items. */
  itemClassName?: string;
  withIcons?: boolean;
}

/** The Design radio items for a dropdown menu. */
export function AppearanceDesignRadioGroup({ itemClassName, withIcons = false }: RadioGroupProps) {
  const { style, chooseStyle } = useAppearanceChoice();
  return (
    <DropdownMenuRadioGroup
      aria-label="Design"
      value={style ?? ''}
      onValueChange={(next) => {
        const value = parseStyle(next);
        if (value) chooseStyle(value);
      }}
    >
      {DESIGN_OPTIONS.map(({ value, label, icon: Icon }) => (
        <DropdownMenuRadioItem key={value} value={value} className={itemClassName}>
          {withIcons ? <Icon className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
          {label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/** The Theme radio items for a dropdown menu, through the provider's chooseTheme. */
export function AppearanceThemeRadioGroup({ itemClassName, withIcons = false }: RadioGroupProps) {
  const { theme, chooseTheme } = useAppearanceChoice();
  return (
    <DropdownMenuRadioGroup
      aria-label="Theme"
      value={theme}
      onValueChange={(next) => {
        const value = parseThemeSetting(next);
        if (value) chooseTheme(value);
      }}
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
        <DropdownMenuRadioItem key={value} value={value} className={itemClassName}>
          {withIcons ? <Icon className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
          {label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

/**
 * Both groups for a dropdown menu: "Design", a separator, "Theme". Renders
 * nothing under the `off` rollout (the menus keep origin/main's markup then).
 */
export function AppearanceMenuGroups({
  itemClassName,
  labelClassName,
  withIcons = false,
}: RadioGroupProps & { labelClassName?: string }) {
  if (liquidGlassRollout() === 'off') return null;
  return (
    <>
      <DropdownMenuLabel className={labelClassName}>Design</DropdownMenuLabel>
      <AppearanceDesignRadioGroup itemClassName={itemClassName} withIcons={withIcons} />
      <DropdownMenuSeparator />
      <DropdownMenuLabel className={labelClassName}>Theme</DropdownMenuLabel>
      <AppearanceThemeRadioGroup itemClassName={itemClassName} withIcons={withIcons} />
    </>
  );
}
