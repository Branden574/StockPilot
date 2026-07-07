import * as SecureStore from 'expo-secure-store';

/**
 * One-time "scanner tip" marker for the PO document scanner.
 *
 * The native scanner (iOS VisionKit / Android ML Kit) auto-captures the
 * moment it sees a page, and users never discover the built-in Auto→Manual
 * shutter toggle. The first time someone taps "Scan Document" we show an
 * animated tip (scanner-tip.tsx); this module remembers that they saw it.
 *
 * Storage is expo-secure-store — already a static import elsewhere in this
 * bundle (biometric.ts, supabase.ts), so it predates runtime 1.1.0 and is
 * safe to import at top level in an OTA update (unlike the scanner module
 * itself, see document-scanner.ts).
 *
 * Failure posture: persistence must NEVER block scanning.
 *   - Neither function ever rejects.
 *   - If the keystore is unreadable, we report "unseen" (the tip shows —
 *     better than never showing it).
 *   - markScanTipSeen() flips an in-memory session flag BEFORE attempting
 *     the write, so even with storage fully broken the tip shows at most
 *     once per app session.
 */

const KEY = 'scan-tip-seen-v1';

/** In-memory fallback: survives a failed keystore write for this session. */
let seenThisSession = false;

/** True once the user has dismissed the scanner tip (this session or any prior one). Never rejects. */
export async function hasSeenScanTip(): Promise<boolean> {
  if (seenThisSession) return true;
  try {
    return (await SecureStore.getItemAsync(KEY)) === '1';
  } catch {
    // Keystore unreadable — treat as unseen. The session flag above still
    // caps the tip at once per session after it is dismissed.
    return false;
  }
}

/** Record that the tip was shown. Fire-and-forget safe: never rejects. */
export async function markScanTipSeen(): Promise<void> {
  seenThisSession = true;
  try {
    await SecureStore.setItemAsync(KEY, '1');
  } catch {
    // Swallow — the session flag already prevents a re-show this launch,
    // and a broken keystore must not surface as a scan failure.
  }
}
