/**
 * Best-effort, dependency-free user-agent → friendly label. Used by the active-
 * sessions list (and reusable elsewhere). Intentionally simple substring
 * matching — exact UA parsing is not worth a dependency for a display label.
 */
export function parseUserAgent(ua: string | null): {
  browser: string;
  os: string;
  label: string;
} {
  if (!ua || !ua.trim()) return { browser: 'Unknown', os: 'Unknown', label: 'Unknown device' };

  // The native app sends a "StockPilot/<ver> (... iOS|Android ...) Expo" UA.
  if (/StockPilot\//i.test(ua) || /Expo/i.test(ua)) {
    const os = /iPhone|iOS|iPad/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : 'mobile';
    return { browser: 'StockPilot app', os, label: `StockPilot app on ${os}` };
  }

  const os =
    /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';

  const browser =
    /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /Brave/i.test(ua) ? 'Brave'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Safari\//i.test(ua) ? 'Safari'
    : 'Unknown browser';

  return { browser, os, label: `${browser} on ${os}` };
}
