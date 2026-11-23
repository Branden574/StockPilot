/**
 * The security briefing: one organization's week in plain words
 * (buildSecurityBriefing), the platform console's view across every
 * organization (buildPlatformSecurityBriefing), and the admin and sign-in
 * policy changes read from audit rows (extractBriefingChanges).
 *
 * The item structure (what we see / why it matters / what to do, severity
 * words, a "could not check" state, an "in good shape" line, who can fix it)
 * is modelled on the security-briefing skill in
 * github.com/OCDEkr/Cite-Talk-2026, as read at commit
 * 7dd84d55626874c07af5586304ec34434d396b2e. No text, logo or branding of it
 * is used.
 *
 * Pure rules: no I/O, no clock (the caller passes `now`). Every part of an
 * input is `value | null`. Null means "could not be read": it becomes a
 * "could not check" line, never a zero and never "in good shape".
 *
 * The words follow these rules (security-briefing.test.ts pins them): the
 * number is in the headline; no address, device name, reason code or
 * detection limit; nothing that says how a check works; "second step"
 * wherever a passkey may be meant.
 */

import { SECURITY_EVENT_CATEGORIES, securityEventCategoryLabel } from './security-events';

/* ───────────────────────────── the rules' numbers ───────────────────────────── */

/** A category is "rising" from this many blocked events in the week. */
export const BRIEFING_RISING_MIN_BLOCKED = 20;
/** ... and when the week is at least this many times the week before. */
export const BRIEFING_RISING_FACTOR = 2;
/** Two full weeks of history are needed before one week is compared with the other. */
export const BRIEFING_COMPARE_DAYS = 14;
/** The most organizations the console's table lists. */
export const PLATFORM_BRIEFING_ROWS_SHOWN = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ─────────────────────────────────── shapes ─────────────────────────────────── */

export type BriefingSeverity = 'high' | 'medium' | 'low';
export type BriefingStatus = 'needs_attention' | 'worth_a_look' | 'good' | 'incomplete';
/** Who can fix an item: the organization's own admins, or StockPilot. */
export type BriefingFixedBy = 'you' | 'stockpilot';

export interface BriefingItem {
  id: string;
  severity: BriefingSeverity;
  headline: string;
  whatWeSee: string;
  whyItMatters: string;
  whatToDo: string;
  fixedBy: BriefingFixedBy;
}

export interface BriefingOutcomeCounts {
  blocked: number;
  flagged: number;
  allowed: number;
}

/** One week's events of one organization (or of none), by category. */
export type BriefingWeekCounts = Readonly<Record<string, BriefingOutcomeCounts>>;

export interface BriefingEventsInput {
  thisWeek: BriefingWeekCounts;
  lastWeek: BriefingWeekCounts;
  /** The earliest event the whole record holds; null when it holds none. */
  oldestEventAt: string | null;
}

export interface BriefingMembersInput {
  /** The organization's sign-in policy as stored; null when it is not known. */
  mfaPolicy: string | null;
  members: number;
  /** Owners and admins among the members. */
  admins: number;
  /** Every member with no second step, owners and admins included. */
  withoutSecondStep: number;
  adminsWithoutSecondStep: number;
  membersWithIdleSignIns: number;
  idleSignIns: number;
  /** After how many days without use a sign-in counts as idle (the database's own number). */
  idleAfterDays: number;
  signInsReportedThisWeek: number;
}

/**
 * One organization's admin and sign-in policy changes of the week, as the
 * database counted them from every audit row of the week (never from a list
 * that may be cut short).
 */
export interface BriefingChangeCounts {
  /**
   * DISTINCT members who became an admin or owner this week, by joining or
   * by promotion. One person is one, however they got there: this is the
   * only number of admins added, and it is never added to another.
   */
  adminsAdded: number;
  adminsDemotedOrRemoved: number;
  ownershipMoved: number;
  policyLoosened: number;
  policyTightened: number;
  /** A sign-in policy change whose direction cannot be told. The three never overlap. */
  policyChangedOther: number;
}

export interface SecurityBriefingInput {
  /** The moment the numbers were read, in milliseconds. */
  now: number;
  members: BriefingMembersInput | null;
  events: BriefingEventsInput | null;
  changes: BriefingChangeCounts | null;
}

export interface BriefingCategoryRow {
  category: string;
  label: string;
  blockedThisWeek: number;
  blockedLastWeek: number;
  /** "up from 3", "down from 40", "same", "new this week", or the not-enough-history words. */
  blockedChange: string;
  flaggedThisWeek: number;
  flaggedLastWeek: number;
}

export interface SecurityBriefing {
  status: BriefingStatus;
  /** One sentence (two when a check could not be made) for the top of the briefing. */
  bottomLine: string;
  /** High first; within one severity, in the order of the rules. */
  items: BriefingItem[];
  goodShape: string[];
  unchecked: string[];
  /** A row for each category with an event in either week; null when events could not be read. */
  categories: BriefingCategoryRow[] | null;
  /** Information only, never an item: sign-ins nobody has used for a long time. */
  idleSignIns: string | null;
}

/* ─────────────────────────────────── words ─────────────────────────────────── */

const num = (n: number): string => n.toLocaleString('en-US');

/** "1 member has" / "3 members have": the count with its noun and verb. */
function counted(n: number, one: string, many: string): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

function times(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${num(n)} times`;
}

const SEVERITY_LABELS: Readonly<Record<BriefingSeverity, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export function briefingSeverityLabel(severity: BriefingSeverity): string {
  return SEVERITY_LABELS[severity];
}

const SEVERITY_RANK: Readonly<Record<BriefingSeverity, number>> = { high: 0, medium: 1, low: 2 };

const HISTORY_UNCHECKED =
  "There is not enough history yet to compare this week's blocked activity with last week's.";
const HISTORY_CHANGE = 'not enough history to compare yet';
const MEMBERS_UNCHECKED = 'Second steps and reported sign-ins could not be checked.';
const EVENTS_UNCHECKED = 'Blocked and flagged activity could not be checked.';
const CHANGES_UNCHECKED = 'Admin and sign-in policy changes could not be checked.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Oct", with the year when it is not this year's. In UTC. Null for a value that is no date. */
function dayWords(iso: string, now: number): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === new Date(now).getUTCFullYear()
    ? day
    : `${day} ${d.getUTCFullYear()}`;
}

function capitalized(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/* ─────────────────────────────────── events ─────────────────────────────────── */

const ZERO: BriefingOutcomeCounts = { blocked: 0, flagged: 0, allowed: 0 };

function own(week: BriefingWeekCounts, category: string): BriefingOutcomeCounts {
  return Object.prototype.hasOwnProperty.call(week, category) ? (week[category] ?? ZERO) : ZERO;
}

/** The known categories in their own order, then any other, by name. */
function categoriesOf(events: BriefingEventsInput): string[] {
  const known: readonly string[] = SECURITY_EVENT_CATEGORIES;
  const seen = new Set([...Object.keys(events.thisWeek), ...Object.keys(events.lastWeek)]);
  const others = [...seen].filter((c) => !known.includes(c)).sort();
  return [...known.filter((c) => seen.has(c)), ...others];
}

/**
 * Whether the record goes back far enough to compare the two weeks: its
 * earliest event is at least two full weeks old. An empty record is not.
 */
function hasTwoWeeksOfHistory(events: BriefingEventsInput, now: number): boolean {
  if (events.oldestEventAt === null) return false;
  const oldest = Date.parse(events.oldestEventAt);
  return Number.isFinite(oldest) && oldest <= now - BRIEFING_COMPARE_DAYS * DAY_MS;
}

/** True when any category had more blocked this week than the week before. */
function anyBlockedRise(events: BriefingEventsInput): boolean {
  return categoriesOf(events).some(
    (category) => own(events.thisWeek, category).blocked > own(events.lastWeek, category).blocked,
  );
}

/** The rising rule, on BLOCKED events only. A week before of none counts as rising. */
function isRising(thisWeek: number, lastWeek: number): boolean {
  return thisWeek >= BRIEFING_RISING_MIN_BLOCKED && thisWeek >= BRIEFING_RISING_FACTOR * lastWeek;
}

function changeWords(thisWeek: number, lastWeek: number, compared: boolean): string {
  if (!compared) return HISTORY_CHANGE;
  if (lastWeek === 0 && thisWeek > 0) return 'new this week';
  if (thisWeek > lastWeek) return `up from ${num(lastWeek)}`;
  if (thisWeek < lastWeek) return `down from ${num(lastWeek)}`;
  return 'same';
}

function categoryRows(events: BriefingEventsInput, now: number): BriefingCategoryRow[] {
  const compared = hasTwoWeeksOfHistory(events, now);
  return categoriesOf(events).flatMap((category) => {
    const t = own(events.thisWeek, category);
    const l = own(events.lastWeek, category);
    // A category with nothing blocked or flagged in both weeks is left out:
    // never a row of zeros.
    if (t.blocked + t.flagged + l.blocked + l.flagged === 0) return [];
    return [
      {
        category,
        label: securityEventCategoryLabel(category),
        blockedThisWeek: t.blocked,
        blockedLastWeek: l.blocked,
        blockedChange: changeWords(t.blocked, l.blocked, compared),
        flaggedThisWeek: t.flagged,
        flaggedLastWeek: l.flagged,
      },
    ];
  });
}

interface EventItemWords {
  risingId: string;
  flaggedId: string;
  /** "" for an organization's own events; " with no organization" for the rest. */
  scope: string;
  risingToDo: string;
}

const ORGANIZATION_EVENT_WORDS: EventItemWords = {
  risingId: 'category_rising',
  flaggedId: 'category_flagged',
  scope: '',
  risingToDo:
    'Nothing is needed from this organization. Look again if the number keeps growing next week.',
};

const NO_ORGANIZATION_EVENT_WORDS: EventItemWords = {
  risingId: 'no_organization_rising',
  flaggedId: 'no_organization_flagged',
  scope: ' with no organization',
  risingToDo: 'Nothing is needed now. Look again if the number keeps growing next week.',
};

/**
 * The items of one set of events. Rising counts BLOCKED events only and is
 * StockPilot's (they were refused). A flagged event did happen, so flagged
 * events get their own item, worth a look, and are never StockPilot's.
 */
function eventItems(
  events: BriefingEventsInput,
  now: number,
  words: EventItemWords,
): BriefingItem[] {
  const compared = hasTwoWeeksOfHistory(events, now);
  const rising: BriefingItem[] = [];
  const flagged: BriefingItem[] = [];
  for (const category of categoriesOf(events)) {
    const t = own(events.thisWeek, category);
    const l = own(events.lastWeek, category);
    const label = securityEventCategoryLabel(category);
    if (compared && isRising(t.blocked, l.blocked)) {
      rising.push({
        id: `${words.risingId}:${category}`,
        severity: 'medium',
        headline:
          l.blocked === 0
            ? `${label}${words.scope}: ${num(t.blocked)} blocked this week, none last week`
            : `${label}${words.scope}: ${num(t.blocked)} blocked this week, up from ${num(l.blocked)}`,
        whatWeSee: `${counted(t.blocked, 'attempt was', 'attempts were')} blocked this week. Last week it was ${num(l.blocked)}.`,
        whyItMatters:
          'A jump like this usually means someone is trying harder than before. Every one of these attempts was refused.',
        whatToDo: words.risingToDo,
        fixedBy: 'stockpilot',
      });
    }
    if (t.flagged > 0) {
      flagged.push({
        id: `${words.flaggedId}:${category}`,
        severity: 'low',
        headline: `${label}${words.scope}: ${num(t.flagged)} flagged this week`,
        whatWeSee: `${counted(t.flagged, 'event was', 'events were')} flagged this week${
          compared ? `. Last week it was ${num(l.flagged)}` : ''
        }. Flagged means it was noticed, not stopped.`,
        whyItMatters:
          'A flagged event did happen. Most are harmless, but each one is worth a look.',
        whatToDo: 'Read the flagged entries in the list of security events.',
        fixedBy: 'you',
      });
    }
  }
  return [...rising, ...flagged];
}

/* ─────────────────────────────── one organization ─────────────────────────────── */

function memberItems(m: BriefingMembersInput): BriefingItem[] {
  const items: BriefingItem[] = [];
  if (m.adminsWithoutSecondStep > 0) {
    items.push({
      id: 'admins_without_second_step',
      severity: 'high',
      headline: `${counted(m.adminsWithoutSecondStep, 'admin has', 'admins have')} no second step`,
      whatWeSee: `${num(m.adminsWithoutSecondStep)} of ${counted(m.admins, 'owner or admin signs', 'owners and admins sign')} in with a password alone.`,
      whyItMatters:
        'An owner or admin can change roles, settings and stock. With a password alone, one stolen password is enough to act as them.',
      whatToDo: 'Ask each of them to set up a second step. It is under Settings, Security.',
      fixedBy: 'you',
    });
  }
  if (m.signInsReportedThisWeek > 0) {
    items.push({
      id: 'sign_in_reported',
      severity: 'high',
      headline: `${counted(m.signInsReportedThisWeek, 'sign-in was', 'sign-ins were')} reported by a member as not theirs`,
      whatWeSee:
        m.signInsReportedThisWeek === 1
          ? 'A member said a sign-in to their account this week was not them.'
          : `Members said ${num(m.signInsReportedThisWeek)} sign-ins to their accounts this week were not them.`,
      whyItMatters:
        'Someone else may know that password. This is the clearest sign of an account in the wrong hands.',
      whatToDo: 'Check that the member has changed their password and has a second step.',
      fixedBy: 'you',
    });
  }
  // Members who are not owners or admins. Medium under either policy: until a
  // member sets a second step up, the account rests on its password alone,
  // and whoever signs in next does the set-up.
  const others = Math.max(m.withoutSecondStep - m.adminsWithoutSecondStep, 0);
  if (others > 0) {
    const total = Math.max(m.members - m.admins, others);
    items.push({
      id: 'members_without_second_step',
      severity: 'medium',
      headline: `${counted(others, 'member has', 'members have')} no second step`,
      whatWeSee: `${num(others)} of ${counted(total, 'member who is not an admin signs', 'members who are not admins sign')} in with a password alone.`,
      whyItMatters:
        'A password alone can be guessed, reused or given away to a fake page. A second step stops most of that.',
      whatToDo:
        m.mfaPolicy === 'all_required'
          ? 'The sign-in policy already asks everyone for one, so they will be asked at their next sign-in. Until then their accounts rest on a password alone.'
          : 'Ask them to set up a second step, or change the sign-in policy to ask everyone for one.',
      fixedBy: 'you',
    });
  }
  return items;
}

/**
 * One item for the week's admin changes. Each number stands alone in the
 * headline: admins added (distinct people), admins removed or moved to
 * another role, and ownership moves are never added into one total. Null
 * when all three are zero.
 */
function adminChangesItem(changes: BriefingChangeCounts): BriefingItem | null {
  const added = changes.adminsAdded;
  const left = changes.adminsDemotedOrRemoved;
  const moved = changes.ownershipMoved;
  if (added + left + moved === 0) return null;
  const headline: string[] = [];
  const seen: string[] = [];
  if (added > 0) {
    headline.push(`${counted(added, 'admin', 'admins')} added`);
    seen.push(`${counted(added, 'member became', 'members became')} an admin or the owner.`);
  }
  if (left > 0) {
    headline.push(`${counted(left, 'admin', 'admins')} removed or moved to another role`);
    seen.push(`${counted(left, 'admin was', 'admins were')} removed or moved to another role.`);
  }
  if (moved > 0) {
    headline.push(`ownership moved ${times(moved)}`);
    seen.push(`Ownership moved ${times(moved)}.`);
  }
  return {
    id: 'admin_changes',
    severity: 'low',
    headline: `${capitalized(headline.join(', '))} this week`,
    whatWeSee: seen.join(' '),
    whyItMatters:
      'An admin has full control of the organization. A change nobody expected is worth a question.',
    whatToDo: 'Check that each change was expected.',
    fixedBy: 'you',
  };
}

function policyChangesItem(changes: BriefingChangeCounts): BriefingItem | null {
  const loosened = changes.policyLoosened;
  const tightened = changes.policyTightened;
  const other = changes.policyChangedOther;
  const total = loosened + tightened + other;
  if (total === 0) return null;
  const seen: string[] = [];
  if (loosened > 0) seen.push(`loosened ${times(loosened)}`);
  if (tightened > 0) seen.push(`tightened ${times(tightened)}`);
  if (other > 0) seen.push(`changed in another way ${times(other)}`);
  return {
    id: 'policy_changes',
    severity: loosened > 0 ? 'medium' : 'low',
    headline:
      loosened > 0
        ? `The sign-in policy was loosened ${times(loosened)} this week`
        : other === 0
          ? `The sign-in policy was tightened ${times(tightened)} this week`
          : `The sign-in policy changed ${times(total)} this week`,
    whatWeSee: `The sign-in policy was ${seen.join(', ')}.`,
    whyItMatters:
      loosened > 0
        ? 'A looser policy asks fewer members for a second step.'
        : 'The sign-in policy decides who is asked for a second step.',
    whatToDo: 'Check who changed it, and that it was meant.',
    fixedBy: 'you',
  };
}

function bySeverity(items: BriefingItem[]): BriefingItem[] {
  // Array.prototype.sort is stable: within one severity the rules' order stays.
  return [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function statusOf(items: readonly BriefingItem[], unchecked: readonly string[]): BriefingStatus {
  if (items.some((i) => i.severity === 'high' || i.severity === 'medium')) return 'needs_attention';
  if (items.length > 0) return 'worth_a_look';
  return unchecked.length > 0 ? 'incomplete' : 'good';
}

function bottomLineOf(
  status: BriefingStatus,
  items: readonly BriefingItem[],
  unchecked: readonly string[],
): string {
  if (status === 'good') return 'Everything we checked is in good shape.';
  if (status === 'incomplete') return 'Nothing needs attention, but some checks could not be made.';
  const pressing = items.filter((i) => i.severity !== 'low').length;
  const line =
    status === 'needs_attention'
      ? `${counted(pressing, 'thing needs', 'things need')} attention this week.`
      : `Nothing needs attention. ${counted(items.length, 'thing is', 'things are')} worth a look.`;
  return unchecked.length > 0 ? `${line} Some checks could not be made.` : line;
}

/** One organization's briefing from its three reads. */
export function buildSecurityBriefing(input: SecurityBriefingInput): SecurityBriefing {
  const { members, events, changes, now } = input;
  const items: BriefingItem[] = [];
  const goodShape: string[] = [];
  const unchecked: string[] = [];

  if (members === null) {
    unchecked.push(MEMBERS_UNCHECKED);
  } else {
    items.push(...memberItems(members));
    if (members.admins > 0 && members.adminsWithoutSecondStep === 0) {
      goodShape.push('Every owner and admin has a second step.');
    }
    if (members.signInsReportedThisWeek === 0) {
      goodShape.push('No sign-in was reported this week.');
    }
  }

  if (events === null) {
    unchecked.push(EVENTS_UNCHECKED);
  } else {
    items.push(...eventItems(events, now, ORGANIZATION_EVENT_WORDS));
    if (!hasTwoWeeksOfHistory(events, now)) {
      unchecked.push(HISTORY_UNCHECKED);
    } else if (!anyBlockedRise(events)) {
      // Only when no category went up at all. A rise below the rising rule is
      // neither an item nor "in good shape": the table shows it ("up from 30").
      goodShape.push('Blocked activity is steady or down.');
    }
  }

  if (changes === null) {
    unchecked.push(CHANGES_UNCHECKED);
  } else {
    const adminChanges = adminChangesItem(changes);
    if (adminChanges) items.push(adminChanges);
    const policy = policyChangesItem(changes);
    if (policy) items.push(policy);
    // Only ever from the week's counts, which the database takes from every
    // audit row of the week.
    if (!adminChanges && !policy) {
      goodShape.push('No admin or sign-in policy change this week.');
    }
  }

  const sorted = bySeverity(items);
  const status = statusOf(sorted, unchecked);
  return {
    status,
    bottomLine: bottomLineOf(status, sorted, unchecked),
    items: sorted,
    goodShape,
    unchecked,
    categories: events === null ? null : categoryRows(events, now),
    idleSignIns:
      members !== null && members.idleSignIns > 0
        ? `${counted(members.membersWithIdleSignIns, 'member has', 'members have')} ${counted(members.idleSignIns, 'sign-in', 'sign-ins')} not used in ${num(members.idleAfterDays)} days.`
        : null,
  };
}

/* ─────────────────────────────────── people ─────────────────────────────────── */

export interface BriefingPerson {
  userId: string;
  fullName: string | null;
  email: string | null;
  role: string;
  hasSecondStep: boolean;
  idleSignIns: number;
  /** When the longest-idle of those sign-ins was last used. */
  oldestIdleAt: string | null;
}

/** What the briefing says about one listed member: one short line for each fact. */
export function briefingPersonNotes(
  person: BriefingPerson,
  opts: { now: number; idleAfterDays: number },
): string[] {
  const notes: string[] = [];
  if (!person.hasSecondStep) notes.push('No second step');
  if (person.idleSignIns > 0) {
    const since = person.oldestIdleAt ? dayWords(person.oldestIdleAt, opts.now) : null;
    notes.push(
      `${counted(person.idleSignIns, 'sign-in', 'sign-ins')} not used in ${num(opts.idleAfterDays)} days${
        since ? `, the oldest since ${since}` : ''
      }`,
    );
  }
  return notes;
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  staff: 'Staff',
  viewer: 'Viewer',
};

/** A role in a word, for the people list. A role this build does not know reads "Member". */
export function briefingRoleLabel(role: unknown): string {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_WORDS, role)
    ? (ROLE_WORDS[role] ?? 'Member')
    : 'Member';
}

/* ─────────────────────── admin and sign-in policy changes ─────────────────────── */

/** One audit row, as the briefing reads it. Only these fields: never an address or a device. */
export interface BriefingAuditRow {
  createdAt: string;
  event: string;
  /** Who did it; null when the row names nobody (the database's own rows often do not). */
  actorUserId: string | null;
  /** The account the row is about, when the row names it. */
  targetUserId: string | null;
  entityId: string | null;
  entityType: string | null;
  before: unknown;
  after: unknown;
  /** The role an accepted invitation gave. */
  role: string | null;
  /** True for an invitation pressed by someone who was already a member: nothing changed. */
  alreadyMember: boolean;
  madeAs: string | null;
}

export type BriefingPolicyDirection = 'loosened' | 'tightened' | 'changed';

export type BriefingChange =
  | {
      kind: 'admin_joined' | 'admin_promoted' | 'admin_demoted' | 'admin_removed';
      at: string;
      actorUserId: string | null;
      /** The account the line is about, when the row names it. */
      subjectUserId: string | null;
      fromRole: string | null;
      toRole: string | null;
    }
  | {
      kind: 'ownership_moved';
      at: string;
      actorUserId: string | null;
      fromUserId: string | null;
      toUserId: string | null;
      /**
       * True when the database's own role rows record the move (the rows the
       * database's weekly count reads). False for a move known from the
       * app's row alone, one older than the database's rows.
       */
      inRoleRows: boolean;
    }
  | { kind: 'account_deleted'; at: string }
  | {
      kind: 'policy_changed';
      at: string;
      actorUserId: string | null;
      from: string | null;
      to: string | null;
      direction: BriefingPolicyDirection;
    };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const textIn = (v: unknown, key: string): string | null => {
  if (!isRecord(v)) return null;
  const value = v[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const isAdminRole = (role: string | null): boolean => role === 'owner' || role === 'admin';

const POLICY_ORDER: readonly string[] = ['optional', 'admins_required', 'all_required'];

/**
 * Loosened or tightened by the order optional < admins_required <
 * all_required. A value outside the three, a missing value or the same value
 * twice reads "changed", never loosened or tightened.
 */
export function briefingPolicyDirection(from: unknown, to: unknown): BriefingPolicyDirection {
  const a = typeof from === 'string' ? POLICY_ORDER.indexOf(from) : -1;
  const b = typeof to === 'string' ? POLICY_ORDER.indexOf(to) : -1;
  if (a < 0 || b < 0 || a === b) return 'changed';
  return b < a ? 'loosened' : 'tightened';
}

const POLICY_LABELS: Readonly<Record<string, string>> = {
  optional: 'Optional',
  admins_required: 'Required for admins',
  all_required: 'Required for everyone',
};

/** The sign-in policy in the words the settings page uses; null for a value outside the three. */
export function briefingPolicyLabel(policy: unknown): string | null {
  return typeof policy === 'string' && Object.prototype.hasOwnProperty.call(POLICY_LABELS, policy)
    ? (POLICY_LABELS[policy] ?? null)
    : null;
}

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

const utcDay = (iso: string): string => new Date(timeOf(iso)).toISOString().slice(0, 10);

/**
 * How long after the database's rows the app's own row of the same ownership
 * move may come (it is written once the move has returned).
 */
const OWNERSHIP_APP_ROW_WINDOW_MS = 2 * 60 * 1000;
/**
 * ... and how long before: a later try of the app's writer stamps its row
 * with the web server's clock, which may run a little behind the database's.
 */
const OWNERSHIP_APP_ROW_EARLY_MS = 5 * 1000;

type OwnershipMove = Extract<BriefingChange, { kind: 'ownership_moved' }>;

/**
 * The admin and sign-in policy changes in a set of audit rows, newest first.
 * FOR DISPLAY: the week's numbers are never counted from this list (it is
 * made from a capped number of rows); they are the database's own counts.
 * The rules are the ones those counts use, so a line and a count agree
 * about any one row:
 *
 *   - Promoted: a role change to admin from a role that is not admin or owner.
 *   - Demoted: a role change from admin to a role that is not admin or owner.
 *     Removed: a membership of an admin or owner taken away.
 *   - Joined as admin: an accepted invitation that gave admin or owner. A
 *     press by someone already a member changed nothing and is left out.
 *   - Ownership: a role change to or from owner is an ownership move, never
 *     an admin added or removed, and it is always listed. The database
 *     stamps the rows of one move with one time, so rows with the same time
 *     are one move. The app's own row of a move only adds the two names.
 *   - The invitation wins over its own echo only. An acceptance is seen
 *     twice in the audit rows (the database writes a role row for it, then
 *     the app writes the acceptance). A role change is left out only when
 *     it is that echo: the same member, the same UTC day, ending at the
 *     very role the invitation gave, and recorded no later than the
 *     acceptance. Any other role change that day is a real one and is
 *     listed: a member invited as staff and made an admin the same day has
 *     a "made an admin" line. An ownership move is never left out this way.
 *   - A member who deleted their own account: the row carries no role, so
 *     the line says only that.
 *
 * Two role changes of one member on one day are each listed.
 */
export function extractBriefingChanges(rows: readonly BriefingAuditRow[]): BriefingChange[] {
  // Who accepted an invitation, on which UTC day, and the role it gave:
  // the time of the latest such acceptance.
  const accepted = new Map<string, number>();
  for (const row of rows) {
    if (row.event !== 'user.invite.accepted' || row.alreadyMember) continue;
    if (!row.actorUserId || !row.role) continue;
    const key = `${row.actorUserId}|${utcDay(row.createdAt)}|${row.role}`;
    accepted.set(key, Math.max(accepted.get(key) ?? -Infinity, timeOf(row.createdAt)));
  }
  /**
   * The acceptance seen twice: the same member, the same UTC day, ending at
   * the role the invitation gave, and recorded no later than the acceptance
   * (the acceptance writes the role first and its own row after).
   */
  const foldedByInvite = (row: BriefingAuditRow, endsAt: string | null): boolean => {
    if (row.targetUserId === null || endsAt === null) return false;
    const acceptedAt = accepted.get(`${row.targetUserId}|${utcDay(row.createdAt)}|${endsAt}`);
    return acceptedAt !== undefined && timeOf(row.createdAt) <= acceptedAt;
  };

  const changes: BriefingChange[] = [];
  /** The database's ownership rows, by their exact time. */
  const moves = new Map<string, OwnershipMove>();
  const appMoves: OwnershipMove[] = [];

  for (const row of rows) {
    if (row.event === 'user.invite.accepted') {
      if (row.alreadyMember || !isAdminRole(row.role)) continue;
      changes.push({
        kind: 'admin_joined',
        at: row.createdAt,
        actorUserId: null,
        // The account that accepted is the row's own.
        subjectUserId: row.actorUserId,
        fromRole: null,
        toRole: row.role,
      });
    } else if (row.event === 'user.role.changed') {
      const from = textIn(row.before, 'role');
      const to = textIn(row.after, 'role');
      if (from === 'owner' || to === 'owner') {
        // Never folded by an invitation: an ownership move is always listed.
        const move = moves.get(row.createdAt) ?? {
          kind: 'ownership_moved',
          at: row.createdAt,
          actorUserId: null,
          fromUserId: null,
          toUserId: null,
          inRoleRows: true,
        };
        move.actorUserId ??= row.actorUserId;
        if (from === 'owner') move.fromUserId ??= row.targetUserId;
        if (to === 'owner') move.toUserId ??= row.targetUserId;
        moves.set(row.createdAt, move);
      } else if (foldedByInvite(row, to)) {
        continue;
      } else if (to === 'admin' && from !== 'admin') {
        changes.push(roleChange('admin_promoted', row, from, to));
      } else if (from === 'admin' && to !== 'admin') {
        changes.push(roleChange('admin_demoted', row, from, to));
      }
    } else if (row.event === 'user.deactivated') {
      if (row.entityType === 'user') {
        changes.push({ kind: 'account_deleted', at: row.createdAt });
      } else if (row.entityType === 'organization_member') {
        const from = textIn(row.before, 'role');
        if (!isAdminRole(from)) continue;
        changes.push({
          kind: 'admin_removed',
          at: row.createdAt,
          actorUserId: row.actorUserId,
          subjectUserId: row.targetUserId ?? textIn(row.before, 'user_id'),
          fromRole: from,
          toRole: null,
        });
      }
    } else if (row.event === 'organization.ownership.transferred') {
      appMoves.push({
        kind: 'ownership_moved',
        at: row.createdAt,
        actorUserId: row.actorUserId,
        fromUserId: textIn(row.before, 'owner_user_id'),
        toUserId: textIn(row.after, 'owner_user_id'),
        inRoleRows: false,
      });
    } else if (row.event === 'organization.mfa_policy.changed') {
      const from = textIn(row.before, 'mfa_policy');
      const to = textIn(row.after, 'mfa_policy');
      changes.push({
        kind: 'policy_changed',
        at: row.createdAt,
        actorUserId: row.actorUserId,
        from,
        to,
        direction: briefingPolicyDirection(from, to),
      });
    }
  }

  // The app's row of a move adds its names to the database's move just
  // before it. One with no such move (a move older than the database's own
  // rows) is a line of its own.
  const recorded = [...moves.values()];
  for (const app of appMoves) {
    const at = timeOf(app.at);
    const match = recorded
      .filter(
        (m) =>
          at - timeOf(m.at) <= OWNERSHIP_APP_ROW_WINDOW_MS &&
          timeOf(m.at) - at <= OWNERSHIP_APP_ROW_EARLY_MS,
      )
      // The move nearest in time.
      .sort((a, b) => Math.abs(timeOf(a.at) - at) - Math.abs(timeOf(b.at) - at))[0];
    if (!match) {
      changes.push(app);
      continue;
    }
    match.actorUserId ??= app.actorUserId;
    match.fromUserId ??= app.fromUserId;
    match.toUserId ??= app.toUserId;
  }
  changes.push(...recorded);

  return changes.sort((a, b) => timeOf(b.at) - timeOf(a.at));
}

function roleChange(
  kind: 'admin_promoted' | 'admin_demoted',
  row: BriefingAuditRow,
  from: string | null,
  to: string | null,
): BriefingChange {
  return {
    kind,
    at: row.createdAt,
    actorUserId: row.actorUserId,
    subjectUserId: row.targetUserId,
    fromRole: from,
    toRole: to,
  };
}

/** The names a change's line uses, as the reader resolved them. Null leaves that part out. */
export interface BriefingChangeNames {
  actor?: string | null;
  subject?: string | null;
  from?: string | null;
  to?: string | null;
}

/** The words for a person the reader could not name. */
export const BRIEFING_FORMER_MEMBER = 'a former member';
/** ... and for one whose name could not be read at all. */
export const BRIEFING_UNNAMED_MEMBER = 'a member';
/**
 * Who made a change when it was StockPilot's own staff acting for the
 * organization. Never taken from a profile: a member chooses their own name,
 * so a member is always written with their email (briefingPersonLabel) and
 * can never read as this.
 */
export const BRIEFING_SUPPORT_ACTOR = 'StockPilot support';

/**
 * A member as the briefing writes them: the name they chose with their email
 * beside it, or the email alone. The name is the member's own choice, so it
 * is never shown without the email. Null when there is no email.
 */
export function briefingPersonLabel(
  fullName: string | null | undefined,
  email: string | null | undefined,
): string | null {
  const address = typeof email === 'string' ? email.trim() : '';
  if (address.length === 0) return null;
  const name = typeof fullName === 'string' ? fullName.trim() : '';
  return name.length > 0 ? `${name} (${address})` : address;
}

/** The words that stand in for a name start a sentence with a capital; a name or an email is left as written. */
function sentenceStart(person: string): string {
  return person === BRIEFING_FORMER_MEMBER || person === BRIEFING_UNNAMED_MEMBER
    ? capitalized(person)
    : person;
}

/** One change as one sentence. */
export function describeBriefingChange(
  change: BriefingChange,
  names: BriefingChangeNames = {},
): string {
  const by = names.actor ? ` by ${names.actor}` : '';
  const subject = sentenceStart(names.subject ?? BRIEFING_FORMER_MEMBER);
  switch (change.kind) {
    case 'admin_joined':
      return `${subject} joined as ${change.toRole === 'owner' ? 'the owner' : 'an admin'}.`;
    case 'admin_promoted':
      return `${subject} was made an admin${by}.`;
    case 'admin_demoted':
      return change.toRole
        ? `${subject} was changed from admin to ${briefingRoleLabel(change.toRole).toLowerCase()}${by}.`
        : `${subject} was moved out of the admin role${by}.`;
    case 'admin_removed':
      return `${subject}, ${change.fromRole === 'owner' ? 'the owner' : 'an admin'}, was removed${by}.`;
    case 'ownership_moved':
      return `Ownership moved${names.from ? ` from ${names.from}` : ''}${
        names.to ? ` to ${names.to}` : ''
      }${by}.`;
    case 'account_deleted':
      return 'A member deleted their account.';
    case 'policy_changed': {
      const from = briefingPolicyLabel(change.from);
      const to = briefingPolicyLabel(change.to);
      const what = from && to ? `: ${from} to ${to}` : '';
      return `The sign-in policy was ${change.direction}${what}${by}.`;
    }
  }
}

/* ────────────────────────────── the platform console ────────────────────────────── */

export interface PlatformBriefingMembersRow extends BriefingMembersInput {
  organizationId: string;
  name: string | null;
}

export interface PlatformBriefingMembersInput {
  organizations: readonly PlatformBriefingMembersRow[];
  /** True when more organizations exist than the read returned. */
  truncated: boolean;
  /** Every organization, listed or not. */
  totalOrganizations: number;
  /** Distinct accounts: a person in two organizations is one. */
  accounts: number;
  accountsWithoutSecondStep: number;
  adminAccountsWithoutSecondStep: number;
}

export interface PlatformBriefingEventsRow {
  organizationId: string;
  thisWeek: BriefingWeekCounts;
  lastWeek: BriefingWeekCounts;
}

export interface PlatformBriefingEventsInput {
  organizations: readonly PlatformBriefingEventsRow[];
  truncated: boolean;
  /** The events that belong to no organization. */
  noOrganization: { thisWeek: BriefingWeekCounts; lastWeek: BriefingWeekCounts };
  /** This week, in any organization or none. */
  passkeyUnexplainedSignIns: number;
  passkeyCountersWentBack: number;
  oldestEventAt: string | null;
}

export interface PlatformBriefingChangesRow extends BriefingChangeCounts {
  organizationId: string;
}

export interface PlatformBriefingChangesInput {
  organizations: readonly PlatformBriefingChangesRow[];
  truncated: boolean;
}

export interface PlatformBriefingRepairInput {
  /** Accounts whose passkey set-up is not healthy. */
  accounts: number;
  /** True when the read stopped at its cap: there may be more. */
  capped: boolean;
}

export interface PlatformSecurityBriefingInput {
  now: number;
  members: PlatformBriefingMembersInput | null;
  events: PlatformBriefingEventsInput | null;
  changes: PlatformBriefingChangesInput | null;
  /**
   * Null: could not be read. 'not_configured': this site has no passkeys, so
   * there is nothing to check (not a failure, and not "in good shape").
   */
  passkeyRepair: PlatformBriefingRepairInput | 'not_configured' | null;
}

/** One organization's row in the console's table. A null number: could not check. */
export interface PlatformBriefingRow {
  organizationId: string;
  /** Null when the members read, which names the organizations, failed or did not list it. */
  name: string | null;
  /** The highest severity of the organization's items; null when it has none. */
  attention: BriefingSeverity | null;
  blockedThisWeek: number | null;
  blockedLastWeek: number | null;
  flaggedThisWeek: number | null;
  adminsWithoutSecondStep: number | null;
  membersWithoutSecondStep: number | null;
  signInsReported: number | null;
  /** Distinct members who became an admin or owner this week. Never added to another number. */
  adminsAdded: number | null;
  /** Admins removed or moved to another role. */
  adminsRemoved: number | null;
  ownershipMoves: number | null;
  policyChanges: number | null;
}

export interface PlatformSecurityBriefing {
  status: BriefingStatus;
  bottomLine: string;
  /** The platform's own items. */
  items: BriefingItem[];
  goodShape: string[];
  unchecked: string[];
  /** Accounts across all organizations, in a sentence; null when members could not be read. */
  totalsLine: string | null;
  /** The events of no organization, in a sentence; null when events could not be read or there are none. */
  noOrganizationLine: string | null;
  /** False when none of the three organization reads answered: there is no table to show. */
  organizationsChecked: boolean;
  /**
   * True only when all three organization reads answered and none stopped at
   * its cap. Only then may the page say that no organization has anything to
   * report.
   */
  organizationsAllChecked: boolean;
  /** Which of the three could not be checked, in words. Empty when all three answered. */
  organizationsUnchecked: string[];
  /** Organizations with something to show, the ones needing attention first; at most PLATFORM_BRIEFING_ROWS_SHOWN. */
  organizations: PlatformBriefingRow[];
  /** Organizations with something to show that the table does not list. */
  organizationsNotListed: number;
  organizationsNeedingAttention: number;
  /**
   * Null unless all three reads answered in full: an organization is only
   * known to have nothing to report when every part of it was read.
   */
  organizationsWithNothingToReport: number | null;
  /** True when a read stopped at its cap: organizations beyond it are not counted here. */
  organizationsTruncated: boolean;
}

function sumOutcome(week: BriefingWeekCounts, outcome: keyof BriefingOutcomeCounts): number {
  let total = 0;
  for (const category of Object.keys(week)) total += own(week, category)[outcome];
  return total;
}

function platformItems(input: PlatformSecurityBriefingInput): BriefingItem[] {
  const items: BriefingItem[] = [];
  const { events, passkeyRepair, now } = input;
  if (events !== null) {
    const unexplained = events.passkeyUnexplainedSignIns;
    const copied = events.passkeyCountersWentBack;
    const total = unexplained + copied;
    if (total > 0) {
      const seen: string[] = [];
      if (unexplained > 0) {
        seen.push(
          `${counted(unexplained, 'sign-in', 'sign-ins')} passed the passkey step in a way we cannot explain.`,
        );
      }
      if (copied > 0) {
        seen.push(`A passkey looked like a copy of another ${times(copied)}.`);
      }
      items.push({
        id: 'passkey_unexplained',
        severity: 'high',
        headline: `${counted(total, 'passkey sign-in', 'passkey sign-ins')} did not look right this week`,
        whatWeSee: seen.join(' '),
        whyItMatters:
          'A passkey is meant to prove that the member is the one signing in. These sign-ins did not prove that.',
        whatToDo:
          'Find them in the list of security events and check with each member. If they cannot be explained, turn passkeys off.',
        fixedBy: 'stockpilot',
      });
    }
  }
  if (passkeyRepair !== null && passkeyRepair !== 'not_configured' && passkeyRepair.accounts > 0) {
    const n = passkeyRepair.accounts;
    const count = passkeyRepair.capped
      ? `${num(n)} or more accounts have`
      : counted(n, 'account has', 'accounts have');
    items.push({
      id: 'passkey_setup_needs_repair',
      severity: 'medium',
      headline: `${count} a passkey set-up that needs repair`,
      whatWeSee: `${count} a passkey that is not fully set up or not fully removed.`,
      whyItMatters:
        'Such an account can be asked for a passkey it cannot give, so the member may be locked out until it is repaired.',
      whatToDo:
        'Most are repaired without anyone doing anything, within a day. If the number does not go down, look at each account.',
      fixedBy: 'stockpilot',
    });
  }
  if (events !== null) {
    items.push(
      ...eventItems(
        { ...events.noOrganization, oldestEventAt: events.oldestEventAt },
        now,
        NO_ORGANIZATION_EVENT_WORDS,
      ),
    );
  }
  return items;
}

const hasNumber = (row: PlatformBriefingRow): boolean =>
  [
    row.blockedThisWeek,
    row.blockedLastWeek,
    row.flaggedThisWeek,
    row.adminsWithoutSecondStep,
    row.membersWithoutSecondStep,
    row.signInsReported,
    row.adminsAdded,
    row.adminsRemoved,
    row.ownershipMoves,
    row.policyChanges,
  ].some((n) => n !== null && n > 0);

/**
 * The console's briefing across every organization: counts only, never a
 * person's name or email. Each of the four reads stands alone: one that
 * failed is null here and becomes "could not check" for its own columns.
 */
export function buildPlatformSecurityBriefing(
  input: PlatformSecurityBriefingInput,
): PlatformSecurityBriefing {
  const { members, events, changes, passkeyRepair, now } = input;

  const memberRows = new Map((members?.organizations ?? []).map((o) => [o.organizationId, o]));
  const eventRows = new Map((events?.organizations ?? []).map((o) => [o.organizationId, o]));
  const changeRows = new Map((changes?.organizations ?? []).map((o) => [o.organizationId, o]));
  const ids = new Set([...memberRows.keys(), ...eventRows.keys(), ...changeRows.keys()]);

  const NO_EVENTS: BriefingWeekCounts = {};
  const NO_CHANGES: BriefingChangeCounts = {
    adminsAdded: 0,
    adminsDemotedOrRemoved: 0,
    ownershipMoved: 0,
    policyLoosened: 0,
    policyTightened: 0,
    policyChangedOther: 0,
  };

  const rows: PlatformBriefingRow[] = [];
  for (const id of ids) {
    // An organization a read does not list had nothing to count there, unless
    // that read stopped at its cap: then it is not known.
    const m = memberRows.get(id) ?? null;
    const e: PlatformBriefingEventsRow | null =
      events === null
        ? null
        : (eventRows.get(id) ??
          (events.truncated
            ? null
            : { organizationId: id, thisWeek: NO_EVENTS, lastWeek: NO_EVENTS }));
    const c: BriefingChangeCounts | null =
      changes === null ? null : (changeRows.get(id) ?? (changes.truncated ? null : NO_CHANGES));
    const membersKnown = m !== null || (members !== null && !members.truncated);

    const briefing = buildSecurityBriefing({
      now,
      members: m,
      events:
        e === null || events === null
          ? null
          : { thisWeek: e.thisWeek, lastWeek: e.lastWeek, oldestEventAt: events.oldestEventAt },
      changes: c,
    });

    rows.push({
      organizationId: id,
      name: m?.name ?? null,
      attention: briefing.items[0]?.severity ?? null,
      blockedThisWeek: e ? sumOutcome(e.thisWeek, 'blocked') : null,
      blockedLastWeek: e ? sumOutcome(e.lastWeek, 'blocked') : null,
      flaggedThisWeek: e ? sumOutcome(e.thisWeek, 'flagged') : null,
      adminsWithoutSecondStep: m ? m.adminsWithoutSecondStep : membersKnown ? 0 : null,
      membersWithoutSecondStep: m
        ? Math.max(m.withoutSecondStep - m.adminsWithoutSecondStep, 0)
        : membersKnown
          ? 0
          : null,
      signInsReported: m ? m.signInsReportedThisWeek : membersKnown ? 0 : null,
      // Each its own number, all from the changes read.
      adminsAdded: c ? c.adminsAdded : null,
      adminsRemoved: c ? c.adminsDemotedOrRemoved : null,
      ownershipMoves: c ? c.ownershipMoved : null,
      policyChanges: c ? c.policyLoosened + c.policyTightened + c.policyChangedOther : null,
    });
  }

  const rank = (r: PlatformBriefingRow) => (r.attention ? SEVERITY_RANK[r.attention] : 3);
  const shown = rows
    .filter((r) => r.attention !== null || hasNumber(r))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.name ?? '').localeCompare(b.name ?? '', 'en') ||
        a.organizationId.localeCompare(b.organizationId),
    );
  const needing = rows.filter((r) => r.attention === 'high' || r.attention === 'medium').length;

  const items = bySeverity(platformItems(input));
  const goodShape: string[] = [];
  const unchecked: string[] = [];

  const organizationsUnchecked: string[] = [];
  if (members === null) {
    organizationsUnchecked.push(MEMBERS_UNCHECKED);
  } else if (members.adminAccountsWithoutSecondStep === 0 && members.accounts > 0) {
    goodShape.push('Every owner and admin account has a second step.');
  }
  if (events === null) {
    organizationsUnchecked.push(EVENTS_UNCHECKED);
  } else {
    if (events.passkeyUnexplainedSignIns + events.passkeyCountersWentBack === 0) {
      goodShape.push('No passkey sign-in looked wrong this week.');
    }
    if (
      !hasTwoWeeksOfHistory({ ...events.noOrganization, oldestEventAt: events.oldestEventAt }, now)
    ) {
      unchecked.push(HISTORY_UNCHECKED);
    }
  }
  if (changes === null) organizationsUnchecked.push(CHANGES_UNCHECKED);
  // The three organization parts first, in their order, then the rest.
  unchecked.unshift(...organizationsUnchecked);
  if (passkeyRepair === null) {
    unchecked.push('Passkey set-ups that need repair could not be checked.');
  } else if (passkeyRepair !== 'not_configured' && passkeyRepair.accounts === 0) {
    goodShape.push('No passkey set-up needs repair.');
  }

  const pressing = items.filter((i) => i.severity !== 'low').length;
  const status: BriefingStatus =
    pressing > 0 || needing > 0
      ? 'needs_attention'
      : items.length > 0 || rows.some((r) => r.attention === 'low')
        ? 'worth_a_look'
        : unchecked.length > 0
          ? 'incomplete'
          : 'good';

  const organizationsRead = members !== null || events !== null || changes !== null;
  const organizationsTruncated =
    (members?.truncated ?? false) || (events?.truncated ?? false) || (changes?.truncated ?? false);
  // "No organization ..." is a statement about every part of every
  // organization: it needs all three reads, whole.
  const organizationsAllChecked = organizationsUnchecked.length === 0 && !organizationsTruncated;
  const line: string[] = [];
  if (pressing > 0) {
    line.push(`${counted(pressing, 'platform check needs', 'platform checks need')} attention.`);
  }
  if (!organizationsRead) {
    line.push('The organizations could not be checked.');
  } else {
    line.push(
      needing > 0
        ? `${counted(needing, 'organization needs', 'organizations need')} attention this week.`
        : organizationsAllChecked
          ? 'No organization needs attention this week.'
          : 'Nothing needs attention in what could be checked.',
    );
    if (unchecked.length > 0) line.push('Some checks could not be made.');
  }

  let noOrganizationLine: string | null = null;
  if (events !== null) {
    const blocked = sumOutcome(events.noOrganization.thisWeek, 'blocked');
    const before = sumOutcome(events.noOrganization.lastWeek, 'blocked');
    const flagged = sumOutcome(events.noOrganization.thisWeek, 'flagged');
    if (blocked + before + flagged > 0) {
      noOrganizationLine = `With no organization: ${num(blocked)} blocked this week, ${num(before)} last week, ${num(flagged)} flagged this week.`;
    }
  }

  return {
    status,
    bottomLine: line.join(' '),
    items,
    goodShape,
    unchecked,
    totalsLine:
      members === null
        ? null
        : `${counted(members.accounts, 'account', 'accounts')} in ${counted(members.totalOrganizations, 'organization', 'organizations')}. ${counted(members.accountsWithoutSecondStep, 'has', 'have')} no second step, ${num(members.adminAccountsWithoutSecondStep)} of them an owner or admin.`,
    noOrganizationLine,
    organizationsChecked: organizationsRead,
    organizationsAllChecked,
    organizationsUnchecked,
    organizations: shown.slice(0, PLATFORM_BRIEFING_ROWS_SHOWN),
    organizationsNotListed: Math.max(shown.length - PLATFORM_BRIEFING_ROWS_SHOWN, 0),
    organizationsNeedingAttention: needing,
    organizationsWithNothingToReport:
      members !== null && organizationsAllChecked
        ? Math.max(members.totalOrganizations - shown.length, 0)
        : null,
    organizationsTruncated,
  };
}
