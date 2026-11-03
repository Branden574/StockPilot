'use client';

import { Monitor, Moon, Sparkles, Sun, type LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import * as React from 'react';

import {
  parseAppearance,
  parseClassicAppearance,
  type AppearanceMode,
  type AppearanceSyncStatus,
} from '@stockpilot/core';

import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';

import { useAppearance } from './appearance-provider';

/**
 * The appearance selector (Liquid Glass plan D1, 3.4; brief section 4), in its
 * three places: the account menu's Appearance radio (user-menu.tsx), the
 * header icon menu (theme-toggle.tsx) and Settings > Profile
 * (components/settings/appearance-panel.tsx). One list of choices, one
 * reading of the current one, one way to choose, so the three never disagree.
 *
 * Dark, Light and Liquid Glass come first, then System, the existing default
 * (it follows the device in the classic look). Liquid Glass is offered only
 * when the build's kill switch is on (appearance-flag.ts). Every option is a
 * word, never an icon alone; the choice in use is announced as checked.
 *
 * Without an AppearanceProvider above it (a component test, or a tree that
 * renders before the provider), the classic choices fall back to next-themes
 * exactly as the old Theme radio did.
 */

export interface AppearanceOption {
  mode: AppearanceMode;
  label: string;
  /** One line for the settings panel. */
  description: string;
  icon: LucideIcon;
}

export const APPEARANCE_OPTIONS: readonly AppearanceOption[] = [
  { mode: 'dark', label: 'Dark', description: 'The dark StockPilot look.', icon: Moon },
  { mode: 'light', label: 'Light', description: 'The light StockPilot look.', icon: Sun },
  {
    mode: 'liquid-glass',
    label: 'Liquid Glass',
    description: 'Frosted glass over a soft scene. Day or night follows this device.',
    icon: Sparkles,
  },
  {
    mode: 'system',
    label: 'System',
    description: 'Dark or Light, following this device.',
    icon: Monitor,
  },
];

/** The options this build offers: Liquid Glass only when the kill switch is on. */
export function offeredAppearanceOptions(glassAvailable: boolean): readonly AppearanceOption[] {
  return APPEARANCE_OPTIONS.filter((o) => glassAvailable || o.mode !== 'liquid-glass');
}

export interface AppearanceChoice {
  /** The choice to mark as selected, or undefined before it is known (server render). */
  value: AppearanceMode | undefined;
  options: readonly AppearanceOption[];
  choose: (mode: AppearanceMode) => void;
  status: AppearanceSyncStatus | null;
  retry: (() => void) | null;
}

/** The current choice and the way to change it, for the three selectors. */
export function useAppearanceChoice(): AppearanceChoice {
  const appearance = useAppearance();
  const { theme, setTheme } = useTheme();
  if (appearance) {
    return {
      // What is on screen, not the stored choice: during the one-time crash
      // fallback a stored Liquid Glass shows classic System, so System is the
      // one checked and Liquid Glass can be chosen to turn glass back on (a
      // radio that is already checked never fires its change).
      value: appearance.hydrated ? appearance.shown : undefined,
      options: offeredAppearanceOptions(appearance.glassAvailable),
      choose: appearance.choose,
      status: appearance.status,
      retry: appearance.retry,
    };
  }
  return {
    value: parseClassicAppearance(theme) ?? undefined,
    options: offeredAppearanceOptions(false),
    choose: (mode) => {
      if (mode !== 'liquid-glass') setTheme(mode);
    },
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

/**
 * The radio items for a dropdown menu (the account menu and the header icon
 * menu). `itemClassName` lets each menu line the names up with its own items.
 */
export function AppearanceMenuRadioGroup({
  itemClassName,
  withIcons = false,
}: {
  itemClassName?: string;
  withIcons?: boolean;
}) {
  const { value, options, choose } = useAppearanceChoice();
  return (
    <DropdownMenuRadioGroup
      aria-label="Appearance"
      value={value ?? ''}
      onValueChange={(next) => {
        const mode = parseAppearance(next);
        if (mode) choose(mode);
      }}
    >
      {options.map(({ mode, label, icon: Icon }) => (
        <DropdownMenuRadioItem key={mode} value={mode} className={itemClassName}>
          {withIcons ? <Icon className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
          {label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
