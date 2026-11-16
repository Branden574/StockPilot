/**
 * Deleting your own account: the words, shared by the website, the API and
 * the phone, and the one reading of the API's answers for the phone.
 *
 * How a deletion is confirmed is decided on the server
 * (apps/web/src/server/lib/account-deletion-credential.ts): an account with an
 * authenticator needs its code entered (aal2); an account with none confirms
 * with its current password or a six-digit code emailed to it.
 *
 * PURE: strings, one pattern and one mapper, no platform imports. Never
 * "book" for a recorded quantity. None of these sentences says whether an
 * account has a password.
 */

/* ───────────────────────── the website's dialog and card ───────────────────────── */

/**
 * The consent text in the website's "Delete your account?" dialog. Only some
 * records show "Deleted user" (stock movements, received stock, purchase
 * order imports, the audit log, order timelines, schedule entries, returns);
 * others keep the name or email they were made with, or show no name. This is
 * the text a person agrees to before an irreversible deletion, so it names
 * where the label shows and says that some records keep a name or email.
 */
export const DELETE_ACCOUNT_DIALOG_COPY = {
  kept:
    'This deletes your account and removes your access immediately. Records you made stay with your organization. ' +
    'On stock movements, received stock, purchase order imports and the audit log they show “Deleted user” instead of your name. ' +
    'Some records keep the name or email they were made with, such as maintenance requests and older orders, and some show no name.',
  released:
    'Counts, picks and deliveries assigned to you become unassigned so someone else can finish them.',
  owner:
    'If you are the only owner of an organization with other members, transfer ownership first: on the Team page, ' +
    'choose Transfer ownership on another member, or remove the other members.',
} as const;

/** The same consent, on the website's Settings > Profile card. */
export const DELETE_ACCOUNT_CARD_COPY =
  'Permanently delete your account and your access to StockPilot. Records you made stay with your organization: ' +
  'stock movements, received stock and the audit log show “Deleted user” instead of your name, and some records, ' +
  'such as maintenance requests, keep the name or email they were made with. If you are the only owner of an ' +
  'organization with other members, transfer ownership on the Team page first.';

/**
 * Each send makes a new code and only the newest one works. One sentence, in
 * the dialog's codeSent (and so the code route's answer) and in the code email.
 */
export const DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY = 'If you ask again, only the newest code works.';

/**
 * The answer to a person who asked for a code too often (the send limit), on
 * the website and the code route. The limit on tries keeps its own sentence.
 */
export const DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY =
  'Too many codes requested. Try again in a few minutes, or enter your password.';

/**
 * The words around confirming a deletion in the website's dialog, for an
 * account with no authenticator: its password, or a code emailed to it.
 */
export const DELETE_ACCOUNT_CONFIRM_COPY = {
  passwordLabel: 'Your password',
  passwordHint:
    'Enter your password to confirm. If you have no password or do not remember it, use a code instead.',
  emailCode: 'Email me a code instead',
  codeLabel: 'Code from your email',
  codeSent: `We sent a six-digit code to your sign-in email. It works for 10 minutes. ${DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY}`,
  sendAgain: 'Send a new code',
  usePassword: 'Use my password instead',
} as const;

/** An emailed deletion code: exactly six digits. */
export const ACCOUNT_DELETE_CODE_RE = /^[0-9]{6}$/;

/* ───────────────────────── the server's answers ───────────────────────── */

/** Confirming with a password or an emailed code. They never say whether an account has a password. */
export const ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY =
  'Enter your password, or ask for a code by email, to confirm. Nothing was deleted.';
export const ACCOUNT_DELETE_PASSWORD_REFUSED_COPY =
  'That password is not correct. Nothing was deleted. You can ask for a code by email instead.';
export const ACCOUNT_DELETE_CODE_REFUSED_COPY =
  'That code is not correct or has expired. Nothing was deleted. Ask for a new code and try again.';
export const ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY =
  'Too many tries. Nothing was deleted. Wait a few minutes and try again.';
export const ACCOUNT_DELETE_CREDENTIAL_CHECK_FAILED_COPY =
  'Could not check that just now. Nothing was deleted. Try again in a minute.';
export const ACCOUNT_DELETE_AAL2_COPY =
  'Enter your authenticator code before deleting your account. Nothing was deleted.';
/** The dialog's own sentence (DELETE_ACCOUNT_CONFIRM_COPY.codeSent). */
export const ACCOUNT_DELETE_CODE_SENT_COPY = DELETE_ACCOUNT_CONFIRM_COPY.codeSent;
/** Too many codes asked for (the send limit); the try limit says CREDENTIAL_PAUSED_COPY. */
export const ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY = DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY;
export const ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY =
  'Your account has an authenticator, so deleting it is confirmed with your authenticator code.';
export const ACCOUNT_DELETE_CODE_SEND_FAILED_COPY =
  'The code could not be sent just now. Try again in a few minutes, or enter your password.';

/** The phone's delete route answers a body without the typed word with this. */
export const ACCOUNT_DELETE_TYPE_DELETE_COPY = 'Type DELETE to confirm.';

/** A record still refuses the deletion (unexpected: every refusing key releases). */
export const ACCOUNT_DELETE_BLOCKED_COPY =
  'Your account could not be deleted because it is linked to a record that could not be released. Nothing was changed. Contact StockPilot support.';
/**
 * The only owner of an organization with other members, when the app could
 * not name the organization (website). The Team page's control is a member
 * row's "Transfer ownership…", and removing the other members also lets the
 * account go, so the sentence names both.
 */
export const ACCOUNT_DELETE_LAST_OWNER_COPY =
  'You are the only owner of an organization that has other members. On the Team page, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.';
/** The same for the phone, where ownership is transferred on the website. */
export const ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE =
  'You are the only owner of an organization that has other members. On the Team page on the web, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.';
/** The owner check could not be read (website and phone): nothing changed. */
export const ACCOUNT_DELETE_OWNER_CHECK_FAILED_COPY =
  'Could not check the organizations you own. Nothing was deleted. Try again.';
/** A platform admin's account is not deleted while its email is on the allowlist. */
export const ACCOUNT_DELETE_PLATFORM_ADMIN_COPY =
  'This account is a StockPilot platform admin. Remove it from the platform admin list before deleting it. Nothing was changed.';
export const ACCOUNT_DELETE_RETRY_COPY =
  'Your account could not be deleted right now. Nothing was changed. Try again in a minute.';
/** After a delete that failed: the account's sessions were ended. */
export const ACCOUNT_DELETE_SIGNED_OUT_COPY =
  'Your account could not be deleted right now. You have been signed out; nothing else changed. Try again in a minute.';

/* ───────────────────────── the phone's reading of the answers ───────────────────────── */

/**
 * The send limit's sentence for the phone, where the account may have no
 * password: it points to a new code first.
 */
export const ACCOUNT_DELETE_CODE_SEND_PAUSED_NO_PASSWORD_COPY =
  'Too many codes requested. Wait a few minutes, then ask for a new code, or enter your password if you have one.';
/** The session the request was sent with has ended (401). */
export const ACCOUNT_DELETE_SESSION_ENDED_COPY = 'Your session has ended. Sign in again.';
/** The account is gone. */
export const ACCOUNT_DELETE_DONE_COPY =
  'Your account has been removed. Thanks for trying StockPilot.';
/**
 * A server error on the delete route. Most of them come before the delete,
 * but the app cannot tell which, so the sentence claims nothing either way.
 */
export const ACCOUNT_DELETE_UNSURE_COPY =
  'Your account may not have been deleted. Try again in a minute.';
/** No answer from the delete route (a timeout, or no connection). */
export const ACCOUNT_DELETE_NO_ANSWER_COPY =
  'No answer came back, so your account may not have been deleted. Check your connection and try again.';
/** No answer from the code route. Only the newest code works, so the person asks again. */
export const ACCOUNT_DELETE_CODE_NO_ANSWER_COPY =
  'No answer came back, so a code may not have been sent. Check your connection, then ask for a new code.';

/** Which route answered: POST /api/v1/account/delete, or POST /api/v1/account/delete/code. */
export type AccountDeleteRoute = 'delete' | 'code';

/**
 * What the phone does next:
 *  - password: show the password field (with the sentence);
 *  - code: show the emailed-code field (with the sentence);
 *  - done: the account is gone; sign out and say so;
 *  - message: show the sentence and stay where the person is;
 *  - sign_in: the session has ended; sign in again.
 */
export type AccountDeleteNext = 'password' | 'code' | 'done' | 'message' | 'sign_in';

export interface AccountDeleteAnswer {
  readonly next: AccountDeleteNext;
  readonly sentence: string;
}

/** One known answer of a route: its status, its `error` code, and what the phone does. */
export interface AccountDeleteKnownAnswer extends AccountDeleteAnswer {
  readonly status: number;
  readonly error: string;
}

/**
 * Every error answer POST /api/v1/account/delete gives, by status and code.
 *
 * Both 'mfa_required' (no password or code sent, under a policy that requires
 * an authenticator) and 'credential_required' (no password or code sent, or
 * the account changed during the request) ask for the password: the person
 * confirms with it or with an emailed code. Their own `message` is never
 * shown. Both 429s (the attempt limit and the try limit) and every 503 come
 * before the delete, so their sentences say nothing was deleted.
 */
export const ACCOUNT_DELETE_ROUTE_ANSWERS: readonly AccountDeleteKnownAnswer[] = [
  {
    status: 400,
    error: 'validation_error',
    next: 'message',
    sentence: ACCOUNT_DELETE_TYPE_DELETE_COPY,
  },
  { status: 403, error: 'aal2_required', next: 'message', sentence: ACCOUNT_DELETE_AAL2_COPY },
  {
    status: 403,
    error: 'mfa_required',
    next: 'password',
    sentence: ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY,
  },
  {
    status: 403,
    error: 'credential_required',
    next: 'password',
    sentence: ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY,
  },
  {
    status: 403,
    error: 'password_incorrect',
    next: 'password',
    sentence: ACCOUNT_DELETE_PASSWORD_REFUSED_COPY,
  },
  {
    status: 403,
    error: 'code_incorrect',
    next: 'code',
    sentence: ACCOUNT_DELETE_CODE_REFUSED_COPY,
  },
  {
    status: 403,
    error: 'last_owner',
    next: 'message',
    sentence: ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE,
  },
  {
    status: 403,
    error: 'platform_admin',
    next: 'message',
    sentence: ACCOUNT_DELETE_PLATFORM_ADMIN_COPY,
  },
  {
    status: 403,
    error: 'account_linked_records',
    next: 'message',
    sentence: ACCOUNT_DELETE_BLOCKED_COPY,
  },
  {
    status: 429,
    error: 'rate_limited',
    next: 'message',
    sentence: ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY,
  },
  { status: 503, error: 'check_failed', next: 'message', sentence: ACCOUNT_DELETE_RETRY_COPY },
  { status: 500, error: 'internal_error', next: 'message', sentence: ACCOUNT_DELETE_UNSURE_COPY },
];

/** Every error answer POST /api/v1/account/delete/code gives, by status and code. */
export const ACCOUNT_DELETE_CODE_ROUTE_ANSWERS: readonly AccountDeleteKnownAnswer[] = [
  {
    status: 409,
    error: 'not_offered',
    next: 'message',
    sentence: ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY,
  },
  {
    status: 429,
    error: 'rate_limited',
    next: 'message',
    sentence: ACCOUNT_DELETE_CODE_SEND_PAUSED_NO_PASSWORD_COPY,
  },
  {
    status: 503,
    error: 'send_failed',
    next: 'message',
    sentence: ACCOUNT_DELETE_CODE_SEND_FAILED_COPY,
  },
  {
    status: 500,
    error: 'internal_error',
    next: 'message',
    sentence: ACCOUNT_DELETE_CODE_SEND_FAILED_COPY,
  },
];

/**
 * What the phone does with an answer from one of the two delete routes, and
 * the sentence it shows. Reads the status and the body's `error` code only,
 * never the server's message, so every sentence is one of the above.
 *
 *  - `status` null, undefined or 0: no HTTP answer (a timeout, no connection).
 *  - 2xx: the delete route deleted the account (done); the code route sent a
 *    code (code).
 *  - 401, whatever the code: sign in again.
 *  - a known status and code: its row above.
 *  - anything else: on the delete route, a 4xx says nothing was changed and a
 *    5xx or other status claims nothing either way; on the code route, the
 *    code could not be sent.
 */
export function accountDeleteAnswer(answer: {
  route?: AccountDeleteRoute;
  status: number | null | undefined;
  error?: unknown;
}): AccountDeleteAnswer {
  const route = answer.route ?? 'delete';
  const status = answer.status;
  if (status === null || status === undefined || status === 0) {
    return {
      next: 'message',
      sentence:
        route === 'code' ? ACCOUNT_DELETE_CODE_NO_ANSWER_COPY : ACCOUNT_DELETE_NO_ANSWER_COPY,
    };
  }
  if (status >= 200 && status < 300) {
    return route === 'code'
      ? { next: 'code', sentence: ACCOUNT_DELETE_CODE_SENT_COPY }
      : { next: 'done', sentence: ACCOUNT_DELETE_DONE_COPY };
  }
  if (status === 401) return { next: 'sign_in', sentence: ACCOUNT_DELETE_SESSION_ENDED_COPY };

  const rows = route === 'code' ? ACCOUNT_DELETE_CODE_ROUTE_ANSWERS : ACCOUNT_DELETE_ROUTE_ANSWERS;
  const known = rows.find((row) => row.status === status && row.error === answer.error);
  if (known) return { next: known.next, sentence: known.sentence };

  if (route === 'code') return { next: 'message', sentence: ACCOUNT_DELETE_CODE_SEND_FAILED_COPY };
  return status >= 400 && status < 500
    ? { next: 'message', sentence: ACCOUNT_DELETE_RETRY_COPY }
    : { next: 'message', sentence: ACCOUNT_DELETE_UNSURE_COPY };
}
