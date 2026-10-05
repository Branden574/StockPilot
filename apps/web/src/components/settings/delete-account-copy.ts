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
