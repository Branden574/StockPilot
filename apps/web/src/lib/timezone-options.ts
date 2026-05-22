/**
 * Allow-list of IANA timezones the user can pick in /dashboard/settings/organization.
 * Lives in a plain module (not a 'use server' file) so client components can
 * import it without tripping Next.js 16's "server actions must only export async
 * functions" rule that broke the Vercel build on commit 2ebecb6.
 *
 * The server action validates incoming values against this same list before
 * writing to organizations.timezone — single source of truth.
 */
export const ORG_TIMEZONE_OPTIONS = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Manila',
  'Australia/Sydney',
] as const;

export type OrgTimezoneOption = (typeof ORG_TIMEZONE_OPTIONS)[number];
