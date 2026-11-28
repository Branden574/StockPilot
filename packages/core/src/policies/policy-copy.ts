/**
 * Policy sign-off: the words the website, the phone, the notices and the
 * reminder emails use, and the two starter texts.
 *
 * Rules (policy-copy.test.ts pins every value): plain words; no emojis and
 * no exclamation marks; never "book" for a recorded quantity; never a claim
 * the app cannot back (an acknowledgement records that a person pressed the
 * button while signed in as themselves, not that they read or understood
 * the text, and nothing here is legal advice); never say an email or a
 * notice was sent unless the caller knows it was.
 *
 * PURE: strings and small functions, no platform imports.
 */

import { DELETED_USER_LABEL } from '../people/deleted-user';

import type {
  PolicyAckMethod,
  PolicyChange,
  PolicyKind,
  PolicyStatus,
  PolicyTextProblem,
} from './policy-text';

/* ───────────────────────────── labels ───────────────────────────── */

export const POLICY_KIND_LABELS: Readonly<Record<PolicyKind, string>> = {
  acceptable_use: 'Acceptable use',
  data_handling: 'Data handling',
  other: 'Other',
};

export const POLICY_STATUS_LABELS: Readonly<Record<PolicyStatus, string>> = {
  draft: 'Draft',
  published: 'Published',
  retired: 'Retired',
};

export const POLICY_ACK_METHOD_LABELS: Readonly<Record<PolicyAckMethod, string>> = {
  web: 'On the website',
  phone: 'In the phone app',
};

export const POLICY_CHANGE_LABELS: Readonly<
  Record<PolicyChange, { label: string; explain: string }>
> = {
  new_version: {
    label: 'Publish as a new version',
    explain: 'Everyone is asked to read and acknowledge it again.',
  },
  correction: {
    label: 'Publish as a correction',
    explain:
      'For a small fix, such as a typo. Nobody is asked again, and acknowledgements of the version it corrects still count.',
  },
};

/* ───────────────────────────── what a member sees ───────────────────────────── */

export const POLICY_MEMBER_COPY = {
  pageTitle: 'Policies',
  pageIntro:
    'Your organization asks you to read these policies and confirm that you agree to them.',
  agreeButton: 'I have read and agree',
  agreeing: 'Saving your acknowledgement…',
  owedBadge: 'Needs your acknowledgement',
  noneOwed: 'You have acknowledged every policy your organization has published.',
  noPolicies: 'Your organization has not published any policies.',
  correctedSince:
    'This policy was corrected after you acknowledged it. The correction does not ask you to acknowledge it again.',
  retiredNote: 'This policy has been retired. It is shown because you acknowledged it.',
  readAgain: 'Read what you agreed to',
  textChanged:
    'This policy changed while you were reading it. Read the new text, then acknowledge it.',
  notCurrent: 'This is not the current version of this policy, so it cannot be acknowledged.',
  notAllowed:
    'This policy is not available to you. It may have been replaced, or you may no longer be a member of this organization.',
  secondStepNeeded: 'Finish signing in with your second step, then acknowledge the policy.',
  failed: 'Your acknowledgement could not be saved. Check your connection and try again.',
} as const;

/** "You acknowledged this on <date>, on the website." The caller formats the date. */
export function policyAcknowledgedLine(when: string, method: PolicyAckMethod): string {
  return `You acknowledged this on ${when}, ${POLICY_ACK_METHOD_LABELS[method].toLowerCase()}.`;
}

/** The banner above the website's pages and the phone's prompt after sign-in. */
export function policyOwedBanner(count: number): { title: string; body: string; action: string } {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    title:
      n === 1 ? 'A policy needs your acknowledgement' : `${n} policies need your acknowledgement`,
    body:
      n === 1
        ? 'Your organization asks you to read it and confirm that you agree. You can keep working in the meantime.'
        : 'Your organization asks you to read them and confirm that you agree. You can keep working in the meantime.',
    action: n === 1 ? 'Read the policy' : 'Read the policies',
  };
}

/* ───────────────────────────── what an admin sees ───────────────────────────── */

export const POLICY_ADMIN_COPY = {
  pageTitle: 'Policies',
  pageIntro:
    'Publish a policy and ask your members to acknowledge it. Each acknowledgement is kept as a record: who, which version, when, and on the website or the phone app.',
  newPolicy: 'New policy',
  startFromStarter: 'Start from an example',
  saveDraft: 'Save draft',
  discardDraft: 'Discard draft',
  deletePolicy: 'Delete this draft policy',
  publish: 'Publish',
  retire: 'Retire this policy',
  retireExplain:
    'Members are no longer asked to acknowledge it. The record of who acknowledged it is kept.',
  remindNow: 'Remind now',
  remindNowExplain:
    'Sends a reminder to everyone who has not acknowledged it. You can do this once a day.',
  remindNowNobody: 'Everyone who is asked has acknowledged it, so there is nobody to remind.',
  automaticReminders:
    'Members who have not acknowledged it are reminded after 3 days and 7 days, then once a week, at most 6 times.',
  acknowledgedHeading: 'Acknowledged',
  notAcknowledgedHeading: 'Not acknowledged yet',
  invitedHeading: 'Invited, not yet joined',
  invitedExplain: 'They will be asked once they accept their invitation.',
  downloadRecord: 'Download the record (CSV)',
  noName: 'No name on the account',
  draftChanged:
    'Someone else saved this draft after you opened it. Reload it to see their changes before you publish.',
  draftUnchanged: 'The draft is the same as the published version, so there is nothing to correct.',
  correctionChangesTitle:
    'A correction keeps the title. To change the title, publish a new version: everyone is asked again.',
  correctionChangesKind:
    'A correction keeps the kind of policy. To change it, publish a new version: everyone is asked again.',
  secondStepNeeded: 'Finish signing in with your second step, then try again.',
  authenticatorNeeded:
    'Your organization asks owners and admins to set up an authenticator first. Set one up in your account settings, then try again.',
  correctionNeedsVersion:
    'A policy that has never been published is published as its first version.',
  noDraft: 'There is no draft to publish. Save a draft first.',
  retired: 'This policy has been retired. Start a new policy instead.',
  notPublished: 'This policy has not been published yet.',
  notAllowed: 'Only owners and admins of this organization can do this.',
  /** A support (act-as) session reads and never changes a policy (0482, as 0481's vendor reviews). */
  actAsReadOnly:
    'A support session can read policies but cannot change them. Ask an owner or admin of this workspace.',
  /** The kept name of an account deleted with no name on it (the database stores it: 0482). */
  formerMemberNoName: 'Former member, no name on the account',
  formerMemberNoNameExplain:
    'The account had no name and has been deleted, so this row shows only when the person joined. It proves less than a row with a name.',
  reload: 'The page is out of date. Reload it and try again.',
  starterStillThere:
    'The draft still holds the note that it is an example. Edit it to fit your organization and remove the note before you publish.',
  whatItRecords:
    'An acknowledgement records that a person pressed “I have read and agree” while signed in as themselves. It does not prove that they read or understood the policy, and StockPilot gives no legal opinion on its words.',
  /** Beside the count when some acknowledgements are of the text before a correction. */
  acknowledgedBeforeCorrectionExplain:
    'A correction does not ask anyone again, so these members acknowledged the text as it was before the correction. Their acknowledgements still count.',
} as const;

/**
 * The count line, with its correction part: "12 of 15 members have
 * acknowledged it." and, when some of those acknowledged the text before a
 * correction (org_policies_for_admin acknowledged_before_correction), "3 of
 * them acknowledged the text before it was corrected." The third number is
 * required, so a page never shows the count without it.
 */
export function policyAcknowledgedCount(
  acknowledged: number,
  members: number,
  acknowledgedBeforeCorrection: number,
): string {
  const a = Number.isInteger(acknowledged) && acknowledged >= 0 ? acknowledged : 0;
  const m = Number.isInteger(members) && members >= 0 ? members : 0;
  const c =
    Number.isInteger(acknowledgedBeforeCorrection) && acknowledgedBeforeCorrection > 0
      ? Math.min(acknowledgedBeforeCorrection, a)
      : 0;
  const line = `${a} of ${m} ${m === 1 ? 'member has' : 'members have'} acknowledged it.`;
  return c === 0 ? line : `${line} ${c} of them acknowledged the text before it was corrected.`;
}

/** "Version 3", "Version 3 (a correction)". */
export function policyVersionLabel(versionNumber: number, needsAcknowledgement: boolean): string {
  return needsAcknowledgement
    ? `Version ${versionNumber}`
    : `Version ${versionNumber} (a correction)`;
}

/**
 * Which version a person acknowledged, and whether the current text is a
 * later correction of it: "Acknowledged version 2." or "Acknowledged version
 * 2. The current text is version 3, a correction of it."
 */
export function policyAcknowledgedVersionLine(
  acknowledgedVersion: number,
  currentVersion: number,
  correctedSince: boolean,
): string {
  const head = `Acknowledged version ${acknowledgedVersion}.`;
  return correctedSince && currentVersion > acknowledgedVersion
    ? `${head} The current text is version ${currentVersion}, a correction of it.`
    : head;
}

/** "Reminded 2 times, last on <date>." The caller formats the date. */
export function policyRemindedLine(times: number, lastWhen: string | null): string {
  if (!Number.isInteger(times) || times <= 0 || lastWhen === null) return 'Not reminded yet.';
  return `Reminded ${times === 1 ? 'once' : `${times} times`}, last on ${lastWhen}.`;
}

/** "You can send another reminder after <time>." The caller formats the time. */
export function policyRemindNowTooSoon(nextWhen: string): string {
  return `A reminder was sent less than a day ago. You can send another after ${nextWhen}.`;
}

/**
 * How a record names a person: the name kept with the acknowledgement, and
 * "Deleted user" (the codebase's one label, people/deleted-user.ts) when the
 * account was deleted, with the kept name after it when there is one.
 */
export function policyPersonLabel(input: {
  name: string | null | undefined;
  accountDeleted: boolean;
}): string {
  const name =
    typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : null;
  if (input.accountDeleted) return name ? `${name} (${DELETED_USER_LABEL})` : DELETED_USER_LABEL;
  return name ?? POLICY_ADMIN_COPY.noName;
}

/* ───────────────────────────── notices and emails ───────────────────────────── */

/**
 * The in-app notice and push for a policy a member is asked to acknowledge
 * (the publish, a reminder, Remind now). Link: /dashboard/policies/<policy id>.
 */
export function policyNotice(
  title: string,
  kind: 'published' | 'reminder',
): { title: string; body: string } {
  return {
    title: kind === 'published' ? `New policy to read: ${title}` : `Reminder: please read ${title}`,
    body:
      kind === 'published'
        ? 'Your organization published a policy. Read it and press “I have read and agree”.'
        : 'Your organization asks you to read this policy and press “I have read and agree”.',
  };
}

/**
 * The one notice a member gets when a policy they acknowledged is corrected
 * (org_policy_correction_notices_claim hands each out once). It asks nothing.
 * Link: /dashboard/policies/<policy id>.
 */
export function policyCorrectionNotice(title: string): { title: string; body: string } {
  return {
    title: `A policy you acknowledged was corrected: ${title}`,
    body: 'You do not need to acknowledge it again. You can read the corrected text and the text you agreed to.',
  };
}

/** The reminder email's subject and text (the email family renders it). */
export function policyReminderEmail(input: { title: string; organizationName: string }): {
  subject: string;
  text: string;
} {
  return {
    subject: `Please read and acknowledge: ${input.title}`,
    text:
      `${input.organizationName} asks you to read the policy “${input.title}” and confirm that you agree. ` +
      'Open StockPilot and go to Policies, or follow the link in this email. You can keep working in the meantime.',
  };
}

/* ───────────────────────────── refusals ───────────────────────────── */

/**
 * The words under a title or body field for each refusal word
 * (PolicyTextProblem: what policyTitleProblem, policyBodyProblem and the
 * prepare functions answer, and the database's detail with the hints
 * policy_title_invalid and policy_body_invalid). Fixed words: none repeats
 * the text or says where in it the problem is.
 */
export const POLICY_TEXT_PROBLEM_COPY: Readonly<Record<PolicyTextProblem, string>> = {
  empty: 'This cannot be empty.',
  too_long:
    'This is too long. A title can be at most 120 characters, and the policy text at most 30,000.',
  too_many_lines: 'The policy text can be at most 600 lines.',
  forbidden_character: 'This holds a hidden or control character. Remove it and try again.',
  too_many_marks:
    'This text holds characters that cannot be shown: more than 30 accents or other marks in a row.',
  not_normal_form: POLICY_ADMIN_COPY.reload,
};

/** The words for a title or body refusal word; an unknown word gets the hint's words. */
export function policyTextProblemWords(
  problem: string | null | undefined,
  field: 'title' | 'body',
): string {
  if (
    typeof problem === 'string' &&
    Object.prototype.hasOwnProperty.call(POLICY_TEXT_PROBLEM_COPY, problem)
  ) {
    return POLICY_TEXT_PROBLEM_COPY[problem as PolicyTextProblem];
  }
  return policyRefusalWords(field === 'title' ? 'policy_title_invalid' : 'policy_body_invalid');
}

/**
 * The words for each refusal the database gives (its hint, migration 0482).
 * A hint not listed here is shown as `failed`.
 */
export const POLICY_REFUSAL_COPY: Readonly<Record<string, string>> = {
  policy_admins_only: POLICY_ADMIN_COPY.notAllowed,
  policy_act_as_read_only: POLICY_ADMIN_COPY.actAsReadOnly,
  policy_not_allowed: POLICY_MEMBER_COPY.notAllowed,
  policy_kind_invalid: 'Choose what kind of policy this is.',
  policy_title_invalid:
    'Give the policy a title of 1 to 120 characters, without hidden characters.',
  policy_body_invalid:
    'The policy text must be 1 to 30,000 characters and at most 600 lines, without hidden or control characters.',
  policy_change_invalid: 'Choose whether this is a new version or a correction.',
  policy_hash_invalid: POLICY_ADMIN_COPY.reload,
  policy_method_invalid: POLICY_MEMBER_COPY.failed,
  policy_no_draft: POLICY_ADMIN_COPY.noDraft,
  policy_draft_changed: POLICY_ADMIN_COPY.draftChanged,
  policy_draft_unchanged: POLICY_ADMIN_COPY.draftUnchanged,
  policy_correction_changes_title: POLICY_ADMIN_COPY.correctionChangesTitle,
  policy_correction_changes_kind: POLICY_ADMIN_COPY.correctionChangesKind,
  policy_correction_needs_a_version: POLICY_ADMIN_COPY.correctionNeedsVersion,
  policy_retired: POLICY_ADMIN_COPY.retired,
  policy_not_published: POLICY_ADMIN_COPY.notPublished,
  policy_version_not_current: POLICY_MEMBER_COPY.notCurrent,
  policy_version_not_found: 'That version of the policy has not been published.',
  policy_text_changed: POLICY_MEMBER_COPY.textChanged,
  aal2_required: POLICY_ADMIN_COPY.secondStepNeeded,
  mfa_required: POLICY_ADMIN_COPY.authenticatorNeeded,
  failed: POLICY_MEMBER_COPY.failed,
};

/** The words for a database refusal's hint. */
export function policyRefusalWords(hint: string | null | undefined): string {
  if (typeof hint === 'string' && Object.prototype.hasOwnProperty.call(POLICY_REFUSAL_COPY, hint)) {
    return POLICY_REFUSAL_COPY[hint]!;
  }
  return POLICY_REFUSAL_COPY.failed!;
}

/* ───────────────────────────── the starter texts ───────────────────────────── */

/**
 * The first paragraph of every starter text: it marks the draft as an
 * example, so an admin who publishes it unchanged still tells members so.
 */
export const POLICY_STARTER_NOTE =
  'A starting point, not legal advice. Edit every part to fit your organization, and remove this paragraph, before you publish.';

export interface PolicyStarter {
  kind: PolicyKind;
  title: string;
  /** In normal form (policy-copy.test.ts checks it). */
  body: string;
}

export const POLICY_STARTERS: readonly PolicyStarter[] = [
  {
    kind: 'acceptable_use',
    title: 'Acceptable use',
    body: [
      POLICY_STARTER_NOTE,
      '',
      '# Purpose',
      'This policy says how we use StockPilot and the devices we use it on. It applies to everyone with an account in our organization.',
      '',
      '# Your account',
      '- Use only your own account. Do not share your password or your sign-in codes.',
      '- Set up a second sign-in step when you are asked to.',
      '- Sign out of shared devices when you finish.',
      '- Tell an admin straight away if you think someone else has used your account.',
      '',
      '# Using StockPilot',
      '- Use StockPilot only for your work for our organization.',
      '- Record stock, orders and counts honestly and when they happen.',
      '- Do not try to reach records or settings your role does not give you.',
      '- Upload only files the work needs and that you are allowed to share.',
      '',
      '# Devices',
      '- Lock the device you use StockPilot on when you step away from it.',
      '- Tell an admin the same day if a device you use for work is lost or stolen.',
      '',
      '# Questions',
      'Ask an admin if you are not sure whether something is allowed.',
    ].join('\n'),
  },
  {
    kind: 'data_handling',
    title: 'Data handling',
    body: [
      POLICY_STARTER_NOTE,
      '',
      '# Purpose',
      'This policy says how we look after the information we keep in StockPilot: suppliers, orders, stock records and the people on our team.',
      '',
      '# What we keep',
      '- Keep only the information the work needs.',
      '- Do not put personal details in notes, item names or uploaded files unless the work needs them.',
      '',
      '# Sharing',
      '- Share records only with people who need them for their work.',
      '- Do not send exports or reports outside our organization without an admin’s approval.',
      '- Delete files you downloaded once you no longer need them.',
      '',
      '# When something goes wrong',
      '- If information reaches the wrong person, or you think someone saw records they should not see, tell an admin the same day.',
      '- Do not try to fix or hide the problem yourself.',
      '',
      '# Leaving',
      'When you leave the organization your access ends. Delete any files you downloaded for work.',
    ].join('\n'),
  },
];

/** Whether a draft still starts with the starter note (the publish screen warns). */
export function policyBodyHasStarterNote(body: string): boolean {
  return body.includes(POLICY_STARTER_NOTE);
}
