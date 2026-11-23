/**
 * The shared security-events record (public.security_events, written only by
 * record_security_events(jsonb)): the words of every category, outcome,
 * source and reason code, for the pages that show the rows.
 *
 * The database checks a category, outcome and source against its own lists
 * (the same lists as below) and a reason against REASON_CODE_RE; it never
 * checks a reason against this list. So a page reads every value through the
 * label helpers below, which answer a neutral label for a value this build
 * does not know (a later detector, an overflow row) instead of failing.
 *
 * Never an address, an email, an account, a path or a user agent: a row has
 * no column for one, and nothing here names one.
 */

export const SECURITY_EVENT_CATEGORIES = [
  'password_guessing',
  'exploit',
  'bots',
  'phishing',
  'malware',
] as const;
export type SecurityEventCategory = (typeof SECURITY_EVENT_CATEGORIES)[number];

export const SECURITY_EVENT_OUTCOMES = ['blocked', 'allowed', 'flagged'] as const;
export type SecurityEventOutcome = (typeof SECURITY_EVENT_OUTCOMES)[number];

/** Where the event was seen. email and edge are for the later outside feeds. */
export const SECURITY_EVENT_SOURCES = ['web', 'phone', 'api', 'email', 'edge'] as const;
export type SecurityEventSource = (typeof SECURITY_EVENT_SOURCES)[number];

/** A reason code, as the database's own check spells it. */
export const SECURITY_EVENT_REASON_RE = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * What a scanner asked for, by the kind of path (the probe answers under
 * /api/security/probe/<kind>). Each kind is also the event's reason.
 */
export const SECURITY_PROBE_KINDS = [
  'env_file',
  'git_dir',
  'wordpress',
  'php_file',
  'admin_tool',
  'path_traversal',
] as const;
export type SecurityProbeKind = (typeof SECURITY_PROBE_KINDS)[number];

/**
 * The anonymous endpoint families whose limiter refusals are recorded as
 * automated traffic. Each family's reason is `<family>_paused`.
 */
export const SECURITY_BOT_FAMILIES = [
  'public_order',
  'public_return',
  'public_catalog',
  'share_link',
  'unsubscribe',
  'support',
  'password_reset',
  'public_api',
  'webhook',
  'isbn_lookup',
  'sign_in_alert',
] as const;
export type SecurityBotFamily = (typeof SECURITY_BOT_FAMILIES)[number];

export function securityBotReason(family: SecurityBotFamily): `${SecurityBotFamily}_paused` {
  return `${family}_paused`;
}

const CATEGORY_LABELS: Readonly<Record<SecurityEventCategory, string>> = {
  password_guessing: 'Password guessing',
  exploit: 'Exploit attempts',
  bots: 'Automated traffic',
  phishing: 'Phishing',
  malware: 'Malware',
};

const OUTCOME_LABELS: Readonly<Record<SecurityEventOutcome, string>> = {
  blocked: 'Blocked',
  allowed: 'Allowed',
  flagged: 'Flagged',
};

const SOURCE_LABELS: Readonly<Record<SecurityEventSource, string>> = {
  web: 'Website',
  phone: 'Mobile app',
  api: 'API',
  email: 'Email',
  edge: 'Network edge',
};

const BOT_FAMILY_WORDS: Readonly<Record<SecurityBotFamily, string>> = {
  public_order: 'the public order form',
  public_return: 'the public return form',
  public_catalog: 'the public catalog',
  share_link: 'a shared link',
  unsubscribe: 'an unsubscribe link',
  support: 'the support form',
  password_reset: 'password reset',
  public_api: 'the public API',
  webhook: 'a webhook',
  isbn_lookup: 'the ISBN lookup',
  sign_in_alert: 'a sign-in alert link',
};

/**
 * The passkey refusals the web records (apps/web server/security/passkeys.ts):
 * an answer refused, an answer from another site (category phishing), a
 * counter that went back (outcome flagged), and the checks paused by the
 * passkey limiter. The hourly check (server/security/passkey-detector.ts)
 * records a session whose passkey step passed with no passkey answer of ours
 * (outcome flagged).
 */
export const PASSKEY_SECURITY_EVENT_REASON_LABELS: Readonly<Record<string, string>> = {
  passkey_refused: 'Passkey answer refused',
  passkey_wrong_site: 'Passkey answer from another site',
  passkey_counter_went_back: 'Passkey counter went back (a copied key?)',
  passkey_checks_paused: 'Passkey checks paused after too many attempts',
  passkey_unexplained_sign_in: 'Passkey step passed without a passkey (found by the hourly check)',
};

/** The reason codes this build writes, with the words admins read. */
export const SECURITY_EVENT_REASON_LABELS: Readonly<Record<string, string>> = {
  // Password guessing.
  wrong_password: 'Wrong password at sign-in',
  repeated_wrong_password: 'Repeated wrong passwords from one source',
  sign_in_paused: 'Sign-in paused after too many attempts',
  auth_server_paused: 'Sign-in paused by the sign-in service',
  wrong_code: 'Wrong authenticator code',
  repeated_wrong_code: 'Repeated wrong authenticator codes from one source',
  code_checks_paused: 'Authenticator code checks paused after too many attempts',
  wrong_recovery_code: 'Wrong recovery code',
  recovery_code_checks_paused: 'Recovery code checks paused after too many attempts',
  // A signed-in member, asked for the current password or for the first code
  // of a new authenticator, got it wrong; and a sign-in the sign-in service
  // refused for a reason that is not a wrong password (recorded with no
  // organization).
  wrong_current_password: 'Wrong current password entered by a signed-in member',
  wrong_setup_code: 'Wrong code while setting up an authenticator',
  sign_in_refused_other: 'Sign-in refused for another reason',
  // Passkeys (the web's second step).
  ...PASSKEY_SECURITY_EVENT_REASON_LABELS,
  unknown_api_key: 'Unknown API key',
  // One account met its daily ceiling on sign-in alerts: so many sign-ins from
  // new devices or countries in a day that further ones are turned away
  // unrecorded (flagged, not blocked: the sign-in itself still happened).
  sign_in_alerts_held: 'Sign-in alerts held after too many in one day',
  // Phishing: what a sign-in alert flags (part 3). Not refusals: the sign-in
  // happened, and the alert asks the member whether it was them.
  sign_in_new_country: 'Sign-in from a new country',
  sign_in_not_me: 'A member said a sign-in was not them',
  // Read from the sign-in service's own log (the phone app and direct
  // callers): its own limit refused the attempt, or more refusals came in one
  // hour than could be listed one by one. Stored as flagged, never as blocked
  // attacks: refused requests of a form the job does not classify, and
  // refusals that carried our server's marks and that our server has no
  // record of. Those last words are chosen to be true whoever sent them:
  // someone presenting our server's marks, or our own server when its record
  // of a refusal was lost. And an hour whose refused requests could not all
  // be counted (the count read was full, or a part of it could not be read):
  // its number is the requests that were counted, and its other counts may
  // be short.
  auth_rate_limited: 'Too many sign-in attempts, paused by the sign-in service',
  auth_log_over_cap: 'More refused sign-ins than could be listed',
  unclassified_sign_in_refusals: 'Refused sign-in requests of an unusual form',
  unrecorded_server_form_password:
    "Refused sign-ins in our server's form that our server has no record of",
  unrecorded_server_form_code:
    "Refused authenticator codes in our server's form that our server has no record of",
  too_many_forms_to_count: 'Refused sign-in requests in an hour that could not all be counted',
  // Exploit attempts: a scanner asked for a path this site never serves.
  env_file: 'Request for a settings file',
  git_dir: 'Request for source control files',
  wordpress: 'Request for WordPress pages',
  php_file: 'Request for a PHP script',
  admin_tool: 'Request for a database admin tool',
  path_traversal: 'Request for files outside the site',
  // Automated traffic: an anonymous endpoint's limiter refused.
  ...Object.fromEntries(
    SECURITY_BOT_FAMILIES.map((family) => [
      securityBotReason(family),
      `Too many requests to ${BOT_FAMILY_WORDS[family]}`,
    ]),
  ),
  // More events than one minute's rows (the database) or one instance's
  // buffer (the web server) could list one by one: counted, not itemised.
  over_minute_cap: 'More events than could be listed',
  over_buffer_cap: 'More events than could be listed',
};

/** The words for a reason this build does not know. */
export const SECURITY_EVENT_UNKNOWN_REASON_LABEL = 'Other blocked activity';

function own(map: Readonly<Record<string, string>>, key: unknown): string | null {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key)
    ? (map[key] ?? null)
    : null;
}

export function securityEventReasonLabel(reason: unknown): string {
  return own(SECURITY_EVENT_REASON_LABELS, reason) ?? SECURITY_EVENT_UNKNOWN_REASON_LABEL;
}

export function securityEventCategoryLabel(category: unknown): string {
  return own(CATEGORY_LABELS, category) ?? 'Other';
}

export function securityEventOutcomeLabel(outcome: unknown): string {
  return own(OUTCOME_LABELS, outcome) ?? 'Other';
}

export function securityEventSourceLabel(source: unknown): string {
  return own(SOURCE_LABELS, source) ?? 'Other';
}

export function isSecurityEventCategory(value: unknown): value is SecurityEventCategory {
  return (SECURITY_EVENT_CATEGORIES as readonly unknown[]).includes(value);
}

export function isSecurityEventOutcome(value: unknown): value is SecurityEventOutcome {
  return (SECURITY_EVENT_OUTCOMES as readonly unknown[]).includes(value);
}

export function isSecurityEventSource(value: unknown): value is SecurityEventSource {
  return (SECURITY_EVENT_SOURCES as readonly unknown[]).includes(value);
}

export function isSecurityProbeKind(value: unknown): value is SecurityProbeKind {
  return (SECURITY_PROBE_KINDS as readonly unknown[]).includes(value);
}

/**
 * Where a row's events came from, in words: "City, CC", the country alone,
 * or "Unknown place". A country that is not two capital letters, or a city
 * with no country, is shown as it can be, never guessed.
 */
export function securityEventPlaceLabel(country: unknown, city: unknown): string {
  const cc = typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null;
  const town = typeof city === 'string' && city.trim().length > 0 ? city.trim() : null;
  if (town && cc) return `${town}, ${cc}`;
  if (cc) return cc;
  if (town) return town;
  return 'Unknown place';
}
