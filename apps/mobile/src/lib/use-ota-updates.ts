import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import * as React from 'react';
import { AccessibilityInfo, Alert, AppState, TextInput } from 'react-native';

import { cycleCountSync } from './cycle-count-sync';
import {
  createUpdatePromptController,
  MEMORY_KEY,
  RESTART_FAILED_MESSAGE,
  RESTART_FAILED_OK,
  RESTART_FAILED_TITLE,
  UPDATE_PROMPT_LATER,
  UPDATE_PROMPT_LOCK_ID,
  UPDATE_PROMPT_MESSAGE,
  UPDATE_PROMPT_RESTART,
  UPDATE_PROMPT_TITLE,
  type OtaWarningStage,
} from './ota-update-prompt';
import { RESTART_SCREEN } from './restart-screen';
import { Sentry } from './sentry';
import { isOnline, pauseSyncForRestart, whenSyncSettled } from './sync';
import { setTourVisible } from './tour-targets';
import {
  isUpdatePromptHeld,
  releaseHoldsUntilReturn,
  subscribeUpdatePromptHolds,
  whenWritesSettled,
} from './update-prompt-holds';

/**
 * Phone updates (B44): the app opens once, a new update downloads quietly, and
 * "Update ready" asks before the app restarts into it.
 *
 * This hook used to be useOtaAutoReload: on every open from closed it checked
 * for an update from JavaScript, downloaded it and called reloadAsync, so a
 * fresh update showed the launch screen, the app, a white flash and the
 * launch screen again, with no reason given (owner, 2026-10-31). Now:
 *
 *   - Opening from closed makes no JavaScript check. expo-updates' own launch
 *     check (app.config.ts sets only the updates url: checkOnLaunch ALWAYS,
 *     launchWaitMs 0) downloads a new update in the background and reports it
 *     in its native state, which the controller reads.
 *   - A return to the app after 30 minutes or more checks once more, so an
 *     update published meanwhile is downloaded too.
 *   - When an update is waiting and the person is not in the middle of
 *     something, the pop-up shows (ota-update-prompt.ts has every rule). Only
 *     Restart now restarts, with restartIntoUpdate below. Later leaves the
 *     update waiting: it opens by itself at the next open from closed, with
 *     one launch screen, and the pop-up comes back at the next return.
 *
 * The controller lives at module level, once per JavaScript runtime, so the
 * pop-up's buttons keep working whatever unmounts under the alert.
 */

/** Made once per JavaScript runtime: an open from closed or a restart gets a new one. */
const RUNTIME_TOKEN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const OTA_WARNING_MESSAGE = 'ota-update-prompt warning';
const reportedStages = new Set<OtaWarningStage>();

/**
 * One Sentry warning per stage per launch: the stage and an error code, never
 * a message, an id or the breadcrumbs (request URLs can name records).
 * Simulators never send (sentry.ts).
 */
function reportOtaWarningOnce(stage: OtaWarningStage, code: string | null): void {
  if (reportedStages.has(stage)) return;
  reportedStages.add(stage);
  try {
    Sentry.withScope((scope) => {
      scope.addEventProcessor((event) => ({ ...event, breadcrumbs: [] }));
      Sentry.captureMessage(OTA_WARNING_MESSAGE, {
        level: 'warning',
        tags: { feature: 'ota-update-prompt', stage, ...(code ? { code } : {}) },
        fingerprint: ['ota-update-prompt', stage],
      });
    });
  } catch {
    // Reporting is best-effort; it must never break an update.
  }
}

/**
 * THE restart. The only reloadAsync this file makes, reached only from
 * Restart now (deps.restart below). It shows the launch screen instead of
 * expo-updates' white one (restart-screen.ts).
 */
async function restartIntoUpdate(): Promise<void> {
  await Updates.reloadAsync({ reloadScreenOptions: RESTART_SCREEN });
}

function isTextFieldFocused(): boolean {
  try {
    return TextInput.State.currentlyFocusedInput() != null;
  } catch {
    return false;
  }
}

export const updatePrompt = createUpdatePromptController({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),

  isDev: __DEV__,
  isEnabled: Updates.isEnabled,
  isEmergencyLaunch: Updates.isEmergencyLaunch,
  isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  runningUpdateId: Updates.updateId,
  runtimeToken: RUNTIME_TOKEN,

  readNative: () => Updates.latestContext,
  listenNative: (fn) => {
    const sub = Updates.addUpdatesStateChangeListener((event) => fn(event.context));
    return () => sub.remove();
  },
  currentAppState: () => AppState.currentState,
  listenAppState: (fn) => {
    const sub = AppState.addEventListener('change', fn);
    return () => sub.remove();
  },
  isHeld: isUpdatePromptHeld,
  listenHolds: subscribeUpdatePromptHolds,
  releaseHoldsUntilReturn,
  isTextFocused: isTextFieldFocused,

  loadMemory: () => AsyncStorage.getItem(MEMORY_KEY),
  saveMemory: (text) => AsyncStorage.setItem(MEMORY_KEY, text),

  isOnline,
  checkForUpdate: async () => {
    const result = await Updates.checkForUpdateAsync();
    return result;
  },
  fetchUpdate: async () => {
    await Updates.fetchUpdateAsync();
  },

  showPrompt: (onLater, onRestartNow) => {
    Alert.alert(UPDATE_PROMPT_TITLE, UPDATE_PROMPT_MESSAGE, [
      { text: UPDATE_PROMPT_LATER, style: 'cancel', onPress: onLater },
      { text: UPDATE_PROMPT_RESTART, isPreferred: true, onPress: onRestartNow },
    ]);
  },
  showRestartFailed: () => {
    Alert.alert(RESTART_FAILED_TITLE, RESTART_FAILED_MESSAGE, [{ text: RESTART_FAILED_OK }]);
  },
  pauseWork: () => {
    const resumeSync = pauseSyncForRestart();
    const resumeCounts = cycleCountSync.pauseForRestart();
    return () => {
      resumeSync();
      resumeCounts();
    };
  },
  settle: async () => {
    await Promise.all([whenSyncSettled(), cycleCountSync.whenIdle(), whenWritesSettled()]);
  },
  restart: restartIntoUpdate,
  setSlot: (open) => setTourVisible(UPDATE_PROMPT_LOCK_ID, open),
  announce: (text) => AccessibilityInfo.announceForAccessibility(text),
  reportOnce: reportOtaWarningOnce,
});

/**
 * Starts the update pop-up for this JavaScript runtime. Called once, from the
 * root layout, before any sign-in gate; the pop-up itself waits for the
 * signed-in shell (UpdatePromptHost).
 */
export function useOtaUpdates(): void {
  React.useEffect(() => updatePrompt.start(), []);
}
