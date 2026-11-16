/**
 * The consent text for deleting an account, on the web (the "Delete your
 * account?" dialog and the Settings > Profile card). The phone's text is
 * DELETE_ACCOUNT_CONFIRM_COPY in apps/mobile/src/lib/deleted-user-labels.ts.
 *
 * A3 review 2026-10-05: under the narrow scope (O-A3-1) only some records show
 * "Deleted user" (stock movements, received stock, purchase order imports,
 * the audit log, order timelines, schedule entries, returns). Others keep the
 * name or email they were made with (maintenance requests, older orders,
 * returns from a public link) or show no name. This is the text a person
 * agrees to before an irreversible deletion, so it names where the label
 * shows and says that some records keep a name or email. Never "book" for a
 * recorded quantity.
 */
export const DELETE_ACCOUNT_DIALOG_COPY = {
  kept:
    'This deletes your account and removes your access immediately. Records you made stay with your organization. ' +
    'On stock movements, received stock, purchase order imports and the audit log they show “Deleted user” instead of your name. ' +
    'Some records keep the name or email they were made with, such as maintenance requests and older orders, and some show no name.',
  released: 'Counts, picks and deliveries assigned to you become unassigned so someone else can finish them.',
  owner:
    'If you are the only owner of an organization with other members, transfer ownership first: on the Team page, ' +
    'choose Transfer ownership on another member, or remove the other members.',
} as const;

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
 * the web and the code route. The limit on tries keeps its own sentence.
 */
export const DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY =
  'Too many codes requested. Try again in a few minutes, or enter your password.';

/**
 * The words around confirming a deletion in the dialog, for an account with no
 * authenticator: its password, or a code emailed to it. The server's other
 * answers are in server/lib/account-deletion-credential.ts, which takes
 * codeSent and the send limit's sentence from here so each reads the same
 * everywhere.
 */
export const DELETE_ACCOUNT_CONFIRM_COPY = {
  passwordLabel: 'Your password',
  passwordHint: 'Enter your password to confirm. If you have no password or do not remember it, use a code instead.',
  emailCode: 'Email me a code instead',
  codeLabel: 'Code from your email',
  codeSent: `We sent a six-digit code to your sign-in email. It works for 10 minutes. ${DELETE_ACCOUNT_NEWEST_CODE_ONLY_COPY}`,
  sendAgain: 'Send a new code',
  usePassword: 'Use my password instead',
} as const;
