/**
 * Session lane for the landing intro. sessionStorage ONLY — the intro replays
 * next session by design, and we never want cookie/localStorage permanence for
 * a purely cosmetic flag. Every access is try/caught: hardened privacy modes
 * throw on the getter itself, and the intro must degrade to "first visit"
 * behaviour (worst case: a returning visitor sees the full sequence again).
 */
export const INTRO_SEEN_KEY = 'stockpilot:intro-seen:v1';

export function hasSeenIntro(): boolean {
  try {
    return window.sessionStorage.getItem(INTRO_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    window.sessionStorage.setItem(INTRO_SEEN_KEY, '1');
  } catch {
    // no-op — privacy mode; the intro may replay this session, nothing breaks.
  }
}
