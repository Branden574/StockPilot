/**
 * THE SHARED FIXTURE of the attack map's counting rules: twelve made-up rows
 * of the security record and the numbers the database gives for them.
 *
 * The rows and the numbers are the table "The shared fixture" of the
 * migration's contract, row for row. The database's own test (0478/72)
 * builds the same rows and asserts the same numbers; security-map.test.ts
 * applies core's copy of the four lists to them and must get the same. So a
 * list changed on one side only turns one of the two tests red.
 *
 * Made-up places and no organization that exists.
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
  row(6, 'bots', 'blocked', 'over_minute_cap', 'web', null, null, null, 30),
  row(7, 'bots', 'blocked', 'over_buffer_cap', 'web', null, null, null, 6),
];

export const SECURITY_MAP_FIXTURE_EXPECTED = {
  blocked_window: 41,
  flagged_window: 7,
  allowed_window: 0,
  totals: {
    'phishing.flagged': 3,
    'password_guessing.flagged': 4,
    'password_guessing.blocked': 5,
    'bots.blocked': 36,
  },
  no_place: { 'bots.blocked': 36 },
  /** Largest first. */
  by_country: [
    ['US', 'password_guessing', 'blocked', 5],
    ['GB', 'password_guessing', 'flagged', 4],
    ['IT', 'phishing', 'flagged', 2],
    ['PT', 'phishing', 'flagged', 1],
  ],
  tallies: [['too_many_forms_to_count', 'api', 'password_guessing', 'flagged', 400, 1]],
  /** Ordered by reason. */
  flood_rows: [
    ['over_buffer_cap', 'web', 'bots', 'blocked', 6, 1],
    ['over_minute_cap', 'web', 'bots', 'blocked', 30, 1],
  ],
  /** What the rows' plain sum would say: the numbers the rules exist to avoid. */
  flagged_unfolded: 14,
  flagged_with_the_tally: 407,
} as const;
