/**
 * HOW TO RESPOND: the cards. One card per kind of event the security-events
 * record holds, in plain words, in five parts:
 *   1. what this is (two sentences);
 *   2. what StockPilot already did, true of the code today (each sentence is
 *      cited in the build's notes, never here);
 *   3. what to do now (at most four steps; often nothing);
 *   4. if one got through (at most five steps: stop access, make the password
 *      useless, look, clean up, tell);
 *   5. what this cannot tell you.
 *
 * Steps that more than one card uses are written once (SECURITY_RESPONSE_STEPS)
 * and named by id; a card may put a lead-in sentence of its own before one.
 * A step that names a place in the console carries its route; a place in the
 * organization's own app opens only after Act as this org, so the page shows
 * it as text, never as a link. `<organization id>` in a route stands for the
 * organization of the entry the card was opened from.
 *
 * RULES (security-response.test.ts checks the ones a test can): the
 * repository is public, so a card describes the defence and the response,
 * never a technique, and names no unfixed weakness; it claims no automatic
 * action the code does not take; no limit as a number (the words must stay
 * true when a limit changes); no kind called by a hidden kind's name; no
 * emoji; and "stock on record", never the word for a ledger.
 *
 * Imported only by the console's lazily loaded panel
 * (apps/web components/platform/security-response/security-response-panel.tsx),
 * so no page carries this text in its first load.
 */

import type { SecurityResponseCardId } from './security-response';

/** A place a step names: the way there in the console's own labels, and its route. */
export interface SecurityResponsePlace {
  /** "Platform, then Organizations, then the organization, then Users". */
  way: string;
  /** The page as the app's routes spell it. `<organization id>` stands for the entry's organization. */
  route: string;
  /** In the organization's own app: it opens only after Act as this org, so it is never a link. */
  afterActAs: boolean;
}

export const SECURITY_RESPONSE_STEP_IDS = [
  'stop-access',
  'send-reset',
  'look-at-audit',
  'look-at-sign-in-alerts',
  'revoke-api-key',
  'tell-the-owner',
  'ask-member-not-me',
  'check-new-country',
  'member-checks-own-settings',
] as const;
export type SecurityResponseStepId = (typeof SECURITY_RESPONSE_STEP_IDS)[number];

/** A step: its words, the place it is done, and the card it sends you to, when it does. */
export interface SecurityResponseStep {
  text: string;
  place?: SecurityResponsePlace;
  seeCard?: SecurityResponseCardId;
}

/** A card's step: a shared one by id, with the card's own lead-in, or the card's own. */
export type SecurityResponseItem =
  { step: SecurityResponseStepId; lead?: string } | ({ step?: undefined } & SecurityResponseStep);

export interface SecurityResponseCard {
  id: SecurityResponseCardId;
  title: string;
  /** The reason codes this card answers (security-response.ts maps each back to it). */
  reasons: readonly string[];
  whatThisIs: string;
  alreadyDid: readonly string[];
  doNow: readonly SecurityResponseItem[];
  ifGotThrough: readonly SecurityResponseItem[];
  cannotTell: string;
}

const USERS_TAB: SecurityResponsePlace = {
  way: 'Platform, then Organizations, then the organization, then Users',
  route: '/platform/orgs/<organization id>?tab=users',
  afterActAs: false,
};

const SECURITY_PAGE: SecurityResponsePlace = {
  way: 'Platform, then Security',
  route: '/platform/security',
  afterActAs: false,
};

/** The steps more than one card uses, each written once. */
export const SECURITY_RESPONSE_STEPS: Readonly<
  Record<SecurityResponseStepId, SecurityResponseStep>
> = {
  'stop-access': {
    text: "Stop access. On the organization's Users tab, open the User actions menu on the person's row and choose Disable account. It asks for a reason and can ask for a fresh authenticator code. It ends every session that person has, on every device, and blocks sign-in until you choose Re-enable account. If you do not know whose account it was, ask the organization's owner first: the record names no account. An account on the platform admin list cannot be disabled.",
    place: USERS_TAB,
  },
  'send-reset': {
    text: 'Make the password useless. In the same menu, choose Send password reset. It emails the person a link to choose a new password; the old password works until they do. Sending the link ends no session, so disable the account first if someone else may be signed in.',
    place: USERS_TAB,
  },
  'look-at-audit': {
    text: "Look at what was done. After Act as this org, open Audit: the organization's read-only record of privileged actions, such as invites, role changes, stock adjustments and transfers.",
    place: { way: 'Audit', route: '/dashboard/audit', afterActAs: true },
  },
  'look-at-sign-in-alerts': {
    text: 'Look at the sign-ins. After Act as this org, open Settings, then Security, then Sign-in alerts. It lists sign-ins from a new device or a new country, and how each member answered.',
    place: {
      way: 'Settings, then Security, then Sign-in alerts',
      route: '/dashboard/settings/security/sign-ins',
      afterActAs: true,
    },
  },
  'revoke-api-key': {
    text: 'Revoke the key. After Act as this org, open Settings, then Integrations, and press Revoke beside the key under API keys. A revoked key is refused from its next request, and the customer then needs a new key.',
    place: {
      way: 'Settings, then Integrations',
      route: '/dashboard/settings/integrations',
      afterActAs: true,
    },
  },
  'tell-the-owner': {
    text: "Tell the people affected. Write from your own email to the organization's owner, whose email is shown under the organization's name on its page: what happened, what you did, and what they should do.",
    place: {
      way: 'Platform, then Organizations, then the organization',
      route: '/platform/orgs/<organization id>',
      afterActAs: false,
    },
  },
  'ask-member-not-me': {
    text: 'Only if you have a reason to think an account was entered, such as a member reporting odd activity or saying a sign-in was not them: follow the card for a sign-in a member said was not them.',
    seeCard: 'sign-in-not-me',
  },
  'check-new-country': {
    text: 'On the Security page, look in the events list for a Sign-in from a new country in the same hours, in the same organization when there is one.',
    place: SECURITY_PAGE,
  },
  'member-checks-own-settings': {
    text: 'Clean up. Once the member is signed in again, ask them to open Settings, then Security, end any session they do not know under Active sessions, and check their authenticator app and passkeys there.',
  },
};

const NOTHING_STOPPED = { text: 'Nothing: this was stopped.' } as const;

/**
 * Two "already did" lines both refused-file cards share (part 6), each true of
 * every upload path that records one: a copy in storage is deleted unless
 * another record uses the same file or that could not be confirmed (a PO
 * import's shared file, a maintenance photo or evidence whose look failed),
 * and a failed delete leaves it unused; the person is told, except for a
 * cover picture the server fetched during an import, which is left out.
 */
const UPLOAD_COPY_DELETED =
  'A copy that had already reached storage was deleted, unless another record still uses the same file or that could not be confirmed. A delete that storage refuses leaves the copy where it was, unused.';
const UPLOAD_TOLD_AND_RECORDED =
  'The person who sent it was told in a plain sentence that it was refused; a cover picture fetched during an import is just left out. The record keeps the kind of refusal, the organization when there is one, and the time, never the file, its name or what was in it.';

/** The cards, in the order the record lists its reasons. */
export const SECURITY_RESPONSE_CARDS: readonly SecurityResponseCard[] = [
  {
    id: 'wrong-password',
    title: 'Wrong password at sign-in',
    reasons: ['wrong_password'],
    whatThisIs:
      'Someone typed a password the sign-in service did not accept. It is the usual trace of password guessing, and also of a member who forgot their password.',
    alreadyDid: [
      'Blocked: the sign-in was refused and nobody got in.',
      'On the website, the sign-in form also counts tries: after too many in a short time it pauses that email, and that network address.',
      'The record keeps the reason, the place and the time, never the password or the email.',
    ],
    doNow: [
      NOTHING_STOPPED,
      {
        text: 'If the same organization shows many of these in a short time, read the card for repeated wrong guesses.',
        seeCard: 'repeated-wrong-guesses',
      },
    ],
    ifGotThrough: [{ step: 'ask-member-not-me' }],
    cannotTell:
      'It does not say which account was tried or who tried it, and a typing mistake looks the same. The country is where the request came from, which can be a relay. A guess that got the password right is not here; a sign-in from a new device or country raises a sign-in alert instead.',
  },
  {
    id: 'repeated-wrong-guesses',
    title: 'Repeated wrong passwords or codes from one source',
    reasons: ['repeated_wrong_password', 'repeated_wrong_code'],
    whatThisIs:
      'The same source got a password or an authenticator code wrong several times in a short time. That looks like guessing by a person or a program, not a slip.',
    alreadyDid: [
      'Blocked: every one of those tries was refused.',
      'Once a source has a few wrong tries in a short time, the record files its further ones under this heading, so the pattern stands out. They stay blocked.',
      "On the website, the sign-in form's own limits and the limits on code tries for each account also slow the guesser down.",
    ],
    doNow: [
      {
        text: 'Nothing more is needed if the organization shows no sign-in from a new country or a new device in the same hours.',
      },
      { step: 'check-new-country' },
      { text: 'If you find one, treat it as a possible break-in and follow the steps below.' },
    ],
    ifGotThrough: [
      { step: 'stop-access' },
      { step: 'send-reset' },
      { step: 'look-at-sign-in-alerts' },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'A source is a network address kept only as a scrambled label, cleared after about a day, so you cannot tell who it was. Many people behind one address, such as an office or a school, can look like one source.',
  },
  {
    id: 'sign-in-paused',
    title: 'Sign-in paused after too many tries',
    reasons: ['sign_in_paused', 'auth_server_paused', 'auth_rate_limited'],
    whatThisIs:
      'Sign-ins were paused because one email or one network address tried too often in a short time. The pause was set by our sign-in form or by the sign-in service itself.',
    alreadyDid: [
      'Blocked: further tries were refused until the pause ended.',
      'Our sign-in form pauses an email, and a network address, after too many tries in a short time.',
      "The sign-in service has a limit of its own. Its pauses for the phone app, and for anything else that goes to it directly, are read from the service's log once an hour.",
    ],
    doNow: [
      NOTHING_STOPPED,
      {
        text: 'If one organization keeps showing it, a real member may be locked out for a short time. Ask them to wait a little and try again.',
      },
    ],
    ifGotThrough: [
      { step: 'check-new-country', lead: 'A pause does not mean anything got in.' },
      { step: 'ask-member-not-me' },
    ],
    cannotTell:
      "It does not say whose account was tried, and a member who forgot their password and kept trying causes it too. The pauses read from the sign-in service's log appear up to an hour late.",
  },
  {
    id: 'wrong-code',
    title: 'Wrong authenticator code',
    reasons: ['wrong_code'],
    whatThisIs:
      'Someone entered an authenticator code that was not accepted. That usually means the password was right.',
    alreadyDid: [
      'Blocked: the code was refused, so the step it was asked for did not go ahead.',
      'On the website, code tries are limited for each account at each network address, and for each account overall. Past that, checks pause for a while.',
    ],
    doNow: [
      {
        text: 'Ask the member whether they just mistyped. An old code, or a phone whose clock is wrong, is a common cause.',
      },
      {
        text: 'If the member did not try to sign in, treat it as a stolen password and follow the steps below.',
      },
    ],
    ifGotThrough: [
      { step: 'stop-access' },
      { step: 'send-reset' },
      { step: 'look-at-audit' },
      { step: 'member-checks-own-settings' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'The record does not show the account, and it cannot tell a mistype from a guess. A code that was accepted is not recorded here.',
  },
  {
    id: 'signed-in-member-mistake',
    title: 'A signed-in member got a check wrong',
    reasons: ['wrong_current_password', 'wrong_setup_code'],
    whatThisIs:
      'A member who was already signed in gave a wrong current password, or a wrong first code while setting up an authenticator. Most of the time it is a typing mistake.',
    alreadyDid: [
      'Blocked: the change they asked for did not go through.',
      'The current password is asked for before such a change, so an open session alone was not enough to make it.',
    ],
    doNow: [
      { text: 'Nothing: this was stopped, and it needed a signed-in session.' },
      {
        text: 'If one organization shows many of these in a short time, ask the member whether the signed-in session is really theirs.',
      },
    ],
    ifGotThrough: [
      { step: 'stop-access' },
      { step: 'send-reset' },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      "A person at an unattended computer and the account's owner look the same here. Neither the account nor the device is shown.",
  },
  {
    id: 'second-step-paused',
    title: 'Second-step checks paused',
    reasons: ['code_checks_paused', 'recovery_code_checks_paused', 'passkey_checks_paused'],
    whatThisIs:
      'Checks of an authenticator code, a recovery code or a passkey were paused for one account, because there were too many in a short time. The pause keeps codes from being guessed one after another.',
    alreadyDid: [
      'Blocked: further checks were refused until the pause ended.',
      'Authenticator codes, recovery codes and passkeys each have limits of their own for every account.',
    ],
    doNow: [NOTHING_STOPPED, { text: 'Tell the real member to wait a while before trying again.' }],
    ifGotThrough: [
      {
        step: 'stop-access',
        lead: 'Reaching the second step usually takes the right password, so treat it as a possible stolen password.',
      },
      { step: 'send-reset' },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'It does not say whose account it was. A check that was passed is not recorded here.',
  },
  {
    id: 'wrong-recovery-code',
    title: 'Wrong recovery code',
    reasons: ['wrong_recovery_code'],
    whatThisIs:
      'Someone tried a recovery code that was wrong or already used. Recovery codes are the way back into an account whose authenticator was lost.',
    alreadyDid: [
      'Blocked: the code was refused and nothing on the account changed.',
      "A recovery code is checked only for a signed-in session, after the account's password is given again.",
      'Recovery code tries are limited for each account.',
    ],
    doNow: [
      {
        text: 'Ask the member whether they were using a recovery code. If they were, nothing more is needed.',
      },
      {
        text: 'If not, someone may have the password and a signed-in session: follow the steps below.',
      },
    ],
    ifGotThrough: [
      { step: 'stop-access' },
      { step: 'send-reset' },
      { step: 'look-at-audit' },
      {
        text: 'Clean up. Once the member is signed in again, ask them to make new recovery codes under Settings, then Security, then Recovery codes.',
      },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'The record does not show the account or the code. It cannot tell a member who mixed up their codes from someone else.',
  },
  {
    id: 'sign-in-refused-other',
    title: 'Sign-in refused for another reason',
    reasons: ['sign_in_refused_other'],
    whatThisIs:
      'The sign-in service refused a sign-in, and the reason was not a wrong password. A disabled account, or an email that was never confirmed, are examples.',
    alreadyDid: [
      'Blocked: the sign-in was refused.',
      'It is recorded with no organization, so it shows as No organization on the Security page.',
    ],
    doNow: [
      { text: 'Nothing is needed for a single one.' },
      {
        text: 'If it comes soon after you disabled an account, it can be that person trying to sign in.',
      },
    ],
    ifGotThrough: [{ step: 'ask-member-not-me', lead: 'This is not a break-in by itself.' }],
    cannotTell:
      "The record does not keep the service's reason, so a disabled account and an unconfirmed email look the same. It names no account and no organization.",
  },
  {
    id: 'unknown-api-key',
    title: 'Unknown API key',
    reasons: ['unknown_api_key'],
    whatThisIs:
      'Someone sent the public API a key that has the right shape but matches no key. It is a guess, or an old key that no longer exists.',
    alreadyDid: [
      'Blocked: the request was refused as an invalid key, and no data was returned.',
      'Before any key is looked up, each network address has a limit on public API requests.',
      'Revoked and expired keys are refused too.',
    ],
    doNow: [
      NOTHING_STOPPED,
      {
        text: 'If a customer says their integration stopped working, check with them whether their key was revoked or has expired.',
      },
    ],
    ifGotThrough: [
      { step: 'revoke-api-key', lead: 'If a real key may have leaked:' },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'The record does not show the key, the account or the network address. A key that matches nothing names no organization, so it has none here.',
  },
  {
    id: 'passkey-refused',
    title: 'Passkey answer refused',
    reasons: ['passkey_refused'],
    whatThisIs:
      "A passkey answer was refused. A passkey is a sign-in key kept on the member's phone or computer.",
    alreadyDid: [
      'Blocked: the sign-in, or the new passkey, was not accepted.',
      'An answer is refused when it does not check out for this account.',
    ],
    doNow: [
      NOTHING_STOPPED,
      {
        text: 'If the member says their passkey no longer works, ask them to sign in with their password and authenticator, and to set the passkey up again.',
      },
    ],
    ifGotThrough: [{ step: 'ask-member-not-me', lead: 'A refused answer gives no access.' }],
    cannotTell:
      'It does not say which check the answer failed. A member with an old or removed passkey looks the same.',
  },
  {
    id: 'passkey-wrong-site',
    title: 'Passkey answer from another site',
    reasons: ['passkey_wrong_site'],
    whatThisIs:
      "A passkey answer was made for a web address that is not StockPilot's. A passkey works only for the site it was made for, so a copy of our sign-in page elsewhere gets nothing it can use.",
    alreadyDid: [
      'Blocked: the answer was refused and nobody was signed in.',
      'It is recorded as a sign that a member may have been on a look-alike page.',
    ],
    doNow: [
      {
        text: 'If the same organization shows more than one, ask its owner to warn their staff about a look-alike sign-in page.',
      },
      { text: 'Nothing else is needed for a single entry.' },
    ],
    ifGotThrough: [
      {
        step: 'stop-access',
        lead: 'If the member typed their password on that other page, the password is no longer safe.',
      },
      { step: 'send-reset' },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'It does not name the other site or the account, and an unusual browser add-on can cause it too. It is seen only when a passkey answer was made on the other page.',
  },
  {
    id: 'passkey-counter-went-back',
    title: 'Passkey use count went back',
    reasons: ['passkey_counter_went_back'],
    whatThisIs:
      "A passkey answered with a use count lower than the one StockPilot last saw. That can mean the key was copied, or a fault in the member's device.",
    alreadyDid: [
      'The sign-in with that passkey was refused.',
      'It is recorded as flagged rather than blocked, so it stands out: a refused sign-in is not the whole story if a key was copied.',
    ],
    doNow: [
      {
        text: 'Ask the member to remove that passkey and set up a new one, or to sign in another way for now.',
      },
      {
        text: 'If the member cannot explain it, treat it as a copied key and follow the steps below.',
      },
    ],
    ifGotThrough: [
      { step: 'stop-access' },
      { step: 'send-reset' },
      { step: 'look-at-audit' },
      {
        text: 'Clean up. Once the member is signed in again, ask them to remove that passkey under Settings, then Security, then Passkeys.',
      },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'It cannot tell a copied key from a faulty one. It does not show the account or the device.',
  },
  {
    id: 'passkey-unexplained-sign-in',
    title: 'Passkey step passed without a passkey',
    reasons: ['passkey_unexplained_sign_in'],
    whatThisIs:
      "The hourly check found a session whose passkey step passed with no passkey answer in StockPilot's own records. It needs a look, though a fault on our side can look the same.",
    alreadyDid: [
      'Flagged: the finding was recorded and reported to us.',
      'Whether that one session was also ended depends on a platform setting that is off unless it was turned on.',
      "The check never removes a member's passkey or authenticator.",
    ],
    doNow: [
      {
        text: 'On the Security page, look for other entries of the same organization on the same day.',
        place: SECURITY_PAGE,
      },
      {
        text: 'Then follow the steps below: a passkey step nobody can explain is worth treating as a possible break-in.',
      },
    ],
    ifGotThrough: [
      { step: 'stop-access' },
      { step: 'send-reset' },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'It is found up to an hour after the fact. It does not show the account, the device or what the session did.',
  },
  {
    id: 'sign-in-new-country',
    title: 'Sign-in from a new country',
    reasons: ['sign_in_new_country'],
    whatThisIs:
      'A member signed in from a country they had not signed in from before. It is often a trip or a phone on a mobile network, and it can also be someone else using their password.',
    alreadyDid: [
      'Flagged, not blocked: the sign-in itself went ahead.',
      'The member is normally emailed about it, with a "This was not me" button that ends every session of the account.',
      "The organization's owners and admins can see it on its Sign-in alerts page.",
    ],
    doNow: [
      {
        text: "Usually nothing. If you want to be sure, ask the organization's owner whether the member was travelling.",
      },
      {
        text: 'If the same organization also shows wrong passwords or wrong codes just before it, treat it as a possible break-in.',
      },
    ],
    ifGotThrough: [
      {
        text: 'Ask the member to press "This was not me", in the alert email or on their Active sessions page. It ends every session of the account at once.',
      },
      { step: 'stop-access', lead: 'If you cannot reach them:' },
      { step: 'send-reset' },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      "A country is where a request came from, which can be a relay or a company network. A sign-in by someone else from the member's usual country is not flagged.",
  },
  {
    id: 'sign-in-not-me',
    title: 'A member said a sign-in was not them',
    reasons: ['sign_in_not_me'],
    whatThisIs:
      'A member pressed "This was not me" on a sign-in alert. Someone else may have used their password.',
    alreadyDid: [
      'Done: every session of that account was ended.',
      "The alert's new device or new country is forgotten, so the next sign-in from it raises a new alert.",
      "The owners and admins of the member's organizations are told, in the app and by email, and the member is emailed a button to reset their password.",
      "A row is written to the organization's audit.",
    ],
    doNow: [
      { text: 'Make sure the member changes their password: their email has a reset button.' },
      {
        text: 'Ask the member to look at their Active sessions page once they are signed in again.',
      },
    ],
    ifGotThrough: [
      {
        step: 'stop-access',
        lead: 'If access must stay blocked until the password is changed:',
      },
      { step: 'send-reset', lead: 'If the member has not changed their password yet:' },
      { step: 'look-at-audit', lead: 'Look at the time before the button was pressed.' },
      {
        step: 'revoke-api-key',
        lead: "If the account could see the organization's API keys:",
      },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'It covers only a member who noticed the email and pressed the button. It does not show what the other person did before the sessions ended, and the country is where the sign-in came from, which can be a relay.',
  },
  {
    id: 'sign-in-alerts-held',
    title: 'Sign-in alerts held after too many in one day',
    reasons: ['sign_in_alerts_held'],
    whatThisIs:
      'One account had so many sign-ins from new devices or countries in a short time that further ones were not listed or emailed. A member who changed phones or travelled a lot can cause it, and so can someone trying many devices.',
    alreadyDid: [
      'Flagged, not blocked: those sign-ins were not refused.',
      'Each sign-in whose alert was held is counted here, so they are not hidden.',
    ],
    doNow: [
      {
        text: 'On the Security page, look at the same organization for the same day.',
        place: SECURITY_PAGE,
      },
      { text: 'If the member cannot explain it, follow the steps below.' },
    ],
    ifGotThrough: [
      { step: 'stop-access' },
      { step: 'send-reset' },
      { step: 'look-at-sign-in-alerts' },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      "It does not say which account, or how many of those sign-ins were really the member's. The held alerts are not listed one by one.",
  },
  {
    id: 'sign-in-log-unmatched',
    title: 'Refused sign-ins our server has no record of',
    reasons: ['unrecorded_server_form_password', 'unrecorded_server_form_code'],
    whatThisIs:
      "The sign-in service's log holds more refused passwords or codes that look like our own server's than our server recorded. Someone else may have sent them, or our own record missed some.",
    alreadyDid: [
      'Blocked: the sign-in service refused every one of them.',
      'Flagged: the hourly read of that log compares its count with our own record and files the difference here.',
      'This check only counts: it ends and pauses nothing.',
    ],
    doNow: [
      { text: 'Nothing is needed for a small count.' },
      {
        text: 'If the count is large, or comes back hour after hour, read the card for repeated wrong guesses.',
        seeCard: 'repeated-wrong-guesses',
      },
      { text: 'Note it for the next security review, as our own record may have missed some.' },
    ],
    ifGotThrough: [
      { step: 'check-new-country', lead: 'Nothing here names an account or an organization.' },
      { step: 'ask-member-not-me' },
    ],
    cannotTell:
      'It cannot say which accounts were tried or who sent the requests. The log is read once an hour, so the finding is late.',
  },
  {
    id: 'sign-in-log-unusual',
    title: 'Refused sign-in requests of an unusual form',
    reasons: ['unclassified_sign_in_refusals'],
    whatThisIs:
      'The sign-in service refused requests whose form the hourly read of its log does not sort into a known kind. They are counted, not explained.',
    alreadyDid: [
      'Blocked: the sign-in service refused them.',
      'Flagged: they are kept as one count for the hour, since a request that cannot be sorted is called neither an attack nor an error.',
    ],
    doNow: [
      { text: 'Nothing is needed for a small count.' },
      { text: 'If it keeps growing, note it for the next security review.' },
    ],
    ifGotThrough: [
      { step: 'check-new-country', lead: 'No account is named.' },
      { step: 'ask-member-not-me' },
    ],
    cannotTell:
      'It does not say what the requests were, who sent them or which account. A harmless app update that changed the shape of requests can cause it too.',
  },
  {
    id: 'counts-past-limit',
    title: 'Counted, not listed',
    reasons: ['over_minute_cap', 'over_buffer_cap', 'auth_log_over_cap', 'too_many_forms_to_count'],
    whatThisIs:
      'More events came in than the record could list one by one, so they were counted instead. The number is a floor, not an exact figure.',
    alreadyDid: [
      'Each of these events met its own check as it came, and was refused or flagged as the other cards say.',
      'They are kept as a count without a place, so a flood is not hidden.',
    ],
    doNow: [
      {
        text: 'If this is the largest number on the page, something sent a large burst. Look at the other entries of the same minutes on the Security page to see what kind it was.',
        place: SECURITY_PAGE,
      },
      { text: 'Note it for the next security review if it comes back.' },
    ],
    ifGotThrough: [
      {
        text: 'Read the cards of the other kinds that appear in the same minutes, and follow their steps.',
      },
      {
        text: "A flood that the hosting provider's own dashboard shows is handled there, outside this console.",
      },
    ],
    cannotTell:
      "It cannot say what the events were, where they came from or which account. A large honest burst, such as a school's ordering day, can cause it too.",
  },
  {
    id: 'probe-scan',
    title: 'Request for a path this site never serves',
    reasons: ['env_file', 'git_dir', 'wordpress', 'php_file', 'admin_tool', 'path_traversal'],
    whatThisIs:
      'A program asked for a file or a page StockPilot does not have, such as a settings file, source control files, a WordPress page or a database admin tool. Programs ask every public site for these.',
    alreadyDid: [
      'Blocked: the answer was a plain Not found with nothing in it.',
      'These paths are on a fixed list of well-known probes, and each is answered by a small page that records the kind and nothing more.',
      'The exact path, the query and the body are not kept.',
    ],
    doNow: [
      {
        text: 'Nothing: this was stopped. A steady background of these is normal for any public site.',
      },
    ],
    ifGotThrough: [
      { text: 'Nothing was served, so nothing got through from this kind of request.' },
    ],
    cannotTell:
      'A kind is all that is kept: not the path, the network address or the program. Only the probes on the list are noticed here; a request to a page that exists is not.',
  },
  {
    id: 'public-forms-paused',
    title: 'Too many requests to a public form or link',
    reasons: [
      'public_order_paused',
      'public_return_paused',
      'public_catalog_paused',
      'share_link_paused',
      'unsubscribe_paused',
      'support_paused',
      'isbn_lookup_paused',
    ],
    whatThisIs:
      'A source sent too many requests to a public page: the order form, the return form, the catalog, a shared link, an unsubscribe link, the support form or the ISBN lookup. The page held the extra requests back.',
    alreadyDid: [
      'Blocked: the extra requests were refused.',
      'Each of these pages has its own limit, and some are also limited for each email or each link.',
    ],
    doNow: [
      NOTHING_STOPPED,
      {
        text: 'If a real customer says a form told them to wait, ask them to try again a little later.',
      },
    ],
    ifGotThrough: [
      {
        text: 'Look for junk support tickets on the Support page.',
        place: { way: 'Platform, then Support', route: '/platform/support', afterActAs: false },
      },
      {
        text: "Look for junk order requests or returns in the organization's own app, after Act as this org.",
        place: { way: 'Orders', route: '/dashboard/orders', afterActAs: true },
      },
      { step: 'tell-the-owner', lead: "If one organization's public form was flooded:" },
    ],
    cannotTell:
      'It does not say who sent the requests. A busy real day can reach the same limit, and requests under the limit are not shown.',
  },
  {
    id: 'public-api-webhook-paused',
    title: 'Too many requests to the public API or a webhook',
    reasons: ['public_api_paused', 'webhook_paused'],
    whatThisIs:
      'A source sent too many requests to the public API or to the shipping-update webhook. They were held back before any key or signature was checked.',
    alreadyDid: [
      'Blocked: the extra requests were refused.',
      'The limit is counted for each network address, before any key or signature is looked at.',
    ],
    doNow: [
      NOTHING_STOPPED,
      {
        text: 'If a customer says their integration is slow, ask them to make it call less often.',
      },
    ],
    ifGotThrough: [
      { step: 'revoke-api-key', lead: 'If a customer key may have leaked:' },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'It does not say whose integration it was. A customer program that calls too fast looks the same as an attack.',
  },
  {
    id: 'password-reset-paused',
    title: 'Too many password-reset requests',
    reasons: ['password_reset_paused'],
    whatThisIs:
      'A source asked for too many password-reset emails, or tried too many reset completions. The reset page held the extra ones back.',
    alreadyDid: [
      'Blocked: the extra requests were refused.',
      'Reset requests are limited for each email address and for each network address.',
      'A reset link changes nothing until the person opens it and chooses a new password.',
    ],
    doNow: [
      NOTHING_STOPPED,
      {
        text: 'A real member may have been sent several reset emails. If one asks, they can ignore the ones they did not ask for.',
      },
    ],
    ifGotThrough: [
      {
        step: 'stop-access',
        lead: 'A reset link nobody opened changes nothing. If a member says their password was reset and they did not do it:',
      },
      { step: 'look-at-audit' },
      { step: 'tell-the-owner' },
    ],
    cannotTell:
      'It does not say which email address was asked for. A member who keeps pressing the button reaches the limit too.',
  },
  {
    id: 'sign-in-alert-link-paused',
    title: 'Too many requests to a sign-in alert link',
    reasons: ['sign_in_alert_paused'],
    whatThisIs:
      'A source sent too many requests to the page a sign-in alert\'s "This was not me" button opens. The page held the extra requests back.',
    alreadyDid: [
      'Blocked: the extra requests were refused.',
      "The button works once for each alert, so pressing it again cannot end the account's sessions again and again.",
    ],
    doNow: [NOTHING_STOPPED],
    ifGotThrough: [
      {
        text: 'If a member got a sign-in alert they did not expect, read the card for a sign-in a member said was not them.',
        seeCard: 'sign-in-not-me',
      },
    ],
    cannotTell: 'It does not show the alert or the account.',
  },
  {
    // The general card of the kind (security-response.ts): it describes the
    // kind and claims no outcome; each reason's own card says what was done.
    id: 'upload-checks',
    title: 'A file the upload checks refused or could not check',
    reasons: [],
    whatThisIs:
      'StockPilot reads most files sent to it with its own file checks before anything uses them. This kind counts the files those checks refused, or could not finish checking.',
    alreadyDid: [
      'What was done with each file depends on the reason of its entry: open the entry in the events list to read the card of that reason.',
      'The record keeps the kind of refusal, the organization when there is one, and the time, never the file, its name or what was in it.',
    ],
    doNow: [
      {
        text: 'On the Security page, open the entries of this kind in the events list and read the card of each reason.',
        place: SECURITY_PAGE,
      },
      { text: 'A run of them from one organization in a short time is worth a look, whatever the reason.' },
      {
        step: 'tell-the-owner',
        lead: 'If one organization has a run of them, ask whether they know where the files came from:',
      },
    ],
    ifGotThrough: [
      {
        text: "The card of each reason says what to do if one of its files may have reached the organization another way, such as by email.",
      },
    ],
    cannotTell:
      'It does not say who sent a file, what it was called or what was in it. The checks read what kind of file it is and how it is built; they hold no list of known viruses, so a file they pass is not proven safe.',
  },
  {
    id: 'upload-refused',
    title: 'A file was refused at upload',
    reasons: ['upload_wrong_type', 'upload_active_content', 'upload_hidden_file'],
    whatThisIs:
      "A file sent to StockPilot was refused by the app's own file checks: it was not a kind of file that part of the app takes, or it carried a script, a macro or another file inside it. An honest file can be refused too, such as a PDF sent where only pictures are taken.",
    alreadyDid: [
      'Blocked: the file was refused before anything used it. It was not attached, shown, imported or passed on.',
      UPLOAD_COPY_DELETED,
      "The checks decide from the file's own bytes: no name, and no type a browser or the phone claims, can make a file pass.",
      UPLOAD_TOLD_AND_RECORDED,
    ],
    doNow: [
      NOTHING_STOPPED,
      {
        step: 'tell-the-owner',
        lead: 'If one organization has many of these in a short time, someone may be sending such files on purpose, or a supplier keeps sending documents that cannot be taken:',
      },
    ],
    ifGotThrough: [
      { text: 'The refused file was not used for anything in StockPilot.' },
      {
        step: 'tell-the-owner',
        lead: 'If the same file may have reached the organization another way, such as by email, ask them not to open it:',
      },
      { step: 'ask-member-not-me' },
    ],
    cannotTell:
      'It does not say who sent the file, what it was called or what was in it. The checks read what kind of file it is and how it is built; they hold no list of known viruses, so a file they pass is not proven safe.',
  },
  {
    id: 'upload-not-checked',
    title: 'A file was refused because it could not be checked',
    reasons: ['upload_could_not_check'],
    whatThisIs:
      "A file sent to StockPilot was refused because the app's own file checks could not finish reading it: it was locked with a password, too large or too complex to read safely, or not put together the way its kind should be. An honest file can do this, and so can a file built to wear a checker out, and this alone does not say which.",
    alreadyDid: [
      'Blocked: the file was refused because the checks could not finish, and nothing used it. It was not attached, shown, imported or passed on.',
      UPLOAD_COPY_DELETED,
      'The checks stop after a set amount of time and work on one file, and a file that reaches that point is refused, never let through.',
      UPLOAD_TOLD_AND_RECORDED,
    ],
    doNow: [
      { text: 'The file was refused because the checks could not finish, so it was not used.' },
      {
        text: 'On the Security page, look in the events list for more of these from the same organization.',
        place: SECURITY_PAGE,
      },
      {
        text: 'One now and then is usually an honest file, such as a password-protected PDF. A run of them is worth a look: a file built to wear out a checker is itself a sign, even though no single one shows what was inside.',
      },
      {
        step: 'tell-the-owner',
        lead: 'If one organization has a run of them, ask whether they know where the files came from:',
      },
    ],
    ifGotThrough: [
      { text: 'A file that could not be checked was refused, not let through, so it was not used for anything in StockPilot.' },
      { step: 'ask-member-not-me' },
    ],
    cannotTell:
      'It does not say whether the file was harmful, who sent it, what it was called or what was in it. The checks read what kind of file it is and how it is built; they hold no list of known viruses.',
  },
];

/** A card by id. */
export function securityResponseCard(id: SecurityResponseCardId): SecurityResponseCard {
  const card = SECURITY_RESPONSE_CARDS.find((c) => c.id === id);
  if (!card) throw new Error(`No response card ${id}`);
  return card;
}

/** One step of a card, ready to show: the shared step's words with the card's lead-in, or the card's own. */
export interface SecurityResponseStepShown {
  /** The shared step's id, or null for the card's own. */
  id: SecurityResponseStepId | null;
  lead: string | null;
  text: string;
  place: SecurityResponsePlace | null;
  seeCard: SecurityResponseCardId | null;
}

export function securityResponseStepShown(item: SecurityResponseItem): SecurityResponseStepShown {
  if (item.step !== undefined) {
    const shared = SECURITY_RESPONSE_STEPS[item.step];
    return {
      id: item.step,
      lead: item.lead ?? null,
      text: shared.text,
      place: shared.place ?? null,
      seeCard: shared.seeCard ?? null,
    };
  }
  return {
    id: null,
    lead: null,
    text: item.text,
    place: item.place ?? null,
    seeCard: item.seeCard ?? null,
  };
}

/** Every route a card names, with the card it is in, for the route check. */
export function securityResponseRoutes(): Array<{
  card: SecurityResponseCardId;
  place: SecurityResponsePlace;
}> {
  return SECURITY_RESPONSE_CARDS.flatMap((card) =>
    [...card.doNow, ...card.ifGotThrough]
      .map((item) => securityResponseStepShown(item).place)
      .filter((place): place is SecurityResponsePlace => place !== null)
      .map((place) => ({ card: card.id, place })),
  );
}
