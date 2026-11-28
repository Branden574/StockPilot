/**
 * HOW TO RESPOND, the small part: which card answers each reason code of the
 * security-events record, each card's urgency level, the general card of
 * each kind, and the words of the control that opens a card. No card's text
 * is here: that is security-response-cards.ts, which only the console's
 * lazily loaded panel imports, so a page that shows the control does not
 * carry the cards in its first load.
 *
 * Every reason code the record holds today (SECURITY_EVENT_REASON_LABELS)
 * maps to exactly one card, and every card answers at least one reason or is
 * the general card of a kind (security-response.test.ts pins both). A reason
 * this build does not know has no card: the page shows no control for it
 * rather than a wrong card.
 */

import type { SecurityEventCategory } from './security-events';

/** The cards, by id. Their text is in security-response-cards.ts. */
export const SECURITY_RESPONSE_CARD_IDS = [
  'wrong-password',
  'repeated-wrong-guesses',
  'sign-in-paused',
  'wrong-code',
  'signed-in-member-mistake',
  'second-step-paused',
  'wrong-recovery-code',
  'sign-in-refused-other',
  'unknown-api-key',
  'passkey-refused',
  'passkey-wrong-site',
  'passkey-counter-went-back',
  'passkey-unexplained-sign-in',
  'sign-in-new-country',
  'sign-in-not-me',
  'sign-in-alerts-held',
  'sign-in-log-unmatched',
  'sign-in-log-unusual',
  'counts-past-limit',
  'probe-scan',
  'public-forms-paused',
  'public-api-webhook-paused',
  'password-reset-paused',
  'sign-in-alert-link-paused',
  'upload-checks',
  'upload-refused',
  'upload-not-checked',
  'upload-refused-in-use',
] as const;
export type SecurityResponseCardId = (typeof SECURITY_RESPONSE_CARD_IDS)[number];

/**
 * How soon a card asks for a look, a closed list (the coordinator's design of
 * 2026-11-24):
 *   - act_now: something may have got through, and the steps should be done today;
 *   - look_today: not stopped, or not explained: decide after a look;
 *   - stopped: blocked, and nothing needs doing.
 */
export const SECURITY_RESPONSE_LEVELS = ['act_now', 'look_today', 'stopped'] as const;
export type SecurityResponseLevel = (typeof SECURITY_RESPONSE_LEVELS)[number];

/** Each level in words. The page draws a shape beside them as well, never a colour alone. */
export const SECURITY_RESPONSE_LEVEL_WORDS: Readonly<Record<SecurityResponseLevel, string>> = {
  act_now: 'Act now',
  look_today: 'Look today',
  stopped: 'Stopped: nothing to do',
};

/** Every card's one level. */
export const SECURITY_RESPONSE_CARD_LEVELS: Readonly<
  Record<SecurityResponseCardId, SecurityResponseLevel>
> = {
  'sign-in-not-me': 'act_now',
  'passkey-unexplained-sign-in': 'act_now',
  'passkey-counter-went-back': 'act_now',
  'sign-in-new-country': 'look_today',
  'sign-in-alerts-held': 'look_today',
  'repeated-wrong-guesses': 'look_today',
  'wrong-code': 'look_today',
  'wrong-recovery-code': 'look_today',
  'second-step-paused': 'look_today',
  'passkey-wrong-site': 'look_today',
  'sign-in-log-unmatched': 'look_today',
  'sign-in-log-unusual': 'look_today',
  'counts-past-limit': 'look_today',
  'wrong-password': 'stopped',
  'sign-in-paused': 'stopped',
  'signed-in-member-mistake': 'stopped',
  'sign-in-refused-other': 'stopped',
  'unknown-api-key': 'stopped',
  'passkey-refused': 'stopped',
  'probe-scan': 'stopped',
  'public-forms-paused': 'stopped',
  'public-api-webhook-paused': 'stopped',
  'password-reset-paused': 'stopped',
  'sign-in-alert-link-paused': 'stopped',
  // Part 6. The kind's general card asks for a look at the entries of the kind;
  // a file the checks could not finish is a look, never "nothing to do".
  'upload-checks': 'look_today',
  'upload-refused': 'stopped',
  'upload-not-checked': 'look_today',
  // Review round 2: refused, but an earlier record still points at the file.
  'upload-refused-in-use': 'look_today',
};

/** Every reason code of the record, with the card that answers it. */
export const SECURITY_RESPONSE_CARD_OF_REASON: Readonly<Record<string, SecurityResponseCardId>> = {
  wrong_password: 'wrong-password',
  repeated_wrong_password: 'repeated-wrong-guesses',
  repeated_wrong_code: 'repeated-wrong-guesses',
  sign_in_paused: 'sign-in-paused',
  auth_server_paused: 'sign-in-paused',
  auth_rate_limited: 'sign-in-paused',
  wrong_code: 'wrong-code',
  wrong_current_password: 'signed-in-member-mistake',
  wrong_setup_code: 'signed-in-member-mistake',
  code_checks_paused: 'second-step-paused',
  recovery_code_checks_paused: 'second-step-paused',
  passkey_checks_paused: 'second-step-paused',
  wrong_recovery_code: 'wrong-recovery-code',
  sign_in_refused_other: 'sign-in-refused-other',
  unknown_api_key: 'unknown-api-key',
  passkey_refused: 'passkey-refused',
  passkey_wrong_site: 'passkey-wrong-site',
  passkey_counter_went_back: 'passkey-counter-went-back',
  passkey_unexplained_sign_in: 'passkey-unexplained-sign-in',
  sign_in_new_country: 'sign-in-new-country',
  sign_in_not_me: 'sign-in-not-me',
  sign_in_alerts_held: 'sign-in-alerts-held',
  unrecorded_server_form_password: 'sign-in-log-unmatched',
  unrecorded_server_form_code: 'sign-in-log-unmatched',
  unclassified_sign_in_refusals: 'sign-in-log-unusual',
  over_minute_cap: 'counts-past-limit',
  over_buffer_cap: 'counts-past-limit',
  auth_log_over_cap: 'counts-past-limit',
  too_many_forms_to_count: 'counts-past-limit',
  env_file: 'probe-scan',
  git_dir: 'probe-scan',
  wordpress: 'probe-scan',
  php_file: 'probe-scan',
  admin_tool: 'probe-scan',
  path_traversal: 'probe-scan',
  public_order_paused: 'public-forms-paused',
  public_return_paused: 'public-forms-paused',
  public_catalog_paused: 'public-forms-paused',
  share_link_paused: 'public-forms-paused',
  unsubscribe_paused: 'public-forms-paused',
  support_paused: 'public-forms-paused',
  isbn_lookup_paused: 'public-forms-paused',
  public_api_paused: 'public-api-webhook-paused',
  webhook_paused: 'public-api-webhook-paused',
  password_reset_paused: 'password-reset-paused',
  sign_in_alert_paused: 'sign-in-alert-link-paused',
  upload_wrong_type: 'upload-refused',
  upload_active_content: 'upload-refused',
  upload_hidden_file: 'upload-refused',
  upload_could_not_check: 'upload-not-checked',
  upload_refused_in_use: 'upload-refused-in-use',
};

/**
 * The general card of each kind, opened from the kind in the map's legend:
 * the card that best answers "this kind is on the map: what do I do?".
 *   - Password guessing: repeated wrong guesses, the pattern the kind is
 *     about, with the full steps for a break-in;
 *   - Exploit attempts: the probe card, the only one of the kind;
 *   - Automated traffic: the public forms card, the most reasons of the kind;
 *   - the sign-in alerts' kind: a sign-in from a new country (the map's
 *     legend does not list that kind: it is opened from the legend's grey
 *     "Flagged sign-in alert" item, SECURITY_RESPONSE_SIGN_IN_ALERT_CARD);
 *   - Malware (part 6): a card of its own that describes the kind, a file
 *     the upload checks refused or could not check, and claims no outcome:
 *     what was done is on each reason's card (upload-refused,
 *     upload-not-checked). It answers no reason of its own.
 */
export const SECURITY_RESPONSE_GENERAL_CARD: Readonly<
  Record<SecurityEventCategory, SecurityResponseCardId | null>
> = {
  password_guessing: 'repeated-wrong-guesses',
  exploit: 'probe-scan',
  bots: 'public-forms-paused',
  phishing: 'sign-in-new-country',
  malware: 'upload-checks',
};

/**
 * The card the legend's "Flagged sign-in alert" item opens: the general card
 * of the kind those alerts are of, which the page never names.
 */
export const SECURITY_RESPONSE_SIGN_IN_ALERT_CARD: SecurityResponseCardId =
  SECURITY_RESPONSE_GENERAL_CARD.phishing ?? 'sign-in-new-country';

/** The card for a reason code, or null for a reason this build does not know. */
export function securityResponseCardIdFor(reason: unknown): SecurityResponseCardId | null {
  return typeof reason === 'string' &&
    Object.prototype.hasOwnProperty.call(SECURITY_RESPONSE_CARD_OF_REASON, reason)
    ? (SECURITY_RESPONSE_CARD_OF_REASON[reason] ?? null)
    : null;
}

/** A reason's level, through its card, or null for a reason this build does not know. */
export function securityResponseLevelFor(reason: unknown): SecurityResponseLevel | null {
  const id = securityResponseCardIdFor(reason);
  return id === null ? null : SECURITY_RESPONSE_CARD_LEVELS[id];
}

/** The control's words, and the panel's own labels. */
export const SECURITY_RESPONSE_WORDS = {
  open: 'How to respond',
  /** The control's accessible name: the visible words first, then what it is for. */
  openFor: (what: string): string => `How to respond: ${what}`,
  close: 'Close',
  back: 'Back',
  loading: 'Loading the card...',
  contextTitle: 'Opened from',
  kind: 'Kind',
  where: 'Where',
  when: 'When',
  organization: 'Organization',
  /** Under "Opened from", for an entry recorded in several organizations (the record gives a count, not names). */
  severalOrganizations: (n: number): string =>
    `Recorded in ${n} organizations. The record says how many, not which, so the steps show the page to open, not a link.`,
  whatThisIs: 'What this is',
  alreadyDid: 'What StockPilot already did',
  doNow: 'What to do now',
  ifGotThrough: 'If one got through',
  cannotTell: 'What this cannot tell you',
  nothingToDo: 'Nothing.',
  seeCard: 'Open that card',
  afterActAs: 'After Act as this org',
  actAsNote:
    "Steps marked After Act as this org open in the organization's own app. On the organization's page, choose Act as this org: it asks you to confirm, can ask for a fresh authenticator code, gives you owner access to that organization for a short time, and is written to the platform audit.",
  levelLabel: 'Urgency',
} as const;
