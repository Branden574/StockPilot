/**
 * THE SHARED FIXTURE of the attack map's counting rules: made-up rows of the
 * security record in a thirty-minute window, and the numbers the database
 * gives for them.
 *
 * The rows and the numbers are the table "The shared fixture" of the
 * migration's contract (VERSION 2), row for row. The database's own test
 * (0478/98) builds the same rows and asserts the same numbers;
 * security-map.test.ts applies core's copy of the four lists and the rule of
 * 5 to them and must get the same. So a list changed on one side only turns
 * one of the two tests red.
 *
 * Made-up places and seven made-up organizations (A to G), none that exists.
 */

export interface SecurityMapFixtureRow {
  minute: number;
  category: string;
  outcome: string;
  reason: string;
  source: string;
  organization: string | null;
  country: string | null;
  city: string | null;
  count: number;
}

const row = (
  minute: number,
  category: string,
  outcome: string,
  reason: string,
  source: string,
  organization: string | null,
  country: string | null,
  city: string | null,
  count: number,
): SecurityMapFixtureRow => ({
  minute,
  category,
  outcome,
  reason,
  source,
  organization,
  country,
  city,
  count,
});

export const SECURITY_MAP_FIXTURE_ROWS: readonly SecurityMapFixtureRow[] = [
  row(1, 'phishing', 'flagged', 'sign_in_new_country', 'web', 'A', 'PT', 'Example Harbour', 1),
  row(1, 'phishing', 'flagged', 'sign_in_new_country', 'web', 'B', 'PT', 'Example Harbour', 1),
  row(1, 'phishing', 'flagged', 'sign_in_new_country', 'web', 'C', 'PT', 'Example Harbour', 1),
  row(2, 'phishing', 'flagged', 'sign_in_not_me', 'web', 'A', 'IT', 'Example Piazza', 2),
  row(2, 'phishing', 'flagged', 'sign_in_not_me', 'web', 'B', 'IT', 'Example Piazza', 1),
  row(
    3,
    'password_guessing',
    'flagged',
    'sign_in_alerts_held',
    'web',
    'A',
    'GB',
    'Example Borough',
    4,
  ),
  row(
    3,
    'password_guessing',
    'flagged',
    'sign_in_alerts_held',
    'web',
    'B',
    'GB',
    'Example Borough',
    4,
  ),
  row(4, 'password_guessing', 'blocked', 'wrong_password', 'web', null, 'US', null, 3),
  row(4, 'password_guessing', 'blocked', 'wrong_password', 'web', null, 'US', null, 2),
  row(5, 'password_guessing', 'flagged', 'too_many_forms_to_count', 'api', null, null, null, 400),
  row(
    5,
    'password_guessing',
    'flagged',
    'unrecorded_server_form_password',
    'api',
    null,
    null,
    null,
    25,
  ),
  row(5, 'password_guessing', 'flagged', 'unrecorded_server_form_code', 'api', null, null, null, 4),
  row(5, 'password_guessing', 'blocked', 'auth_log_over_cap', 'api', null, null, null, 9),
  row(6, 'bots', 'blocked', 'over_minute_cap', 'web', null, null, null, 30),
  row(7, 'bots', 'blocked', 'over_buffer_cap', 'web', null, null, null, 6),
  // One sign-in alert recorded in seven organizations: seven rows of 1, counted 2 (a fifth, rounded up).
  ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((organization) =>
    row(
      8,
      'phishing',
      'flagged',
      'sign_in_new_country',
      'web',
      organization,
      'NO',
      'Example Fjord',
      1,
    ),
  ),
];

export const SECURITY_MAP_FIXTURE_EXPECTED = {
  blocked_window: 50,
  flagged_window: 9,
  allowed_window: 0,
  totals: {
    'phishing.flagged': 5,
    'password_guessing.flagged': 4,
    'password_guessing.blocked': 14,
    'bots.blocked': 36,
  },
  no_place: { 'bots.blocked': 36, 'password_guessing.blocked': 9 },
  /** Largest first; ties by country. */
  by_country: [
    ['US', 'password_guessing', 'blocked', 5],
    ['GB', 'password_guessing', 'flagged', 4],
    ['IT', 'phishing', 'flagged', 2],
    ['NO', 'phishing', 'flagged', 2],
    ['PT', 'phishing', 'flagged', 1],
  ],
  /** Ordered by reason. */
  tallies: [
    ['too_many_forms_to_count', 'api', 'password_guessing', 'flagged', 400, 1],
    ['unrecorded_server_form_code', 'api', 'password_guessing', 'flagged', 4, 1],
    ['unrecorded_server_form_password', 'api', 'password_guessing', 'flagged', 25, 1],
  ],
  /** Ordered by reason. */
  flood_rows: [
    ['auth_log_over_cap', 'api', 'password_guessing', 'blocked', 9, 1],
    ['over_buffer_cap', 'web', 'bots', 'blocked', 6, 1],
    ['over_minute_cap', 'web', 'bots', 'blocked', 30, 1],
  ],
  late_sources: [['api', 'password_guessing', 'blocked', 9]],
  floors: ['flagged_window', 'totals.password_guessing.flagged', 'totals.phishing.flagged'],
  /** What the rows' plain sums would say: the numbers the rules exist to avoid. */
  flagged_unfolded: 21,
  flagged_plain_sum: 450,
} as const;
