import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

/**
 * Thin wrapper around expo-local-authentication for the StockPilot
 * mobile app. Surfaces three concerns:
 *
 *   1. Capability — does this device have biometric hardware AND has
 *      the user enrolled at least one fingerprint / face?
 *   2. Preference — has THIS user opted into using biometric unlock?
 *      Stored in SecureStore (iOS Keychain / Android Keystore) so it
 *      can't be tampered with by other apps.
 *   3. Prompt — actually invoke the OS biometric sheet and return
 *      success / failure.
 *
 * The Supabase session itself is already stored in SecureStore (see
 * supabase.ts), so the biometric prompt is a UI gate over an already-
 * valid session. We never destroy or re-fetch the session — pass the
 * prompt and the existing session is used; fail the prompt and we
 * fall back to the email/password sign-in screen.
 *
 * The opt-in flag is keyed by user id so multiple users on the same
 * device don't share each other's preferences.
 */

// Constant prefix; full key is `${BIOMETRIC_OPTIN_KEY_PREFIX}${userId}`.
const BIOMETRIC_OPTIN_KEY_PREFIX = 'sp_biometric_optin_';

export interface BiometricCapability {
  hasHardware: boolean;
  isEnrolled: boolean;
  /**
   * The strongest biometric type available, used to label the prompt
   * (e.g. "Use Face ID" vs "Use fingerprint"). Falls back to a generic
   * "biometric" label if we can't tell.
   */
  label: 'Face ID' | 'Touch ID' | 'Fingerprint' | 'Iris' | 'Biometric';
}

/**
 * Returns whether the device supports biometric auth AND the user has
 * enrolled at least one credential. Both must be true for the prompt
 * to ever succeed.
 */
export async function getBiometricCapability(): Promise<BiometricCapability> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) {
    return { hasHardware: false, isEnrolled: false, label: 'Biometric' };
  }

  const isEnrolled = await LocalAuthentication.isEnrolledAsync();
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  const T = LocalAuthentication.AuthenticationType;

  let label: BiometricCapability['label'] = 'Biometric';
  if (types.includes(T.FACIAL_RECOGNITION)) {
    label = 'Face ID';
  } else if (types.includes(T.FINGERPRINT)) {
    // iOS: Touch ID. Android: Fingerprint. The OS prompt itself shows
    // the right system glyph; this label is just for our pre-prompt
    // copy in our own UI.
    label = 'Fingerprint';
  } else if (types.includes(T.IRIS)) {
    label = 'Iris';
  }

  return { hasHardware, isEnrolled, label };
}

/**
 * Triggers the native biometric prompt. Returns true if the user
 * passed, false if they failed / cancelled / fell back to passcode
 * with `disableDeviceFallback: false` (the OS handles that path).
 *
 * `disableDeviceFallback` is FALSE so users who can't get the
 * biometric to read (greasy thumb, sunglasses) can still tap "use
 * passcode" and unlock with their device PIN. That's the OS-level
 * fallback, not the app-level email/password fallback.
 */
export async function promptBiometric(reason: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: 'Use password instead',
    disableDeviceFallback: false,
    fallbackLabel: 'Use device passcode',
  });
  return result.success;
}

export async function isBiometricEnabledForUser(userId: string): Promise<boolean> {
  const v = await SecureStore.getItemAsync(BIOMETRIC_OPTIN_KEY_PREFIX + userId);
  return v === '1';
}

export async function setBiometricEnabledForUser(
  userId: string,
  enabled: boolean,
): Promise<void> {
  const key = BIOMETRIC_OPTIN_KEY_PREFIX + userId;
  if (enabled) {
    await SecureStore.setItemAsync(key, '1');
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}

/**
 * Convenience: ask once whether to enable biometric for this user.
 * Performs the capability check, the OS prompt itself, and persists
 * the opt-in flag — returns true if biometric is now enabled for the
 * user, false otherwise (including the cases where the device has no
 * hardware / no enrollment, the user declined, or the prompt failed).
 */
export async function enableBiometricForUser(userId: string): Promise<boolean> {
  const cap = await getBiometricCapability();
  if (!cap.hasHardware || !cap.isEnrolled) return false;
  const ok = await promptBiometric(`Set up ${cap.label} for StockPilot`);
  if (!ok) return false;
  await setBiometricEnabledForUser(userId, true);
  return true;
}
