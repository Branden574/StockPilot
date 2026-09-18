/**
 * A calendar date formatted deterministically in UTC ("Sep 18, 2026").
 *
 * Deliberately NOT in components/ui/local-date.tsx: that file is 'use client',
 * and a function exported from a client module cannot be CALLED from a server
 * component (Next turns it into a client reference and throws at render). The
 * server pages need this for LocalDate's pre-hydration fallback, so it lives in
 * a module with no directive, importable from both sides.
 */
export function utcDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
