import {
  defaultStyle,
  type AppearanceStyle,
  type AppearanceSyncStatus,
  type GlassRollout,
  type ThemeSetting,
} from '@stockpilot/core';

/**
 * The words of the Appearance screen, the Settings row, the intro card and
 * the way back (plan 5.4, revision R1, R13; item 36), in one place so the
 * screens, the row and the tests agree. Every option is named in words (never
 * an icon alone), and VoiceOver reads the same words. The group is "Design"
 * because the owner says "design" ("the current design"); the code keeps the
 * word `style`.
 */

export interface DesignOption {
  style: AppearanceStyle;
  label: string;
  detail: string;
}

export interface ThemeOption {
  theme: ThemeSetting;
  label: string;
  detail: string;
}

/** Liquid Glass first: it is the standard look (owner change, DECISIONS). */
export const DESIGN_OPTIONS: readonly DesignOption[] = [
  {
    style: 'liquid-glass',
    label: 'Liquid Glass',
    detail: 'The standard StockPilot look. Day or Night follows your Theme.',
  },
  { style: 'classic', label: 'Classic', detail: 'The previous StockPilot design, unchanged.' },
];

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { theme: 'light', label: 'Light', detail: 'Light, whatever your phone is set to.' },
  { theme: 'dark', label: 'Dark', detail: 'Dark, whatever your phone is set to.' },
  { theme: 'system', label: 'System', detail: 'Light or Dark, following your phone.' },
];

/**
 * The Settings row's detail, e.g. "Liquid Glass · System": the person's own
 * choices, a Design never chosen read as the rollout's default and a Theme
 * never chosen as System (what the phone draws for them).
 */
export function appearanceLabel(
  style: AppearanceStyle | null,
  theme: ThemeSetting | null,
  rollout: GlassRollout,
): string {
  const design = style ?? defaultStyle(rollout);
  const designLabel = DESIGN_OPTIONS.find((o) => o.style === design)?.label ?? 'Classic';
  const themeLabel = THEME_OPTIONS.find((o) => o.theme === (theme ?? 'system'))?.label ?? 'System';
  return `${designLabel} · ${themeLabel}`;
}

/**
 * The sync line under the choices. Truthful by construction: "Saved to your
 * account" only when the server answered (status 'synced'); never a claim of
 * sync while saving, after a failure, or when the account store is missing.
 * `retry` says whether to offer Try again.
 */
export function syncLine(status: AppearanceSyncStatus): { text: string; retry: boolean } {
  switch (status) {
    case 'synced':
      return { text: 'Saved to your account.', retry: false };
    case 'saving':
      return { text: 'Saving to your account...', retry: false };
    case 'failed':
      return { text: 'Saved on this phone. Not saved to your account yet.', retry: true };
    case 'unavailable':
      return { text: 'Saved on this phone only.', retry: true };
    case 'signed-out':
      return { text: 'Saved on this phone.', retry: false };
    case 'idle':
    default:
      // Signed in, nothing confirmed by the account yet (no row, or not read):
      // say only what is true.
      return { text: 'Saved on this phone.', retry: false };
  }
}

const APPEARANCE_FOOTNOTE =
  'Liquid Glass follows your device: Reduce Transparency makes it solid and Reduce Motion calms its movement. Change them in iOS Settings > Accessibility.';

/**
 * The footnote: glass follows the OS settings, there are no in-app switches
 * (plan Q3). It is about Liquid Glass only, so a build with the kill switch
 * off (plan D12, 5.5) shows none.
 */
export function appearanceFootnote(glassEnabled: boolean): string | null {
  return glassEnabled ? APPEARANCE_FOOTNOTE : null;
}

export const FALLBACK_NOTICE = {
  title: 'Liquid Glass hit a problem',
  body: 'Liquid Glass hit a problem, so StockPilot opened in the classic look.',
  turnBackOn: 'Turn Liquid Glass back on',
  useClassic: 'Use classic design',
} as const;

/** The one-time card on Home for anyone shown Liquid Glass by default (R13). */
export const INTRO_NOTICE = {
  title: 'StockPilot has a new look',
  body: 'You can switch back to the classic design at any time.',
  useClassic: 'Use classic design',
  keepGlass: 'Keep Liquid Glass',
  close: 'Close',
} as const;

export const RECOVERY_ACTION_LABEL = 'Use classic design';
