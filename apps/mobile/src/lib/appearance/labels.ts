import type { AppearanceMode, AppearanceSyncStatus } from '@stockpilot/core';

/**
 * The words of the Appearance screen and the Settings row (plan 5.4), in one
 * place so the screen, the row and the tests agree. Every option is named in
 * words (never an icon alone), and VoiceOver reads the same words.
 */

export interface AppearanceOption {
  mode: AppearanceMode;
  label: string;
  detail: string;
}

/** Dark, Light and Liquid Glass first, then System, today's default (plan D1). */
const ALL_OPTIONS: readonly AppearanceOption[] = [
  { mode: 'dark', label: 'Dark', detail: 'The dark StockPilot look.' },
  { mode: 'light', label: 'Light', detail: 'The light StockPilot look.' },
  {
    mode: 'liquid-glass',
    label: 'Liquid Glass',
    detail: 'Frosted glass that follows your device for day or night.',
  },
  { mode: 'system', label: 'System', detail: 'Dark or Light, matching your device.' },
];

/** The options this build offers: Liquid Glass only while its kill switch is on. */
export function appearanceOptions(glassEnabled: boolean): readonly AppearanceOption[] {
  return glassEnabled ? ALL_OPTIONS : ALL_OPTIONS.filter((o) => o.mode !== 'liquid-glass');
}

/** The Settings row's detail: the stored choice, in words. */
export function appearanceLabel(mode: AppearanceMode, glassEnabled: boolean): string {
  if (mode === 'liquid-glass' && !glassEnabled) return 'System';
  return ALL_OPTIONS.find((o) => o.mode === mode)?.label ?? 'System';
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
 * off (plan D12, 5.5: the selector hides the option) shows none.
 */
export function appearanceFootnote(glassEnabled: boolean): string | null {
  return glassEnabled ? APPEARANCE_FOOTNOTE : null;
}

export const FALLBACK_NOTICE = {
  title: 'Liquid Glass hit a problem',
  body: 'Liquid Glass hit a problem, so StockPilot opened in the classic look.',
  turnBackOn: 'Turn Liquid Glass back on',
  useClassic: 'Use classic',
} as const;

export const RECOVERY_ACTION_LABEL = 'Use classic appearance';
