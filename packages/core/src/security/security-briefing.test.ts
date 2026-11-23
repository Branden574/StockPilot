import { describe, expect, it } from 'vitest';

import {
  BRIEFING_FORMER_MEMBER,
  BRIEFING_SUPPORT_ACTOR,
  PLATFORM_BRIEFING_ROWS_SHOWN,
  briefingPersonNotes,
  briefingPolicyDirection,
  briefingPolicyLabel,
  briefingRoleLabel,
  briefingSeverityLabel,
  buildPlatformSecurityBriefing,
  buildSecurityBriefing,
  countBriefingChanges,
  describeBriefingChange,
  extractBriefingChanges,
  type BriefingAuditRow,
  type BriefingChangeCounts,
  type BriefingEventsInput,
  type BriefingMembersInput,
  type BriefingOutcomeCounts,
  type BriefingWeekCounts,
  type PlatformBriefingEventsInput,
  type PlatformBriefingMembersInput,
  type PlatformBriefingMembersRow,
  type PlatformSecurityBriefingInput,
  type SecurityBriefingInput,
} from './security-briefing';

/**
 * The security briefing's rules. Every rule is pinned at its boundary; a
 * part that could not be read is "could not check", never a zero and never
 * "in good shape"; and the words keep the wording rules. Made-up people and
 * organizations only.
 */

const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
/** A record that goes back far enough to compare the two weeks. */
const OLD_ENOUGH = new Date(NOW - 14 * DAY).toISOString();

const counts = (blocked = 0, flagged = 0, allowed = 0): BriefingOutcomeCounts => ({
  blocked,
  flagged,
  allowed,
});

function members(over: Partial<BriefingMembersInput> = {}): BriefingMembersInput {
  return {
    mfaPolicy: 'admins_required',
    members: 40,
    admins: 4,
    withoutSecondStep: 0,
    adminsWithoutSecondStep: 0,
    membersWithIdleSignIns: 0,
    idleSignIns: 0,
    idleAfterDays: 30,
    adminsJoinedThisWeek: 0,
    signInsReportedThisWeek: 0,
    ...over,
  };
}

function events(
  thisWeek: BriefingWeekCounts = {},
  lastWeek: BriefingWeekCounts = {},
  oldestEventAt: string | null = OLD_ENOUGH,
): BriefingEventsInput {
  return { thisWeek, lastWeek, oldestEventAt };
}

function changes(over: Partial<BriefingChangeCounts> = {}): BriefingChangeCounts {
  return {
    adminsPromoted: 0,
    adminsDemotedOrRemoved: 0,
    ownershipMoved: 0,
    policyLoosened: 0,
    policyTightened: 0,
    policyChangedOther: 0,
    ...over,
  };
}

function briefing(over: Partial<SecurityBriefingInput> = {}) {
  return buildSecurityBriefing({
    now: NOW,
    members: members(),
    events: events(),
    changes: changes(),
    ...over,
  });
}

const ids = (b: { items: Array<{ id: string }> }) => b.items.map((i) => i.id);
const item = (b: { items: Array<{ id: string }> }, id: string) => {
  const found = b.items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found as ReturnType<typeof buildSecurityBriefing>['items'][number];
};

describe('one organization: a quiet week', () => {
  it('everything read and nothing found: good, with the four good-shape lines', () => {
    const b = briefing();
    expect(b.status).toBe('good');
    expect(b.items).toEqual([]);
    expect(b.unchecked).toEqual([]);
    expect(b.goodShape).toEqual([
      'Every owner and admin has a second step.',
      'No sign-in was reported this week.',
      'Blocked activity is steady or down.',
      'No admin or sign-in policy change this week.',
    ]);
    expect(b.bottomLine).toBe('Everything we checked is in good shape.');
    expect(b.categories).toEqual([]);
    expect(b.idleSignIns).toBeNull();
  });
});

describe('one organization: each rule at its boundary', () => {
  it('admins without a second step: none is no item, one is high', () => {
    expect(ids(briefing({ members: members({ adminsWithoutSecondStep: 0 }) }))).toEqual([]);
    const b = briefing({ members: members({ withoutSecondStep: 1, adminsWithoutSecondStep: 1 }) });
    expect(ids(b)).toEqual(['admins_without_second_step']);
    const it1 = item(b, 'admins_without_second_step');
    expect(it1.severity).toBe('high');
    expect(it1.fixedBy).toBe('you');
    expect(it1.headline).toBe('1 admin has no second step');
    expect(it1.whatWeSee).toBe('1 of 4 owners and admins sign in with a password alone.');
    expect(b.goodShape).not.toContain('Every owner and admin has a second step.');
    expect(
      item(
        briefing({ members: members({ withoutSecondStep: 3, adminsWithoutSecondStep: 3 }) }),
        'admins_without_second_step',
      ).headline,
    ).toBe('3 admins have no second step');
  });

  it('a reported sign-in: none is no item, one is high, from the reported number only', () => {
    expect(ids(briefing({ members: members({ signInsReportedThisWeek: 0 }) }))).toEqual([]);
    const b = briefing({ members: members({ signInsReportedThisWeek: 1 }) });
    expect(ids(b)).toEqual(['sign_in_reported']);
    expect(item(b, 'sign_in_reported').severity).toBe('high');
    expect(item(b, 'sign_in_reported').headline).toBe(
      '1 sign-in was reported by a member as not theirs',
    );
    expect(b.goodShape).not.toContain('No sign-in was reported this week.');
    expect(
      item(briefing({ members: members({ signInsReportedThisWeek: 3 }) }), 'sign_in_reported')
        .headline,
    ).toBe('3 sign-ins were reported by a member as not theirs');
  });

  it('a reported sign-in never comes from the events: flagged phishing events alone report none', () => {
    const b = briefing({
      members: members({ signInsReportedThisWeek: 0 }),
      events: events({ phishing: counts(0, 7) }),
    });
    expect(ids(b)).not.toContain('sign_in_reported');
    expect(b.goodShape).toContain('No sign-in was reported this week.');
  });

  it('members without a second step: admins are not counted twice; medium under either policy', () => {
    // Two without, both admins: no member item.
    expect(
      ids(briefing({ members: members({ withoutSecondStep: 2, adminsWithoutSecondStep: 2 }) })),
    ).toEqual(['admins_without_second_step']);
    for (const mfaPolicy of ['optional', 'admins_required', 'all_required', 'something_else']) {
      const b = briefing({
        members: members({ mfaPolicy, withoutSecondStep: 3, adminsWithoutSecondStep: 2 }),
      });
      const it1 = item(b, 'members_without_second_step');
      expect(it1.severity).toBe('medium');
      expect(it1.headline).toBe('1 member has no second step');
      expect(it1.whatWeSee).toBe(
        '1 of 36 members who are not admins sign in with a password alone.',
      );
    }
    const asked = item(
      briefing({ members: members({ mfaPolicy: 'all_required', withoutSecondStep: 5 }) }),
      'members_without_second_step',
    );
    expect(asked.headline).toBe('5 members have no second step');
    expect(asked.whatToDo).toContain('they will be asked at their next sign-in');
    const notAsked = item(
      briefing({ members: members({ mfaPolicy: 'admins_required', withoutSecondStep: 5 }) }),
      'members_without_second_step',
    );
    expect(notAsked.whatToDo).not.toContain('next sign-in');
  });

  it('rising: 19 blocked is not, 20 is (the week before had none)', () => {
    expect(ids(briefing({ events: events({ exploit: counts(19) }) }))).toEqual([]);
    const b = briefing({ events: events({ exploit: counts(20) }) });
    expect(ids(b)).toEqual(['category_rising:exploit']);
    const it1 = item(b, 'category_rising:exploit');
    expect(it1.severity).toBe('medium');
    expect(it1.fixedBy).toBe('stockpilot');
    expect(it1.headline).toBe('Exploit attempts: 20 blocked this week, none last week');
    expect(b.goodShape).not.toContain('Blocked activity is steady or down.');
  });

  it('rising: twice the week before is, one short of twice is not', () => {
    expect(ids(briefing({ events: events({ bots: counts(40) }, { bots: counts(20) }) }))).toEqual([
      'category_rising:bots',
    ]);
    expect(ids(briefing({ events: events({ bots: counts(39) }, { bots: counts(20) }) }))).toEqual(
      [],
    );
    expect(ids(briefing({ events: events({ bots: counts(20) }, { bots: counts(11) }) }))).toEqual(
      [],
    );
    const b = briefing({ events: events({ bots: counts(48) }, { bots: counts(12) }) });
    expect(item(b, 'category_rising:bots').headline).toBe(
      'Automated traffic: 48 blocked this week, up from 12',
    );
  });

  it('rising counts blocked events only: flagged and allowed events never make it rise', () => {
    const b = briefing({
      events: events({ phishing: counts(0, 500, 500) }, { phishing: counts(0, 1, 1) }),
    });
    expect(ids(b)).toEqual(['category_flagged:phishing']);
    const flagged = item(b, 'category_flagged:phishing');
    // A flagged event did happen: worth a look, never StockPilot's.
    expect(flagged.severity).toBe('low');
    expect(flagged.fixedBy).toBe('you');
    expect(flagged.headline).toBe('Phishing: 500 flagged this week');
    // The good-shape line is about blocked activity only.
    expect(b.goodShape).toContain('Blocked activity is steady or down.');
    expect(b.status).toBe('worth_a_look');
  });

  it('a category both rising and flagged gives both items', () => {
    const b = briefing({ events: events({ password_guessing: counts(60, 2) }) });
    expect(ids(b)).toEqual([
      'category_rising:password_guessing',
      'category_flagged:password_guessing',
    ]);
  });

  it('history: two full weeks compare; a moment less does not, and nothing rises', () => {
    const justEnough = briefing({
      events: events({ exploit: counts(500) }, {}, new Date(NOW - 14 * DAY).toISOString()),
    });
    expect(ids(justEnough)).toEqual(['category_rising:exploit']);
    expect(justEnough.unchecked).toEqual([]);

    for (const oldest of [new Date(NOW - 14 * DAY + 1).toISOString(), null, 'not a date']) {
      const b = briefing({ events: events({ exploit: counts(500, 1) }, {}, oldest) });
      // Never rising and never steady: an unchecked line.
      expect(ids(b)).toEqual(['category_flagged:exploit']);
      expect(b.goodShape).not.toContain('Blocked activity is steady or down.');
      expect(b.unchecked).toEqual([
        "There is not enough history yet to compare this week's blocked activity with last week's.",
      ]);
      expect(b.categories?.[0]?.blockedChange).toBe('not enough history to compare yet');
      expect(item(b, 'category_flagged:exploit').whatWeSee).toBe(
        '1 event was flagged this week. Flagged means it was noticed, not stopped.',
      );
    }
  });

  it('with no event and not enough history: incomplete, never good', () => {
    const b = briefing({ events: events({}, {}, null) });
    expect(b.items).toEqual([]);
    expect(b.status).toBe('incomplete');
    expect(b.bottomLine).toBe('Nothing needs attention, but some checks could not be made.');
  });

  it('idle sign-ins are information: never an item, never part of the status', () => {
    const b = briefing({ members: members({ membersWithIdleSignIns: 30, idleSignIns: 99 }) });
    expect(b.items).toEqual([]);
    expect(b.status).toBe('good');
    expect(b.idleSignIns).toBe('30 members have 99 sign-ins not used in 30 days.');
    expect(
      briefing({ members: members({ membersWithIdleSignIns: 1, idleSignIns: 1 }) }).idleSignIns,
    ).toBe('1 member has 1 sign-in not used in 30 days.');
  });

  it('admin changes: low, from the members who joined and from the audit counts', () => {
    const joined = briefing({ members: members({ adminsJoinedThisWeek: 1 }) });
    expect(ids(joined)).toEqual(['admin_changes']);
    expect(item(joined, 'admin_changes').severity).toBe('low');
    expect(item(joined, 'admin_changes').headline).toBe('1 admin change this week');
    expect(item(joined, 'admin_changes').whatWeSee).toBe('1 admin joined.');

    const all = briefing({
      members: members({ adminsJoinedThisWeek: 2 }),
      changes: changes({ adminsPromoted: 1, adminsDemotedOrRemoved: 3, ownershipMoved: 1 }),
    });
    expect(item(all, 'admin_changes').headline).toBe('7 admin changes this week');
    expect(item(all, 'admin_changes').whatWeSee).toBe(
      '2 admins joined. 1 member was made an admin. 3 admins were removed or moved to another role. Ownership moved once.',
    );
    expect(all.goodShape).not.toContain('No admin or sign-in policy change this week.');
    expect(all.status).toBe('worth_a_look');
  });

  it('policy changes: loosened is medium, tightened or another change is low', () => {
    const loosened = briefing({ changes: changes({ policyLoosened: 1, policyTightened: 1 }) });
    expect(item(loosened, 'policy_changes').severity).toBe('medium');
    expect(item(loosened, 'policy_changes').headline).toBe(
      'The sign-in policy was loosened once this week',
    );
    expect(item(loosened, 'policy_changes').whatWeSee).toBe(
      'The sign-in policy was loosened once, tightened once.',
    );

    const tightened = briefing({ changes: changes({ policyTightened: 2 }) });
    expect(item(tightened, 'policy_changes').severity).toBe('low');
    expect(item(tightened, 'policy_changes').headline).toBe(
      'The sign-in policy was tightened twice this week',
    );

    const other = briefing({ changes: changes({ policyChangedOther: 3 }) });
    expect(item(other, 'policy_changes').severity).toBe('low');
    expect(item(other, 'policy_changes').headline).toBe(
      'The sign-in policy changed 3 times this week',
    );
    expect(ids(briefing({ changes: changes() }))).toEqual([]);
  });
});

describe('one organization: a part that could not be read', () => {
  it('nothing read: incomplete, three unchecked lines, no good-shape line, no table', () => {
    const b = briefing({ members: null, events: null, changes: null });
    expect(b.status).toBe('incomplete');
    expect(b.items).toEqual([]);
    expect(b.goodShape).toEqual([]);
    expect(b.unchecked).toEqual([
      'Second steps, reported sign-ins and new admins could not be checked.',
      'Blocked and flagged activity could not be checked.',
      'Admin and sign-in policy changes could not be checked.',
    ]);
    expect(b.categories).toBeNull();
    expect(b.idleSignIns).toBeNull();
  });

  it('members not read: no line about second steps or reported sign-ins, the rest stands', () => {
    const b = briefing({ members: null });
    expect(b.unchecked).toEqual([
      'Second steps, reported sign-ins and new admins could not be checked.',
    ]);
    expect(b.goodShape).toEqual(['Blocked activity is steady or down.']);
    expect(b.status).toBe('incomplete');
  });

  it('events not read: no line about blocked activity', () => {
    const b = briefing({ events: null });
    expect(b.unchecked).toEqual(['Blocked and flagged activity could not be checked.']);
    expect(b.goodShape).not.toContain('Blocked activity is steady or down.');
    expect(b.categories).toBeNull();
  });

  it('changes not read: no "no change" line, and the admins who joined are still shown', () => {
    const quiet = briefing({ changes: null });
    expect(quiet.unchecked).toEqual(['Admin and sign-in policy changes could not be checked.']);
    expect(quiet.goodShape).not.toContain('No admin or sign-in policy change this week.');
    const joined = briefing({ members: members({ adminsJoinedThisWeek: 1 }), changes: null });
    expect(ids(joined)).toEqual(['admin_changes']);
  });

  it('members not read: a promotion from the audit counts is still shown, and no "no change" line', () => {
    const b = briefing({ members: null, changes: changes({ adminsPromoted: 1 }) });
    expect(ids(b)).toEqual(['admin_changes']);
    const quiet = briefing({ members: null, changes: changes() });
    expect(quiet.goodShape).not.toContain('No admin or sign-in policy change this week.');
  });

  it('something found and something unread: the bottom line says both', () => {
    const b = briefing({ members: members({ signInsReportedThisWeek: 1 }), events: null });
    expect(b.status).toBe('needs_attention');
    expect(b.bottomLine).toBe('1 thing needs attention this week. Some checks could not be made.');
  });
});

describe('one organization: the sort, the status and the bottom line', () => {
  it('high first, then medium, then low, each in the order of the rules', () => {
    const b = briefing({
      members: members({
        withoutSecondStep: 6,
        adminsWithoutSecondStep: 1,
        signInsReportedThisWeek: 2,
        adminsJoinedThisWeek: 1,
      }),
      events: events({ exploit: counts(30, 4), bots: counts(25) }),
      changes: changes({ policyLoosened: 1 }),
    });
    expect(b.items.map((i) => [i.id, i.severity])).toEqual([
      ['admins_without_second_step', 'high'],
      ['sign_in_reported', 'high'],
      ['members_without_second_step', 'medium'],
      ['category_rising:exploit', 'medium'],
      ['category_rising:bots', 'medium'],
      ['policy_changes', 'medium'],
      ['category_flagged:exploit', 'low'],
      ['admin_changes', 'low'],
    ]);
    expect(b.status).toBe('needs_attention');
    expect(b.bottomLine).toBe('6 things need attention this week.');
  });

  it('only low items: worth a look', () => {
    const b = briefing({ changes: changes({ policyTightened: 1, adminsPromoted: 1 }) });
    expect(b.status).toBe('worth_a_look');
    expect(b.bottomLine).toBe('Nothing needs attention. 2 things are worth a look.');
  });

  it('one medium item: needs attention', () => {
    const b = briefing({ members: members({ withoutSecondStep: 1 }) });
    expect(b.status).toBe('needs_attention');
    expect(b.bottomLine).toBe('1 thing needs attention this week.');
  });

  it('severity words', () => {
    expect(briefingSeverityLabel('high')).toBe('High');
    expect(briefingSeverityLabel('medium')).toBe('Medium');
    expect(briefingSeverityLabel('low')).toBe('Low');
  });
});

describe('one organization: the category table', () => {
  it('a row for every category with an event in either week, in the known order, never a row of zeros', () => {
    const b = briefing({
      events: events(
        {
          malware: counts(0, 0, 9),
          phishing: counts(0, 2),
          password_guessing: counts(25, 1),
          exploit: counts(3),
          zz_new_kind: counts(5),
        },
        {
          password_guessing: counts(40),
          exploit: counts(3),
          bots: counts(4),
        },
      ),
    });
    expect(b.categories).toEqual([
      {
        category: 'password_guessing',
        label: 'Password guessing',
        blockedThisWeek: 25,
        blockedLastWeek: 40,
        blockedChange: 'down from 40',
        flaggedThisWeek: 1,
        flaggedLastWeek: 0,
      },
      {
        category: 'exploit',
        label: 'Exploit attempts',
        blockedThisWeek: 3,
        blockedLastWeek: 3,
        blockedChange: 'same',
        flaggedThisWeek: 0,
        flaggedLastWeek: 0,
      },
      {
        category: 'bots',
        label: 'Automated traffic',
        blockedThisWeek: 0,
        blockedLastWeek: 4,
        blockedChange: 'down from 4',
        flaggedThisWeek: 0,
        flaggedLastWeek: 0,
      },
      {
        category: 'phishing',
        label: 'Phishing',
        blockedThisWeek: 0,
        blockedLastWeek: 0,
        blockedChange: 'same',
        flaggedThisWeek: 2,
        flaggedLastWeek: 0,
      },
      // malware had only allowed events: no row. An unknown category comes last.
      {
        category: 'zz_new_kind',
        label: 'Other',
        blockedThisWeek: 5,
        blockedLastWeek: 0,
        blockedChange: 'new this week',
        flaggedThisWeek: 0,
        flaggedLastWeek: 0,
      },
    ]);
  });

  it('"up from" for a rise', () => {
    const b = briefing({ events: events({ bots: counts(7) }, { bots: counts(3) }) });
    expect(b.categories?.[0]?.blockedChange).toBe('up from 3');
  });

  it('five categories of zeros (the database always sends all five): no row', () => {
    const zeros = {
      password_guessing: counts(),
      exploit: counts(),
      bots: counts(),
      phishing: counts(),
      malware: counts(),
    };
    expect(briefing({ events: events(zeros, zeros) }).categories).toEqual([]);
  });
});

/* ───────────────────────────── the wording rules ───────────────────────────── */

const SHOWN_AS_OTHER_WORDS = new Set([
  'id',
  'category',
  'organizationId',
  'status',
  'severity',
  'fixedBy',
  'attention',
]);

function everyText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => everyText(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      // Ids, category keys and the machine words are not shown to the reader.
      if (SHOWN_AS_OTHER_WORDS.has(key)) continue;
      everyText(v, out);
    }
  }
  return out;
}

const LOUD_ORGANIZATION = () =>
  briefing({
    members: members({
      mfaPolicy: 'all_required',
      withoutSecondStep: 9,
      adminsWithoutSecondStep: 3,
      membersWithIdleSignIns: 5,
      idleSignIns: 8,
      adminsJoinedThisWeek: 2,
      signInsReportedThisWeek: 2,
    }),
    events: events(
      {
        password_guessing: counts(90, 3),
        exploit: counts(55, 1),
        bots: counts(33, 6),
        phishing: counts(60, 2),
        malware: counts(44, 5),
      },
      { password_guessing: counts(9) },
    ),
    changes: changes({
      adminsPromoted: 1,
      adminsDemotedOrRemoved: 2,
      ownershipMoved: 2,
      policyLoosened: 1,
      policyTightened: 1,
      policyChangedOther: 1,
    }),
  });

function platformInput(
  over: Partial<PlatformSecurityBriefingInput> = {},
): PlatformSecurityBriefingInput {
  return {
    now: NOW,
    members: platformMembers([]),
    events: platformEvents(),
    changes: { organizations: [], truncated: false },
    passkeyRepair: { accounts: 0, capped: false },
    ...over,
  };
}

function platformMembers(
  organizations: PlatformBriefingMembersRow[],
  over: Partial<PlatformBriefingMembersInput> = {},
): PlatformBriefingMembersInput {
  return {
    organizations,
    truncated: false,
    totalOrganizations: organizations.length,
    accounts: 100,
    accountsWithoutSecondStep: 0,
    adminAccountsWithoutSecondStep: 0,
    ...over,
  };
}

function platformEvents(
  over: Partial<PlatformBriefingEventsInput> = {},
): PlatformBriefingEventsInput {
  return {
    organizations: [],
    truncated: false,
    noOrganization: { thisWeek: {}, lastWeek: {} },
    passkeyUnexplainedSignIns: 0,
    passkeyCountersWentBack: 0,
    oldestEventAt: OLD_ENOUGH,
    ...over,
  };
}

const ORG_A = '5eed0000-0001-4000-8000-00000000000a';
const ORG_B = '5eed0000-0001-4000-8000-00000000000b';
const ORG_C = '5eed0000-0001-4000-8000-00000000000c';

function orgMembers(
  organizationId: string,
  name: string,
  over: Partial<BriefingMembersInput> = {},
): PlatformBriefingMembersRow {
  return { organizationId, name, ...members(over) };
}

const LOUD_PLATFORM = () =>
  buildPlatformSecurityBriefing(
    platformInput({
      members: platformMembers(
        [
          orgMembers(ORG_A, 'Example Academy', {
            withoutSecondStep: 9,
            adminsWithoutSecondStep: 3,
            signInsReportedThisWeek: 2,
            adminsJoinedThisWeek: 1,
          }),
        ],
        { accounts: 1204, accountsWithoutSecondStep: 310, adminAccountsWithoutSecondStep: 4 },
      ),
      events: platformEvents({
        organizations: [
          { organizationId: ORG_A, thisWeek: { exploit: counts(90, 3) }, lastWeek: {} },
        ],
        noOrganization: {
          thisWeek: { exploit: counts(300, 4), bots: counts(80) },
          lastWeek: { exploit: counts(100) },
        },
        passkeyUnexplainedSignIns: 2,
        passkeyCountersWentBack: 1,
      }),
      changes: {
        organizations: [{ organizationId: ORG_A, ...changes({ policyLoosened: 1 }) }],
        truncated: false,
      },
      passkeyRepair: { accounts: 1000, capped: true },
    }),
  );

describe('the wording rules', () => {
  const texts = () => [
    ...everyText(LOUD_ORGANIZATION()),
    ...everyText(briefing({ members: null, events: null, changes: null })),
    ...everyText(briefing({ events: events({ exploit: counts(60, 2) }, {}, null) })),
    ...everyText(LOUD_PLATFORM()),
    ...everyText(
      buildPlatformSecurityBriefing(
        platformInput({ members: null, events: null, changes: null, passkeyRepair: null }),
      ),
    ),
    // The lines of the changes list and of the people list.
    ...extractBriefingChanges([
      auditRow(),
      auditRow({ before: { role: 'admin' }, after: { role: 'staff' } }),
      auditRow({ event: 'user.deactivated', before: { user_id: MEMBER, role: 'admin' } }),
      auditRow({ event: 'user.deactivated', entityType: 'user', before: null, after: null }),
      auditRow({ event: 'user.invite.accepted', actorUserId: OTHER, role: 'admin' }),
      auditRow({ before: { role: 'admin' }, after: { role: 'owner' } }),
      auditRow({
        event: 'organization.mfa_policy.changed',
        before: { mfa_policy: 'all_required' },
        after: { mfa_policy: 'optional' },
      }),
    ]).flatMap((change) => [
      describeBriefingChange(change),
      describeBriefingChange(change, {
        actor: BRIEFING_SUPPORT_ACTOR,
        subject: 'Alex Example',
        from: 'Dana Example',
        to: 'Alex Example',
      }),
    ]),
    ...briefingPersonNotes(
      {
        userId: MEMBER,
        fullName: 'Alex Example',
        email: 'alex@example.com',
        role: 'admin',
        hasSecondStep: false,
        idleSignIns: 2,
        oldestIdleAt: '2026-10-03T08:15:00+00:00',
      },
      { now: NOW, idleAfterDays: 30 },
    ),
  ];

  it('there is plenty of text to check', () => {
    expect(texts().length).toBeGreaterThan(100);
  });

  it('no address shape, no reason code or other snake_case word, only plain characters', () => {
    for (const text of texts()) {
      // No digits-dot-digits (the shape of an IP address).
      expect(text).not.toMatch(/\d+\.\d+/);
      // No reason code and no column name.
      expect(text).not.toMatch(/[a-z0-9]_[a-z0-9]/i);
      // Plain characters only: no emoji, no symbol.
      expect(text).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it('"second step" wherever a passkey may be meant: the word "authenticator" is never used', () => {
    for (const text of texts()) expect(text).not.toMatch(/authenticator|2fa|mfa|totp/i);
    expect(texts().some((t) => t.includes('second step'))).toBe(true);
  });

  it('never the word "book", and no word for how a check works', () => {
    for (const text of texts()) {
      expect(text).not.toMatch(/\bbook/i);
      expect(text).not.toMatch(/threshold|limit|hourly|counter|detector|device|address/i);
    }
  });

  it('no detection number appears in the words: a rise is told by its own numbers only', () => {
    // 60 against 0 and against 7: the numbers in the words are these alone,
    // never the rule's own (20, twice, 14 days).
    for (const last of [0, 7]) {
      const b = briefing({ events: events({ exploit: counts(60) }, { exploit: counts(last) }) });
      const words = everyText(item(b, 'category_rising:exploit')).join(' ');
      expect(words.match(/\d+/g)?.every((n) => n === '60' || n === String(last))).toBe(true);
      expect(words).not.toMatch(/twice|double|two weeks/i);
    }
  });

  it('the number is in every headline of a counted item', () => {
    for (const it1 of [...LOUD_ORGANIZATION().items, ...LOUD_PLATFORM().items]) {
      if (it1.id === 'policy_changes') {
        expect(it1.headline).toMatch(/once|twice|\d/);
      } else {
        expect(it1.headline).toMatch(/\d/);
      }
    }
  });

  it('every item says what is seen, why it matters and what to do, in short sentences', () => {
    for (const it1 of [...LOUD_ORGANIZATION().items, ...LOUD_PLATFORM().items]) {
      for (const text of [it1.headline, it1.whatWeSee, it1.whyItMatters, it1.whatToDo]) {
        expect(text.trim().length).toBeGreaterThan(10);
        for (const sentence of text.split(/(?<=[.?!])\s+/)) {
          expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(26);
        }
      }
      expect(['you', 'stockpilot']).toContain(it1.fixedBy);
    }
  });
});

/* ─────────────────────────────────── people ─────────────────────────────────── */

describe('the people list', () => {
  const person = {
    userId: 'u1',
    fullName: 'Alex Example',
    email: 'alex@example.com',
    role: 'admin',
    hasSecondStep: true,
    idleSignIns: 0,
    oldestIdleAt: null,
  };
  const opts = { now: NOW, idleAfterDays: 30 };

  it('one line for each fact: no second step, idle sign-ins with the oldest day', () => {
    expect(briefingPersonNotes({ ...person, hasSecondStep: false }, opts)).toEqual([
      'No second step',
    ]);
    expect(
      briefingPersonNotes(
        { ...person, idleSignIns: 2, oldestIdleAt: '2026-10-03T08:15:00+00:00' },
        opts,
      ),
    ).toEqual(['2 sign-ins not used in 30 days, the oldest since 3 Oct']);
    expect(
      briefingPersonNotes(
        {
          ...person,
          hasSecondStep: false,
          idleSignIns: 1,
          oldestIdleAt: '2025-12-31T23:59:59.999999+00:00',
        },
        opts,
      ),
    ).toEqual(['No second step', '1 sign-in not used in 30 days, the oldest since 31 Dec 2025']);
  });

  it('the day only, never the time; a value that is no date is left out', () => {
    const [note] = briefingPersonNotes(
      { ...person, idleSignIns: 1, oldestIdleAt: '2026-10-03T08:15:42+00:00' },
      opts,
    );
    expect(note).not.toMatch(/\d:\d/);
    expect(briefingPersonNotes({ ...person, idleSignIns: 3, oldestIdleAt: 'soon' }, opts)).toEqual([
      '3 sign-ins not used in 30 days',
    ]);
    expect(briefingPersonNotes(person, opts)).toEqual([]);
  });

  it('role words', () => {
    expect(['owner', 'admin', 'manager', 'staff', 'viewer'].map(briefingRoleLabel)).toEqual([
      'Owner',
      'Admin',
      'Manager',
      'Staff',
      'Viewer',
    ]);
    expect(briefingRoleLabel('toString')).toBe('Member');
    expect(briefingRoleLabel(null)).toBe('Member');
  });
});

/* ─────────────────────── admin and sign-in policy changes ─────────────────────── */

const ACTOR = '5eed0000-0002-4000-8000-0000000000a1';
const MEMBER = '5eed0000-0002-4000-8000-0000000000b1';
const OTHER = '5eed0000-0002-4000-8000-0000000000b2';
const MEMBERSHIP = '5eed0000-0003-4000-8000-0000000000e1';

function auditRow(over: Partial<BriefingAuditRow> = {}): BriefingAuditRow {
  return {
    createdAt: '2026-11-22T18:04:11.52+00:00',
    event: 'user.role.changed',
    actorUserId: ACTOR,
    targetUserId: MEMBER,
    entityId: MEMBERSHIP,
    entityType: 'organization_member',
    before: { role: 'staff' },
    after: { role: 'admin' },
    role: null,
    alreadyMember: false,
    madeAs: 'authenticated',
    ...over,
  };
}

const kinds = (rows: BriefingAuditRow[]) => extractBriefingChanges(rows).map((c) => c.kind);

describe('admin changes from audit rows', () => {
  it('promoted: to admin from a role that is not admin or owner', () => {
    expect(extractBriefingChanges([auditRow()])).toEqual([
      {
        kind: 'admin_promoted',
        at: '2026-11-22T18:04:11.52+00:00',
        actorUserId: ACTOR,
        subjectUserId: MEMBER,
        fromRole: 'staff',
        toRole: 'admin',
      },
    ]);
    // admin to admin is no change; staff to manager is no admin change.
    expect(kinds([auditRow({ before: { role: 'admin' } })])).toEqual([]);
    expect(kinds([auditRow({ after: { role: 'manager' } })])).toEqual([]);
  });

  it('demoted: from admin to a role that is not admin or owner', () => {
    const [change] = extractBriefingChanges([
      auditRow({ before: { role: 'admin' }, after: { role: 'manager' } }),
    ]);
    expect(change).toMatchObject({ kind: 'admin_demoted', fromRole: 'admin', toRole: 'manager' });
  });

  it('both shapes of a role change: the database names the account, the older app row may not', () => {
    // The database's own row: no actor, made with the service role.
    const [fromDatabase] = extractBriefingChanges([
      auditRow({ actorUserId: null, madeAs: 'service_role' }),
    ]);
    expect(fromDatabase).toMatchObject({ kind: 'admin_promoted', subjectUserId: MEMBER });
    expect(fromDatabase).toHaveProperty('actorUserId', null);
    // The app's older row whose membership is gone: no account is known.
    const [older] = extractBriefingChanges([auditRow({ targetUserId: null, madeAs: null })]);
    expect(older).toMatchObject({ kind: 'admin_promoted', subjectUserId: null });
  });

  it('removed: a membership of an admin or owner taken away; a staff removal is not listed', () => {
    const removal = auditRow({
      event: 'user.deactivated',
      targetUserId: null,
      before: { user_id: MEMBER, role: 'admin' },
      after: null,
    });
    expect(extractBriefingChanges([removal])).toEqual([
      {
        kind: 'admin_removed',
        at: removal.createdAt,
        actorUserId: ACTOR,
        subjectUserId: MEMBER,
        fromRole: 'admin',
        toRole: null,
      },
    ]);
    expect(kinds([{ ...removal, before: { user_id: MEMBER, role: 'owner' } }])).toEqual([
      'admin_removed',
    ]);
    expect(kinds([{ ...removal, before: { user_id: MEMBER, role: 'staff' } }])).toEqual([]);
    expect(kinds([{ ...removal, before: null }])).toEqual([]);
  });

  it('a member who deleted their own account: its own line, with no role and no name', () => {
    const row = auditRow({
      event: 'user.deactivated',
      actorUserId: null,
      targetUserId: null,
      entityId: MEMBER,
      entityType: 'user',
      before: null,
      after: null,
    });
    expect(extractBriefingChanges([row])).toEqual([{ kind: 'account_deleted', at: row.createdAt }]);
    expect(describeBriefingChange({ kind: 'account_deleted', at: row.createdAt })).toBe(
      'A member deleted their account.',
    );
  });

  it('an accepted invitation: both shapes; only a real acceptance as admin or owner joins', () => {
    const accepted = auditRow({
      event: 'user.invite.accepted',
      actorUserId: MEMBER,
      targetUserId: null,
      entityId: null,
      entityType: null,
      before: null,
      after: null,
      role: 'admin',
    });
    expect(extractBriefingChanges([accepted])).toEqual([
      {
        kind: 'admin_joined',
        at: accepted.createdAt,
        actorUserId: null,
        subjectUserId: MEMBER,
        fromRole: null,
        toRole: 'admin',
      },
    ]);
    expect(kinds([{ ...accepted, role: 'owner' }])).toEqual(['admin_joined']);
    expect(kinds([{ ...accepted, role: 'staff' }])).toEqual([]);
    // "Already a member": the press changed nothing, whatever role it names.
    expect(kinds([{ ...accepted, role: null, alreadyMember: true }])).toEqual([]);
    expect(kinds([{ ...accepted, role: 'admin', alreadyMember: true }])).toEqual([]);
  });

  it('the invitation wins over a role change of the same member on the same UTC day', () => {
    const invite = auditRow({
      createdAt: '2026-11-22T23:59:58+00:00',
      event: 'user.invite.accepted',
      actorUserId: MEMBER,
      targetUserId: null,
      entityId: null,
      entityType: null,
      before: null,
      after: null,
      role: 'admin',
    });
    const databaseRow = auditRow({
      createdAt: '2026-11-22T23:59:57+00:00',
      actorUserId: null,
      madeAs: 'service_role',
    });
    expect(kinds([invite, databaseRow])).toEqual(['admin_joined']);
    // Another member's role change the same day stands.
    expect(kinds([invite, { ...databaseRow, targetUserId: OTHER }])).toEqual([
      'admin_joined',
      'admin_promoted',
    ]);
    // The next UTC day stands.
    expect(kinds([invite, { ...databaseRow, createdAt: '2026-11-23T00:00:00+00:00' }])).toEqual([
      'admin_promoted',
      'admin_joined',
    ]);
    // The day is the UTC day, whatever offset the time is written with.
    expect(kinds([invite, { ...databaseRow, createdAt: '2026-11-22T19:00:00-05:00' }])).toEqual([
      'admin_promoted',
      'admin_joined',
    ]);
    // An "already a member" press folds nothing.
    expect(kinds([{ ...invite, role: null, alreadyMember: true }, databaseRow])).toEqual([
      'admin_promoted',
    ]);
    // An invitation to any role folds: here it turned an admin row into staff.
    expect(
      kinds([
        { ...invite, role: 'staff' },
        { ...databaseRow, before: { role: 'admin' }, after: { role: 'staff' } },
      ]),
    ).toEqual([]);
  });

  it('two role changes of one member on one day are each listed', () => {
    expect(
      kinds([
        auditRow({
          createdAt: '2026-11-22T16:00:00+00:00',
          before: { role: 'admin' },
          after: { role: 'staff' },
        }),
        auditRow({ createdAt: '2026-11-22T09:00:00+00:00' }),
      ]),
    ).toEqual(['admin_demoted', 'admin_promoted']);
  });

  it('an ownership move is shown once, never as an admin added or removed', () => {
    const at = '2026-11-21T10:00:00.123456+00:00';
    const oldOwner = auditRow({
      createdAt: at,
      actorUserId: null,
      targetUserId: ACTOR,
      before: { role: 'owner' },
      after: { role: 'admin' },
      madeAs: 'authenticated',
    });
    const newOwner = auditRow({
      createdAt: at,
      actorUserId: null,
      targetUserId: MEMBER,
      before: { role: 'admin' },
      after: { role: 'owner' },
    });
    const appRow = auditRow({
      createdAt: '2026-11-21T10:00:01.9+00:00',
      event: 'organization.ownership.transferred',
      actorUserId: ACTOR,
      targetUserId: null,
      entityId: 'org',
      entityType: 'organization',
      before: { owner_user_id: ACTOR },
      after: { owner_user_id: MEMBER },
      madeAs: null,
    });
    expect(extractBriefingChanges([appRow, oldOwner, newOwner])).toEqual([
      {
        kind: 'ownership_moved',
        at,
        actorUserId: ACTOR,
        fromUserId: ACTOR,
        toUserId: MEMBER,
        inRoleRows: true,
      },
    ]);
    // Without the app's row the two database rows are still one move.
    expect(extractBriefingChanges([oldOwner, newOwner])).toEqual([
      {
        kind: 'ownership_moved',
        at,
        actorUserId: null,
        fromUserId: ACTOR,
        toUserId: MEMBER,
        inRoleRows: true,
      },
    ]);
    // Rows with different times are different moves.
    expect(
      kinds([oldOwner, { ...newOwner, createdAt: '2026-11-21T10:00:00.123457+00:00' }]),
    ).toEqual(['ownership_moved', 'ownership_moved']);
  });

  it("the app's ownership row alone (a move older than the database's rows): listed, not counted", () => {
    const appRow = auditRow({
      createdAt: '2026-11-10T10:00:00+00:00',
      event: 'organization.ownership.transferred',
      actorUserId: ACTOR,
      targetUserId: null,
      entityType: 'organization',
      before: { owner_user_id: ACTOR },
      after: { owner_user_id: MEMBER },
    });
    const list = extractBriefingChanges([appRow]);
    expect(list).toEqual([
      {
        kind: 'ownership_moved',
        at: appRow.createdAt,
        actorUserId: ACTOR,
        fromUserId: ACTOR,
        toUserId: MEMBER,
        inRoleRows: false,
      },
    ]);
    expect(countBriefingChanges(list, 0).ownershipMoved).toBe(0);
    // An app row long after a database move is not that move's.
    const databaseRow = auditRow({
      createdAt: '2026-11-10T09:00:00+00:00',
      before: { role: 'admin' },
      after: { role: 'owner' },
    });
    expect(kinds([appRow, databaseRow])).toEqual(['ownership_moved', 'ownership_moved']);
  });

  it('the sign-in policy: loosened, tightened, or changed when the direction cannot be told', () => {
    expect(briefingPolicyDirection('all_required', 'admins_required')).toBe('loosened');
    expect(briefingPolicyDirection('all_required', 'optional')).toBe('loosened');
    expect(briefingPolicyDirection('admins_required', 'optional')).toBe('loosened');
    expect(briefingPolicyDirection('optional', 'admins_required')).toBe('tightened');
    expect(briefingPolicyDirection('optional', 'all_required')).toBe('tightened');
    expect(briefingPolicyDirection('admins_required', 'all_required')).toBe('tightened');
    // A value outside the three, a missing value, the same value twice.
    expect(briefingPolicyDirection('optional', 'strict')).toBe('changed');
    expect(briefingPolicyDirection(null, 'optional')).toBe('changed');
    expect(briefingPolicyDirection('optional', undefined)).toBe('changed');
    expect(briefingPolicyDirection('optional', 'optional')).toBe('changed');

    const row = auditRow({
      event: 'organization.mfa_policy.changed',
      targetUserId: null,
      entityType: 'organization',
      before: { mfa_policy: 'all_required' },
      after: { mfa_policy: 'optional' },
    });
    expect(extractBriefingChanges([row])).toEqual([
      {
        kind: 'policy_changed',
        at: row.createdAt,
        actorUserId: ACTOR,
        from: 'all_required',
        to: 'optional',
        direction: 'loosened',
      },
    ]);
    expect(extractBriefingChanges([{ ...row, before: {} }])[0]).toMatchObject({
      from: null,
      direction: 'changed',
    });
    expect(briefingPolicyLabel('optional')).toBe('Optional');
    expect(briefingPolicyLabel('admins_required')).toBe('Required for admins');
    expect(briefingPolicyLabel('all_required')).toBe('Required for everyone');
    expect(briefingPolicyLabel('strict')).toBeNull();
    expect(briefingPolicyLabel('constructor')).toBeNull();
  });

  it('newest first; an event that is not one of the five is ignored', () => {
    const list = extractBriefingChanges([
      auditRow({ createdAt: '2026-11-01T00:00:00+00:00' }),
      auditRow({ event: 'item.created' }),
      auditRow({ createdAt: '2026-11-20T00:00:00+00:00', targetUserId: OTHER }),
    ]);
    expect(list.map((c) => c.at)).toEqual([
      '2026-11-20T00:00:00+00:00',
      '2026-11-01T00:00:00+00:00',
    ]);
  });
});

describe("the week's counts from the list: the same numbers the database counts", () => {
  const SINCE = NOW - 7 * DAY;
  const inWeek = '2026-11-20T08:00:00+00:00';

  /** Each case: the rows of one organization and what platform_security_briefing_changes counts for them. */
  const CASES: Array<{
    name: string;
    rows: BriefingAuditRow[];
    want: Partial<BriefingChangeCounts>;
  }> = [
    { name: 'a promotion', rows: [auditRow({ createdAt: inWeek })], want: { adminsPromoted: 1 } },
    {
      name: 'a demotion and a removal of an owner',
      rows: [
        auditRow({ createdAt: inWeek, before: { role: 'admin' }, after: { role: 'viewer' } }),
        auditRow({
          createdAt: inWeek,
          event: 'user.deactivated',
          targetUserId: null,
          before: { user_id: OTHER, role: 'owner' },
          after: null,
        }),
      ],
      want: { adminsDemotedOrRemoved: 2 },
    },
    {
      name: 'an invitation and the database row of the same member the same day: the invite wins, and is not counted here',
      rows: [
        auditRow({
          createdAt: inWeek,
          event: 'user.invite.accepted',
          actorUserId: MEMBER,
          targetUserId: null,
          role: 'admin',
          before: null,
          after: null,
        }),
        auditRow({ createdAt: inWeek, actorUserId: null, madeAs: 'service_role' }),
      ],
      want: {},
    },
    {
      name: 'a transfer (two rows, one time) and the app row',
      rows: [
        auditRow({
          createdAt: inWeek,
          targetUserId: ACTOR,
          before: { role: 'owner' },
          after: { role: 'admin' },
        }),
        auditRow({ createdAt: inWeek, before: { role: 'admin' }, after: { role: 'owner' } }),
        auditRow({
          createdAt: '2026-11-20T08:00:02+00:00',
          event: 'organization.ownership.transferred',
          targetUserId: null,
          before: { owner_user_id: ACTOR },
          after: { owner_user_id: MEMBER },
        }),
      ],
      want: { ownershipMoved: 1 },
    },
    {
      name: 'a deleted account and an already-a-member press: nothing',
      rows: [
        auditRow({
          createdAt: inWeek,
          event: 'user.deactivated',
          entityType: 'user',
          before: null,
          after: null,
        }),
        auditRow({
          createdAt: inWeek,
          event: 'user.invite.accepted',
          alreadyMember: true,
          before: null,
          after: null,
        }),
      ],
      want: {},
    },
    {
      name: 'the three policy counts never overlap',
      rows: [
        auditRow({
          createdAt: inWeek,
          event: 'organization.mfa_policy.changed',
          before: { mfa_policy: 'all_required' },
          after: { mfa_policy: 'optional' },
        }),
        auditRow({
          createdAt: inWeek,
          event: 'organization.mfa_policy.changed',
          before: { mfa_policy: 'optional' },
          after: { mfa_policy: 'admins_required' },
        }),
        auditRow({
          createdAt: inWeek,
          event: 'organization.mfa_policy.changed',
          before: { mfa_policy: 'optional' },
          after: { mfa_policy: 'optional' },
        }),
      ],
      want: { policyLoosened: 1, policyTightened: 1, policyChangedOther: 1 },
    },
  ];

  it.each(CASES)('$name', ({ rows, want }) => {
    expect(countBriefingChanges(extractBriefingChanges(rows), SINCE)).toEqual(changes(want));
  });

  it('the week starts seven days back, that moment included', () => {
    const at = (ms: number) => [auditRow({ createdAt: new Date(ms).toISOString() })];
    expect(countBriefingChanges(extractBriefingChanges(at(SINCE)), SINCE).adminsPromoted).toBe(1);
    expect(countBriefingChanges(extractBriefingChanges(at(SINCE - 1)), SINCE).adminsPromoted).toBe(
      0,
    );
  });
});

describe('a change in one sentence', () => {
  const at = '2026-11-22T18:04:11+00:00';
  const base = { at, actorUserId: ACTOR, subjectUserId: MEMBER, fromRole: null, toRole: null };

  it('each kind, with the names the reader resolved', () => {
    const names = { actor: 'Dana Example', subject: 'Alex Example' };
    expect(describeBriefingChange({ ...base, kind: 'admin_joined', toRole: 'admin' }, names)).toBe(
      'Alex Example joined as an admin.',
    );
    expect(describeBriefingChange({ ...base, kind: 'admin_joined', toRole: 'owner' }, names)).toBe(
      'Alex Example joined as the owner.',
    );
    expect(describeBriefingChange({ ...base, kind: 'admin_promoted' }, names)).toBe(
      'Alex Example was made an admin by Dana Example.',
    );
    expect(
      describeBriefingChange({ ...base, kind: 'admin_demoted', toRole: 'manager' }, names),
    ).toBe('Alex Example was changed from admin to manager by Dana Example.');
    expect(describeBriefingChange({ ...base, kind: 'admin_demoted' }, names)).toBe(
      'Alex Example was moved out of the admin role by Dana Example.',
    );
    expect(
      describeBriefingChange({ ...base, kind: 'admin_removed', fromRole: 'admin' }, names),
    ).toBe('Alex Example, an admin, was removed by Dana Example.');
    expect(
      describeBriefingChange(
        {
          kind: 'ownership_moved',
          at,
          actorUserId: ACTOR,
          fromUserId: ACTOR,
          toUserId: MEMBER,
          inRoleRows: true,
        },
        { from: 'Dana Example', to: 'Alex Example' },
      ),
    ).toBe('Ownership moved from Dana Example to Alex Example.');
    expect(
      describeBriefingChange(
        {
          kind: 'policy_changed',
          at,
          actorUserId: ACTOR,
          from: 'optional',
          to: 'admins_required',
          direction: 'tightened',
        },
        { actor: BRIEFING_SUPPORT_ACTOR },
      ),
    ).toBe(
      'The sign-in policy was tightened: Optional to Required for admins by StockPilot support.',
    );
  });

  it('a person the reader could not name is "a former member"; no actor, no "by"', () => {
    expect(describeBriefingChange({ ...base, kind: 'admin_promoted' })).toBe(
      'A former member was made an admin.',
    );
    expect(BRIEFING_FORMER_MEMBER).toBe('a former member');
    expect(
      describeBriefingChange({
        kind: 'ownership_moved',
        at,
        actorUserId: null,
        fromUserId: null,
        toUserId: null,
        inRoleRows: true,
      }),
    ).toBe('Ownership moved.');
    expect(
      describeBriefingChange({
        kind: 'policy_changed',
        at,
        actorUserId: null,
        from: 'optional',
        to: 'strict',
        direction: 'changed',
      }),
    ).toBe('The sign-in policy was changed.');
  });
});

/* ────────────────────────────── the platform console ────────────────────────────── */

describe('the platform briefing: its own items', () => {
  it('a quiet platform: good, with its good-shape lines', () => {
    const b = buildPlatformSecurityBriefing(platformInput());
    expect(b.status).toBe('good');
    expect(b.items).toEqual([]);
    expect(b.unchecked).toEqual([]);
    expect(b.goodShape).toEqual([
      'Every owner and admin account has a second step.',
      'No passkey sign-in looked wrong this week.',
      'No passkey set-up needs repair.',
    ]);
    expect(b.bottomLine).toBe('No organization needs attention this week.');
    expect(b.organizations).toEqual([]);
  });

  it('an unexplained passkey sign-in or a counter that went back: high, for one of either', () => {
    for (const over of [{ passkeyUnexplainedSignIns: 1 }, { passkeyCountersWentBack: 1 }]) {
      const b = buildPlatformSecurityBriefing(platformInput({ events: platformEvents(over) }));
      expect(b.items.map((i) => [i.id, i.severity])).toEqual([['passkey_unexplained', 'high']]);
      expect(b.items[0]?.headline).toBe('1 passkey sign-in did not look right this week');
      expect(b.status).toBe('needs_attention');
      expect(b.goodShape).not.toContain('No passkey sign-in looked wrong this week.');
    }
    const both = buildPlatformSecurityBriefing(
      platformInput({
        events: platformEvents({ passkeyUnexplainedSignIns: 2, passkeyCountersWentBack: 1 }),
      }),
    );
    expect(both.items[0]?.headline).toBe('3 passkey sign-ins did not look right this week');
    expect(both.bottomLine).toBe(
      '1 platform check needs attention. No organization needs attention this week.',
    );
  });

  it('passkey set-ups that need repair: none is good shape, one is medium, a full read says "or more"', () => {
    const one = buildPlatformSecurityBriefing(
      platformInput({ passkeyRepair: { accounts: 1, capped: false } }),
    );
    expect(one.items.map((i) => [i.id, i.severity])).toEqual([
      ['passkey_setup_needs_repair', 'medium'],
    ]);
    expect(one.items[0]?.headline).toBe('1 account has a passkey set-up that needs repair');
    expect(one.goodShape).not.toContain('No passkey set-up needs repair.');
    const capped = buildPlatformSecurityBriefing(
      platformInput({ passkeyRepair: { accounts: 1000, capped: true } }),
    );
    expect(capped.items[0]?.headline).toBe(
      '1,000 or more accounts have a passkey set-up that needs repair',
    );
  });

  it('the site has no passkeys here: no item, no good-shape line, not a failed check', () => {
    const b = buildPlatformSecurityBriefing(platformInput({ passkeyRepair: 'not_configured' }));
    expect(b.items).toEqual([]);
    expect(b.goodShape).not.toContain('No passkey set-up needs repair.');
    expect(b.unchecked).toEqual([]);
  });

  it('events with no organization rise by the same rule: 19 is not, 20 is', () => {
    const at = (blocked: number) =>
      buildPlatformSecurityBriefing(
        platformInput({
          events: platformEvents({
            noOrganization: { thisWeek: { exploit: counts(blocked) }, lastWeek: {} },
          }),
        }),
      );
    expect(at(19).items).toEqual([]);
    expect(at(20).items.map((i) => [i.id, i.severity, i.fixedBy])).toEqual([
      ['no_organization_rising:exploit', 'medium', 'stockpilot'],
    ]);
    expect(at(20).items[0]?.headline).toBe(
      'Exploit attempts with no organization: 20 blocked this week, none last week',
    );
    expect(at(20).noOrganizationLine).toBe(
      'With no organization: 20 blocked this week, 0 last week, 0 flagged this week.',
    );
    expect(at(0).noOrganizationLine).toBeNull();
  });

  it('each read that failed is its own unchecked line, and nothing is called good', () => {
    const b = buildPlatformSecurityBriefing(
      platformInput({ members: null, events: null, changes: null, passkeyRepair: null }),
    );
    expect(b.status).toBe('incomplete');
    expect(b.goodShape).toEqual([]);
    expect(b.unchecked).toEqual([
      'Second steps, reported sign-ins and new admins could not be checked.',
      'Blocked and flagged activity could not be checked.',
      'Admin and sign-in policy changes could not be checked.',
      'Passkey set-ups that need repair could not be checked.',
    ]);
    expect(b.bottomLine).toBe('The organizations could not be checked.');
    expect(b.totalsLine).toBeNull();
    expect(b.noOrganizationLine).toBeNull();
    expect(b.organizationsWithNothingToReport).toBeNull();
  });

  it('the totals count accounts, in a sentence', () => {
    const b = buildPlatformSecurityBriefing(
      platformInput({
        members: platformMembers([], {
          totalOrganizations: 37,
          accounts: 1204,
          accountsWithoutSecondStep: 310,
          adminAccountsWithoutSecondStep: 4,
        }),
      }),
    );
    expect(b.totalsLine).toBe(
      '1,204 accounts in 37 organizations. 310 have no second step, 4 of them an owner or admin.',
    );
    expect(b.goodShape).not.toContain('Every owner and admin account has a second step.');
  });
});

describe('the platform briefing: the organizations table', () => {
  const three = () =>
    platformInput({
      members: platformMembers(
        [
          orgMembers(ORG_A, 'Example Academy', {
            withoutSecondStep: 5,
            adminsWithoutSecondStep: 1,
            signInsReportedThisWeek: 1,
            adminsJoinedThisWeek: 1,
          }),
          orgMembers(ORG_B, 'Example Bakery', { withoutSecondStep: 2 }),
          orgMembers(ORG_C, 'Example Clinic'),
        ],
        { totalOrganizations: 40 },
      ),
      events: platformEvents({
        organizations: [
          {
            organizationId: ORG_A,
            thisWeek: { password_guessing: counts(25, 1), bots: counts(3) },
            lastWeek: { password_guessing: counts(4) },
          },
          { organizationId: ORG_C, thisWeek: { bots: counts(2) }, lastWeek: {} },
        ],
      }),
      changes: {
        organizations: [
          {
            organizationId: ORG_A,
            ...changes({
              adminsPromoted: 1,
              ownershipMoved: 1,
              policyLoosened: 1,
              policyChangedOther: 1,
            }),
          },
        ],
        truncated: false,
      },
    });

  it('one row for each organization with something to show, joined by id, the pressing first', () => {
    const b = buildPlatformSecurityBriefing(three());
    expect(b.organizations).toEqual([
      {
        organizationId: ORG_A,
        name: 'Example Academy',
        attention: 'high',
        blockedThisWeek: 28,
        blockedLastWeek: 4,
        flaggedThisWeek: 1,
        adminsWithoutSecondStep: 1,
        membersWithoutSecondStep: 4,
        signInsReported: 1,
        adminChanges: 3,
        policyChanges: 2,
      },
      {
        organizationId: ORG_B,
        name: 'Example Bakery',
        attention: 'medium',
        // In no events or changes read, and neither was cut short: zeros.
        blockedThisWeek: 0,
        blockedLastWeek: 0,
        flaggedThisWeek: 0,
        adminsWithoutSecondStep: 0,
        membersWithoutSecondStep: 2,
        signInsReported: 0,
        adminChanges: 0,
        policyChanges: 0,
      },
      {
        organizationId: ORG_C,
        name: 'Example Clinic',
        attention: null,
        blockedThisWeek: 2,
        blockedLastWeek: 0,
        flaggedThisWeek: 0,
        adminsWithoutSecondStep: 0,
        membersWithoutSecondStep: 0,
        signInsReported: 0,
        adminChanges: 0,
        policyChanges: 0,
      },
    ]);
    expect(b.organizationsNeedingAttention).toBe(2);
    expect(b.organizationsWithNothingToReport).toBe(37);
    expect(b.organizationsNotListed).toBe(0);
    expect(b.status).toBe('needs_attention');
    expect(b.bottomLine).toBe('2 organizations need attention this week.');
  });

  it('counts only: no name of a person and no email anywhere in the answer', () => {
    const text = JSON.stringify(buildPlatformSecurityBriefing(three()));
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/full_?name|email|user_?id/i);
  });

  it('a read that failed: its columns are null in every row, never zero', () => {
    const noEvents = buildPlatformSecurityBriefing({ ...three(), events: null });
    for (const row of noEvents.organizations) {
      expect(row.blockedThisWeek).toBeNull();
      expect(row.blockedLastWeek).toBeNull();
      expect(row.flaggedThisWeek).toBeNull();
      expect(row.adminsWithoutSecondStep).not.toBeNull();
    }
    // Example Clinic had only events: with that read failed it has nothing to show.
    expect(noEvents.organizations.map((r) => r.organizationId)).toEqual([ORG_A, ORG_B]);

    const noMembers = buildPlatformSecurityBriefing({ ...three(), members: null });
    for (const row of noMembers.organizations) {
      expect(row.adminsWithoutSecondStep).toBeNull();
      expect(row.membersWithoutSecondStep).toBeNull();
      expect(row.signInsReported).toBeNull();
      // Admins who joined come from the members read: the sum is not whole.
      expect(row.adminChanges).toBeNull();
      expect(row.name).toBeNull();
      expect(row.blockedThisWeek).not.toBeNull();
    }
    expect(noMembers.organizationsWithNothingToReport).toBeNull();

    const noChanges = buildPlatformSecurityBriefing({ ...three(), changes: null });
    for (const row of noChanges.organizations) {
      expect(row.adminChanges).toBeNull();
      expect(row.policyChanges).toBeNull();
    }
  });

  it('names for organizations the members read did not name', () => {
    const b = buildPlatformSecurityBriefing({
      ...three(),
      members: null,
      organizationNames: new Map([[ORG_A, 'Example Academy']]),
    });
    expect(b.organizations.map((r) => r.name)).toEqual(['Example Academy', null]);
  });

  it('a read cut short at its cap: an organization missing from it is not known, not zero', () => {
    const input = three();
    const b = buildPlatformSecurityBriefing({
      ...input,
      events: { ...input.events!, truncated: true },
      changes: { ...input.changes!, truncated: true },
    });
    const bakery = b.organizations.find((r) => r.organizationId === ORG_B);
    expect(bakery).toMatchObject({
      blockedThisWeek: null,
      flaggedThisWeek: null,
      adminChanges: null,
      policyChanges: null,
      membersWithoutSecondStep: 2,
    });
    expect(b.organizationsTruncated).toBe(true);

    const cut = buildPlatformSecurityBriefing({
      ...input,
      members: { ...input.members!, organizations: [], truncated: true },
    });
    expect(cut.organizations.find((r) => r.organizationId === ORG_A)).toMatchObject({
      adminsWithoutSecondStep: null,
      signInsReported: null,
      adminChanges: null,
    });
  });

  it('an organization with only low items is worth a look, and is listed after the pressing ones', () => {
    const b = buildPlatformSecurityBriefing(
      platformInput({
        members: platformMembers([
          orgMembers(ORG_B, 'Example Bakery', { adminsJoinedThisWeek: 1 }),
          orgMembers(ORG_A, 'Example Academy', { withoutSecondStep: 1 }),
        ]),
      }),
    );
    expect(b.organizations.map((r) => [r.name, r.attention])).toEqual([
      ['Example Academy', 'medium'],
      ['Example Bakery', 'low'],
    ]);
    const onlyLow = buildPlatformSecurityBriefing(
      platformInput({
        members: platformMembers([
          orgMembers(ORG_B, 'Example Bakery', { adminsJoinedThisWeek: 1 }),
        ]),
      }),
    );
    expect(onlyLow.status).toBe('worth_a_look');
    expect(onlyLow.organizationsNeedingAttention).toBe(0);
  });

  it('an organization with idle sign-ins and nothing else has nothing to report', () => {
    const b = buildPlatformSecurityBriefing(
      platformInput({
        members: platformMembers([
          orgMembers(ORG_A, 'Example Academy', { membersWithIdleSignIns: 9, idleSignIns: 30 }),
        ]),
      }),
    );
    expect(b.organizations).toEqual([]);
    expect(b.organizationsWithNothingToReport).toBe(1);
    expect(b.status).toBe('good');
  });

  it(`at most ${PLATFORM_BRIEFING_ROWS_SHOWN} rows, and the rest are counted`, () => {
    const many = Array.from({ length: 62 }, (_, i) =>
      orgMembers(
        `5eed0000-0009-4000-8000-${String(i).padStart(12, '0')}`,
        `Example Organization ${String(i).padStart(2, '0')}`,
        { withoutSecondStep: 1 },
      ),
    );
    const b = buildPlatformSecurityBriefing(
      platformInput({ members: platformMembers(many, { totalOrganizations: 100 }) }),
    );
    expect(b.organizations).toHaveLength(50);
    expect(b.organizations[0]?.name).toBe('Example Organization 00');
    expect(b.organizationsNotListed).toBe(12);
    expect(b.organizationsNeedingAttention).toBe(62);
    expect(b.organizationsWithNothingToReport).toBe(38);
  });

  it('with too little history an organization never rises', () => {
    const b = buildPlatformSecurityBriefing(
      platformInput({
        events: platformEvents({
          organizations: [
            { organizationId: ORG_A, thisWeek: { exploit: counts(900) }, lastWeek: {} },
          ],
          noOrganization: { thisWeek: { exploit: counts(900) }, lastWeek: {} },
          oldestEventAt: new Date(NOW - 2 * DAY).toISOString(),
        }),
      }),
    );
    expect(b.items).toEqual([]);
    expect(b.organizations[0]?.attention).toBeNull();
    expect(b.unchecked).toEqual([
      "There is not enough history yet to compare this week's blocked activity with last week's.",
    ]);
  });
});
