import { Alert, Platform, type AlertButton, type AlertType } from 'react-native';

import { holdUpdatePrompt } from './update-prompt-holds';

/**
 * Every native alert holds the phone update pop-up (update-prompt-holds.ts)
 * from the moment it shows until one of its buttons is pressed.
 *
 * WHY. A native alert is drawn above the React tree, so nothing else can see
 * it: a "Remove file?" or "Start a cycle count" question left up while the
 * phone sat in a pocket would otherwise read as nobody working. Installing it
 * once covers every Alert.alert and Alert.prompt in the app, with no change at
 * the call sites.
 *
 * HOW. On iOS, React Native's Alert.alert hands every alert to Alert.prompt
 * (react-native/Libraries/Alert/Alert.js; alert-holds.test.ts reads that file
 * and fails if it stops doing so), so wrapping the static Alert.prompt wraps
 * both. On Android, Alert.alert is wrapped itself.
 *
 *   - Every button gets an onPress that runs the button's own first (a
 *     prompt's typed value passed through) and releases in a finally, so any
 *     answer releases, a Cancel with no handler of its own included, and an
 *     onPress that opens another alert keeps the count above zero.
 *   - With no buttons React Native draws its own (OK, or OK and Cancel for a
 *     text prompt) that call nothing, so the same buttons are named here with
 *     a release.
 *   - The callback form of Alert.prompt becomes the same OK and Cancel, with
 *     the callback behind OK.
 *   - On Android a cancelable alert can also be dismissed without a button:
 *     options.onDismiss releases then. A release is idempotent, so a press
 *     followed by a dismiss counts once.
 *
 * Ported from busy-alert.ts on the parked branch perf/mobile-speed-combined,
 * which wrapped one call site at a time. installAlertHolds() runs once per
 * JavaScript runtime, from app/_layout.tsx right after initSentry().
 */

type AlertOptionsArg = Parameters<typeof Alert.alert>[3];
type PromptCallback = (text: string) => void;
/** A button's onPress, as React Native calls it (a prompt passes what was typed). */
type ButtonPress = (value?: unknown) => void;

let installed = false;

/** Each button's own onPress first, then the release, however it ends. */
function releasing(buttons: AlertButton[], release: () => void): AlertButton[] {
  return buttons.map((button) => {
    const own = button.onPress as ButtonPress | undefined;
    return {
      ...button,
      onPress: (value?: string) => {
        try {
          own?.(value);
        } finally {
          release();
        }
      },
    };
  });
}

/**
 * The buttons iOS shows when none are given (RCTAlertManager.mm): one OK in
 * the cancel style for a plain alert, OK and Cancel for a text prompt.
 */
function defaultButtons(type: AlertType | undefined): AlertButton[] {
  return type === 'default'
    ? [{ text: 'OK', style: 'cancel' }]
    : [{ text: 'OK' }, { text: 'Cancel', style: 'cancel' }];
}

function iosButtons(
  callbackOrButtons: PromptCallback | AlertButton[] | undefined,
  type: AlertType | undefined,
  release: () => void,
): AlertButton[] {
  if (typeof callbackOrButtons === 'function') {
    // React Native passes the callback whatever the field held, unchanged.
    const callback = callbackOrButtons as ButtonPress;
    const [ok, ...rest] = defaultButtons(type);
    return releasing([{ ...ok, onPress: (value?: string) => callback(value) }, ...rest], release);
  }
  if (Array.isArray(callbackOrButtons) && callbackOrButtons.length > 0) {
    return releasing(callbackOrButtons, release);
  }
  return releasing(defaultButtons(type), release);
}

/** Wraps React Native's Alert once for this JavaScript runtime. */
export function installAlertHolds(): void {
  if (installed) return;
  installed = true;

  if (Platform.OS === 'ios') {
    const prompt = Alert.prompt;
    Alert.prompt = (
      title,
      message,
      callbackOrButtons,
      type,
      defaultValue,
      keyboardType,
      options,
    ) => {
      const release = holdUpdatePrompt('alert');
      // Alert.prompt's own default when no type is given.
      const shown = type ?? 'plain-text';
      try {
        prompt.call(
          Alert,
          title,
          message,
          iosButtons(callbackOrButtons, shown, release),
          shown,
          defaultValue,
          keyboardType,
          options,
        );
      } catch (err) {
        // Nothing was shown, so nothing holds.
        release();
        throw err;
      }
    };
    return;
  }

  if (Platform.OS === 'android') {
    const alert = Alert.alert;
    Alert.alert = (title, message, buttons, options?: AlertOptionsArg) => {
      const release = holdUpdatePrompt('alert');
      const given = buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }];
      try {
        alert.call(Alert, title, message, releasing(given, release), {
          ...options,
          onDismiss: () => {
            release();
            options?.onDismiss?.();
          },
        });
      } catch (err) {
        release();
        throw err;
      }
    };
  }
}
