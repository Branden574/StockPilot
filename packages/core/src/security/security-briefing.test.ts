import { describe, expect, it } from 'vitest';

import {
  BRIEFING_FORMER_MEMBER,
  BRIEFING_SUPPORT_ACTOR,
  BRIEFING_UNNAMED_MEMBER,
  PLATFORM_BRIEFING_ROWS_SHOWN,
  briefingPersonLabel,
  briefingPersonNotes,
  briefingPolicyDirection,
  briefingPolicyLabel,
  briefingRoleLabel,
  briefingSeverityLabel,
  buildPlatformSecurityBriefing,
  buildSecurityBriefing,
  describeBriefingChange,
  extractBriefingChanges,
  type BriefingAuditRow,
  type BriefingChange,
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
    adminsAdded: 0,
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

  it('"steady or down" is said only when no category went up at all', () => {
    const LINE = 'Blocked activity is steady or down.';
    // The same and down: said.
    expect(
      briefing({ events: events({ bots: counts(30) }, { bots: counts(30) }) }).goodShape,
    ).toContain(LINE);
    expect(
      briefing({ events: events({ bots: counts(29) }, { bots: counts(30) }) }).goodShape,
    ).toContain(LINE);
    // One more than last week, far below the rising rule: not said, no item,
    // and the status is still good. The table says "up from 30".
    const up = briefing({ events: events({ bots: counts(31) }, { bots: counts(30) }) });
    expect(up.goodShape).not.toContain(LINE);
    expect(up.items).toEqual([]);
    expect(up.unchecked).toEqual([]);
    expect(up.status).toBe('good');
    expect(up.categories?.[0]?.blockedChange).toBe('up from 30');
    // The reviewer's two cases.
    expect(
      briefing({ events: events({ exploit: counts(55) }, { exploit: counts(30) }) }).goodShape,
    ).not.toContain(LINE);
    expect(briefing({ events: events({ exploit: counts(19) }) }).goodShape).not.toContain(LINE);
    // One category up is enough, whatever the others did.
    expect(
      briefing({
        events: events(
          { bots: counts(1), exploit: counts(2) },
          { bots: counts(50), exploit: counts(1) },
        ),
      }).goodShape,
    ).not.toContain(LINE);
    // Flagged and allowed events going up do not count: the line is about blocked.
    expect(
      briefing({ events: events({ bots: counts(3, 9, 9) }, { bots: counts(3, 1, 1) }) }).goodShape,
    ).toContain(LINE);
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

  it('admin changes: low; admins added is one number of distinct people, each number on its own', () => {
    const added = briefing({ changes: changes({ adminsAdded: 2 }) });
    expect(ids(added)).toEqual(['admin_changes']);
    expect(item(added, 'admin_changes').severity).toBe('low');
    expect(item(added, 'admin_changes').headline).toBe('2 admins added this week');
    expect(item(added, 'admin_changes').whatWeSee).toBe('2 members became an admin or the owner.');
    expect(item(briefing({ changes: changes({ adminsAdded: 1 }) }), 'admin_changes').headline).toBe(
      '1 admin added this week',
    );

    const all = briefing({
      changes: changes({ adminsAdded: 2, adminsDemotedOrRemoved: 3, ownershipMoved: 1 }),
    });
    // Never one total: no "6" anywhere.
    expect(item(all, 'admin_changes').headline).toBe(
      '2 admins added, 3 admins removed or moved to another role, ownership moved once this week',
    );
    expect(item(all, 'admin_changes').whatWeSee).toBe(
      '2 members became an admin or the owner. 3 admins were removed or moved to another role. Ownership moved once. One person can be in both numbers.',
    );
    expect(JSON.stringify(item(all, 'admin_changes'))).not.toMatch(/\b6\b/);
    expect(all.goodShape).not.toContain('No admin or sign-in policy change this week.');
    expect(all.status).toBe('worth_a_look');

    // A member made an admin and moved back in the same week: one admin
    // added AND one moved to another role. Both are true of the week, and
    // the words say the two can be the same person.
    const both = item(
      briefing({ changes: changes({ adminsAdded: 1, adminsDemotedOrRemoved: 1 }) }),
      'admin_changes',
    );
    expect(both.headline).toBe('1 admin added, 1 admin removed or moved to another role this week');
    expect(both.whatWeSee).toBe(
      '1 member became an admin or the owner. 1 admin was removed or moved to another role. One person can be in both numbers.',
    );
    // With only one of the two there is nothing to overlap.
    expect(item(added, 'admin_changes').whatWeSee).not.toContain('both numbers');
    expect(
      item(
        briefing({ changes: changes({ adminsDemotedOrRemoved: 1, ownershipMoved: 1 }) }),
        'admin_changes',
      ).whatWeSee,
    ).toBe('1 admin was removed or moved to another role. Ownership moved once.');

    expect(
      item(briefing({ changes: changes({ ownershipMoved: 2 }) }), 'admin_changes').headline,
    ).toBe('Ownership moved twice this week');
    expect(
      item(briefing({ changes: changes({ adminsDemotedOrRemoved: 1 }) }), 'admin_changes').headline,
    ).toBe('1 admin removed or moved to another role this week');
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
      'Second steps and reported sign-ins could not be checked.',
      'Blocked and flagged activity could not be checked.',
      'Admin and sign-in policy changes could not be checked.',
    ]);
    expect(b.categories).toBeNull();
    expect(b.idleSignIns).toBeNull();
  });

  it('members not read: no line about second steps or reported sign-ins, the rest stands', () => {
    const b = briefing({ members: null });
    expect(b.unchecked).toEqual(['Second steps and reported sign-ins could not be checked.']);
    // The week's changes are the database's own count: they need no member read.
    expect(b.goodShape).toEqual([
      'Blocked activity is steady or down.',
      'No admin or sign-in policy change this week.',
    ]);
    expect(b.status).toBe('incomplete');
  });

  it('events not read: no line about blocked activity', () => {
    const b = briefing({ events: null });
    expect(b.unchecked).toEqual(['Blocked and flagged activity could not be checked.']);
    expect(b.goodShape).not.toContain('Blocked activity is steady or down.');
    expect(b.categories).toBeNull();
  });

  it('changes not read: no "no change" line and no admin item, whatever the members read holds', () => {
    const quiet = briefing({ changes: null });
    expect(quiet.unchecked).toEqual(['Admin and sign-in policy changes could not be checked.']);
    expect(quiet.goodShape).not.toContain('No admin or sign-in policy change this week.');
    expect(ids(quiet)).toEqual([]);
    expect(quiet.status).toBe('incomplete');
  });

  it('members not read: the admins added are still shown, from the counts alone', () => {
    const b = briefing({ members: null, changes: changes({ adminsAdded: 1 }) });
    expect(ids(b)).toEqual(['admin_changes']);
    expect(b.goodShape).not.toContain('No admin or sign-in policy change this week.');
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
      }),
      events: events({ exploit: counts(30, 4), bots: counts(25) }),
      changes: changes({ policyLoosened: 1, adminsAdded: 1 }),
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
    const b = briefing({ changes: changes({ policyTightened: 1, adminsAdded: 1 }) });
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
      adminsAdded: 3,
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
        organizations: [
          { organizationId: ORG_A, ...changes({ policyLoosened: 1, adminsAdded: 1 }) },
        ],
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

  describe('an invitation and a role change of the same member on the same UTC day', () => {
    // The acceptance is seen twice: the database writes the role row first,
    // then the app writes the acceptance.
    const invite = auditRow({
      createdAt: '2026-11-22T10:00:01+00:00',
      event: 'user.invite.accepted',
      actorUserId: MEMBER,
      targetUserId: null,
      entityId: null,
      entityType: null,
      before: null,
      after: null,
      role: 'admin',
    });
    const echo = auditRow({
      createdAt: '2026-11-22T10:00:00+00:00',
      actorUserId: null,
      madeAs: 'service_role',
    });

    it('the true duplicate folds: the acceptance is one line, "joined as an admin"', () => {
      expect(kinds([invite, echo])).toEqual(['admin_joined']);
      // Recorded at the very moment of the acceptance: still its echo.
      expect(kinds([invite, { ...echo, createdAt: invite.createdAt }])).toEqual(['admin_joined']);
      // An invitation as staff and its echo: neither is an admin change.
      expect(
        kinds([
          { ...invite, role: 'staff' },
          { ...echo, before: null, after: { role: 'staff' } },
        ]),
      ).toEqual([]);
    });

    it('invited as staff and made an admin the same day: the promotion is listed, with the member', () => {
      const promotion = auditRow({ createdAt: '2026-11-22T15:00:00+00:00' });
      const list = extractBriefingChanges([promotion, { ...invite, role: 'staff' }]);
      expect(list).toEqual([
        {
          kind: 'admin_promoted',
          at: promotion.createdAt,
          actorUserId: ACTOR,
          subjectUserId: MEMBER,
          fromRole: 'staff',
          toRole: 'admin',
        },
      ]);
      expect(
        describeBriefingChange(list[0]!, {
          actor: 'Dana Example (dana@example.com)',
          subject: 'Alex Example (alex@example.com)',
        }),
      ).toBe(
        'Alex Example (alex@example.com) was made an admin by Dana Example (dana@example.com).',
      );
      // The same when the promotion was recorded before the acceptance row
      // that day: the invitation gave staff, the change ends at admin.
      expect(
        kinds([
          { ...invite, role: 'staff' },
          { ...promotion, createdAt: '2026-11-22T09:00:00+00:00' },
        ]),
      ).toEqual(['admin_promoted']);
    });

    // The database builder's first case (CONTRACT.md item 10): the demotion
    // ends at the invitation's role, and is recorded AFTER the acceptance.
    it('invited as staff, made an admin and moved back the same day: both are listed', () => {
      expect(
        kinds([
          auditRow({
            createdAt: '2026-11-22T17:00:00+00:00',
            before: { role: 'admin' },
            after: { role: 'staff' },
          }),
          auditRow({ createdAt: '2026-11-22T15:00:00+00:00' }),
          { ...invite, role: 'staff' },
        ]),
      ).toEqual(['admin_demoted', 'admin_promoted']);
    });

    it('invited as an admin and moved to staff the same day: joined and demoted are both listed', () => {
      expect(
        kinds([
          auditRow({
            createdAt: '2026-11-22T17:00:00+00:00',
            before: { role: 'admin' },
            after: { role: 'staff' },
          }),
          invite,
          echo,
        ]),
      ).toEqual(['admin_demoted', 'admin_joined']);
    });

    // The database builder's second case: the promotion ends at the
    // invitation's role, and is recorded AFTER the acceptance.
    it('a change to the invited role AFTER the acceptance is a real one: listed', () => {
      // Invited as an admin, moved to staff, made an admin again that day.
      expect(
        kinds([
          auditRow({ createdAt: '2026-11-22T18:00:00+00:00' }),
          auditRow({
            createdAt: '2026-11-22T17:00:00+00:00',
            before: { role: 'admin' },
            after: { role: 'staff' },
          }),
          invite,
          echo,
        ]),
      ).toEqual(['admin_promoted', 'admin_demoted', 'admin_joined']);
      // One millisecond after the acceptance is after it.
      expect(kinds([invite, { ...echo, createdAt: '2026-11-22T10:00:01.001+00:00' }])).toEqual([
        'admin_promoted',
        'admin_joined',
      ]);
    });

    it('only the same member, the same UTC day and a real acceptance fold', () => {
      // Another member's role change the same day stands.
      expect(kinds([invite, { ...echo, targetUserId: OTHER }])).toEqual([
        'admin_joined',
        'admin_promoted',
      ]);
      // A row that names no member is never folded.
      expect(kinds([invite, { ...echo, targetUserId: null }])).toEqual([
        'admin_joined',
        'admin_promoted',
      ]);
      // The day before, by the UTC day, whatever offset the time is written with.
      expect(kinds([invite, { ...echo, createdAt: '2026-11-21T23:59:59+00:00' }])).toEqual([
        'admin_joined',
        'admin_promoted',
      ]);
      expect(kinds([invite, { ...echo, createdAt: '2026-11-21T18:59:59-05:00' }])).toEqual([
        'admin_joined',
        'admin_promoted',
      ]);
      // An "already a member" press folds nothing, whatever role it names.
      expect(kinds([{ ...invite, alreadyMember: true }, echo])).toEqual(['admin_promoted']);
      expect(kinds([{ ...invite, role: null, alreadyMember: true }, echo])).toEqual([
        'admin_promoted',
      ]);
      // An acceptance that names no role folds nothing.
      expect(kinds([{ ...invite, role: null }, echo])).toEqual(['admin_promoted']);
    });
  });

  it('an ownership move is never folded by an invitation the same UTC day', () => {
    const invite = auditRow({
      createdAt: '2026-11-22T09:00:00+00:00',
      event: 'user.invite.accepted',
      actorUserId: MEMBER,
      targetUserId: null,
      entityId: null,
      entityType: null,
      before: null,
      after: null,
      role: 'admin',
    });
    // Later that day the new member is made the owner: the database writes
    // one row for each side of the move, both with one time.
    const movedAt = '2026-11-22T15:00:00+00:00';
    const toOwner = auditRow({
      createdAt: movedAt,
      actorUserId: null,
      targetUserId: MEMBER,
      before: { role: 'admin' },
      after: { role: 'owner' },
      madeAs: 'service_role',
    });
    const fromOwner = auditRow({
      createdAt: movedAt,
      actorUserId: null,
      targetUserId: OTHER,
      before: { role: 'owner' },
      after: { role: 'admin' },
      madeAs: 'service_role',
    });
    const changes = extractBriefingChanges([toOwner, fromOwner, invite]);
    expect(changes).toEqual([
      {
        kind: 'ownership_moved',
        at: movedAt,
        actorUserId: null,
        fromUserId: OTHER,
        toUserId: MEMBER,
        inRoleRows: true,
      },
      {
        kind: 'admin_joined',
        at: invite.createdAt,
        actorUserId: null,
        subjectUserId: MEMBER,
        fromRole: null,
        toRole: 'admin',
      },
    ]);
    expect(weekTally(changes, 0)).toEqual({ ownershipMoved: 1 });
    // The new owner's row alone is still a move, whatever the invitation gave.
    expect(kinds([toOwner, invite])).toEqual(['ownership_moved', 'admin_joined']);
    expect(kinds([toOwner, { ...invite, role: 'staff' }])).toEqual(['ownership_moved']);
    // Even an invitation that itself gave owner, recorded after the role
    // row (the shape of an acceptance seen twice), sets no owner row aside.
    expect(
      kinds([{ ...invite, createdAt: '2026-11-22T15:00:01+00:00', role: 'owner' }, toOwner]),
    ).toEqual(['admin_joined', 'ownership_moved']);
    // The owner who accepted an invitation that day and then handed over: the same.
    expect(kinds([fromOwner, { ...invite, actorUserId: OTHER }])).toEqual([
      'ownership_moved',
      'admin_joined',
    ]);
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
    expect(weekTally(list, 0)).toEqual({});
    // The app's row a little BEFORE the database's rows (a web clock running
    // behind) is still that move's row: one line, with the names.
    const databaseMove = auditRow({
      createdAt: '2026-11-10T10:00:00.400+00:00',
      actorUserId: null,
      before: { role: 'admin' },
      after: { role: 'owner' },
    });
    expect(extractBriefingChanges([appRow, databaseMove])).toEqual([
      {
        kind: 'ownership_moved',
        at: databaseMove.createdAt,
        actorUserId: ACTOR,
        fromUserId: ACTOR,
        toUserId: MEMBER,
        inRoleRows: true,
      },
    ]);
    // More than a few seconds before is not.
    expect(kinds([appRow, { ...databaseMove, createdAt: '2026-11-10T10:00:06+00:00' }])).toEqual([
      'ownership_moved',
      'ownership_moved',
    ]);
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

/**
 * What the lines of a list add up to for the rows at or after `since`, by
 * the names of the database's counts. A TEST'S TALLY ONLY: the app never
 * counts the list (it is made from a capped number of rows); it shows the
 * database's own counts. This pins that a line and a count agree about any
 * one row. `admins_added_this_week` is not here: it is a count of distinct
 * people that also reads the membership table.
 */
function weekTally(list: readonly BriefingChange[], since: number): Record<string, number> {
  const tally: Record<string, number> = {};
  const add = (key: string) => {
    tally[key] = (tally[key] ?? 0) + 1;
  };
  for (const c of list) {
    if (Date.parse(c.at) < since) continue;
    if (c.kind === 'admin_promoted') add('adminsPromoted');
    else if (c.kind === 'admin_demoted' || c.kind === 'admin_removed') {
      add('adminsDemotedOrRemoved');
    } else if (c.kind === 'ownership_moved') {
      if (c.inRoleRows) add('ownershipMoved');
    } else if (c.kind === 'policy_changed') {
      add(
        c.direction === 'loosened'
          ? 'policyLoosened'
          : c.direction === 'tightened'
            ? 'policyTightened'
            : 'policyChangedOther',
      );
    }
  }
  return tally;
}

describe("the list's lines and the database's counts agree about each row", () => {
  const SINCE = NOW - 7 * DAY;
  const inWeek = '2026-11-20T08:00:00+00:00';

  /** Each case: the rows of one organization and what platform_security_briefing_changes counts for them. */
  const CASES: Array<{
    name: string;
    rows: BriefingAuditRow[];
    want: Record<string, number>;
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
      name: 'an invitation as admin and its own role row: the invite wins, and is not a promotion',
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
      name: 'invited as staff and made an admin the same day: one promotion',
      rows: [
        auditRow({
          createdAt: inWeek,
          event: 'user.invite.accepted',
          actorUserId: MEMBER,
          targetUserId: null,
          role: 'staff',
          before: null,
          after: null,
        }),
        auditRow({ createdAt: '2026-11-20T15:00:00+00:00' }),
      ],
      want: { adminsPromoted: 1 },
    },
    {
      name: 'made an admin and moved back the same day: one of each',
      rows: [
        auditRow({ createdAt: inWeek }),
        auditRow({
          createdAt: '2026-11-20T15:00:00+00:00',
          before: { role: 'admin' },
          after: { role: 'staff' },
        }),
      ],
      want: { adminsPromoted: 1, adminsDemotedOrRemoved: 1 },
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
    expect(weekTally(extractBriefingChanges(rows), SINCE)).toEqual(want);
  });

  it('the week starts seven days back, that moment included', () => {
    const at = (ms: number) => [auditRow({ createdAt: new Date(ms).toISOString() })];
    expect(weekTally(extractBriefingChanges(at(SINCE)), SINCE)).toEqual({ adminsPromoted: 1 });
    expect(weekTally(extractBriefingChanges(at(SINCE - 1)), SINCE)).toEqual({});
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

  it('a member is written with their email: the name they chose never stands alone', () => {
    expect(briefingPersonLabel('Alex Example', 'alex@example.com')).toBe(
      'Alex Example (alex@example.com)',
    );
    expect(briefingPersonLabel('  Alex Example  ', ' alex@example.com ')).toBe(
      'Alex Example (alex@example.com)',
    );
    // No name: the email alone. No email: nothing to write.
    expect(briefingPersonLabel(null, 'alex@example.com')).toBe('alex@example.com');
    expect(briefingPersonLabel('   ', 'alex@example.com')).toBe('alex@example.com');
    expect(briefingPersonLabel('Alex Example', null)).toBeNull();
    expect(briefingPersonLabel('Alex Example', '  ')).toBeNull();
    // A member who names themselves after the support label, or after the
    // words for an unnamed person, still reads as themselves.
    for (const chosen of [
      BRIEFING_SUPPORT_ACTOR,
      BRIEFING_FORMER_MEMBER,
      BRIEFING_UNNAMED_MEMBER,
    ]) {
      const label = briefingPersonLabel(chosen, 'sam@example.com');
      expect(label).toBe(`${chosen} (sam@example.com)`);
      expect(label).not.toBe(chosen);
    }
    const loosened = {
      kind: 'policy_changed' as const,
      at,
      actorUserId: ACTOR,
      from: 'all_required',
      to: 'optional',
      direction: 'loosened' as const,
    };
    const byMember = describeBriefingChange(loosened, {
      actor: briefingPersonLabel(BRIEFING_SUPPORT_ACTOR, 'sam@example.com'),
    });
    const bySupport = describeBriefingChange(loosened, { actor: BRIEFING_SUPPORT_ACTOR });
    expect(byMember).toBe(
      'The sign-in policy was loosened: Required for everyone to Optional by StockPilot support (sam@example.com).',
    );
    expect(bySupport).toBe(
      'The sign-in policy was loosened: Required for everyone to Optional by StockPilot support.',
    );
    expect(byMember).not.toBe(bySupport);
  });

  it('a name or an email starts a sentence as it is written; only the stand-in words get a capital', () => {
    expect(
      describeBriefingChange({ ...base, kind: 'admin_promoted' }, { subject: 'alex@example.com' }),
    ).toBe('alex@example.com was made an admin.');
    expect(
      describeBriefingChange(
        { ...base, kind: 'admin_promoted' },
        { subject: 'de la Example (dana@example.com)' },
      ),
    ).toBe('de la Example (dana@example.com) was made an admin.');
    expect(
      describeBriefingChange(
        { ...base, kind: 'admin_promoted' },
        { subject: BRIEFING_UNNAMED_MEMBER },
      ),
    ).toBe('A member was made an admin.');
    expect(BRIEFING_UNNAMED_MEMBER).toBe('a member');
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
    expect(b.organizationsChecked).toBe(true);
    expect(b.organizationsAllChecked).toBe(true);
    expect(b.organizationsUnchecked).toEqual([]);
  });

  it('"no organization ..." is said only when all three organization reads answered, whole', () => {
    const CLAIM = 'No organization needs attention this week.';
    const PARTS = {
      members: 'Second steps and reported sign-ins could not be checked.',
      events: 'Blocked and flagged activity could not be checked.',
      changes: 'Admin and sign-in policy changes could not be checked.',
    } as const;
    // Each of the three failing alone, the other two quiet.
    for (const failed of ['members', 'events', 'changes'] as const) {
      const b = buildPlatformSecurityBriefing(platformInput({ [failed]: null }));
      expect(b.organizations).toEqual([]);
      expect(b.organizationsChecked).toBe(true);
      expect(b.organizationsAllChecked).toBe(false);
      expect(b.organizationsUnchecked).toEqual([PARTS[failed]]);
      expect(b.unchecked).toContain(PARTS[failed]);
      expect(b.bottomLine).not.toContain(CLAIM);
      expect(b.bottomLine).toBe(
        'Nothing needs attention in what could be checked. Some checks could not be made.',
      );
      // Never "N organizations have nothing to report" either.
      expect(b.organizationsWithNothingToReport).toBeNull();
      expect(b.status).toBe('incomplete');
    }
    // Two failed: both are named, in their order.
    expect(
      buildPlatformSecurityBriefing(platformInput({ members: null, changes: null }))
        .organizationsUnchecked,
    ).toEqual([PARTS.members, PARTS.changes]);
    // A read cut short at its cap is not a whole answer.
    const cut = buildPlatformSecurityBriefing(
      platformInput({ events: platformEvents({ truncated: true }) }),
    );
    expect(cut.organizationsAllChecked).toBe(false);
    expect(cut.bottomLine).not.toContain(CLAIM);
    expect(cut.organizationsWithNothingToReport).toBeNull();
    // The passkey repair read is not about the organizations: with it failed
    // the sentence stands, and the bottom line says a check could not be made.
    const repair = buildPlatformSecurityBriefing(platformInput({ passkeyRepair: null }));
    expect(repair.organizationsAllChecked).toBe(true);
    expect(repair.bottomLine).toBe(`${CLAIM} Some checks could not be made.`);
    // Something found and something unread: the count stands.
    const found = buildPlatformSecurityBriefing(
      platformInput({
        members: platformMembers([orgMembers(ORG_A, 'Example Academy', { withoutSecondStep: 1 })]),
        events: null,
      }),
    );
    expect(found.bottomLine).toBe(
      '1 organization needs attention this week. Some checks could not be made.',
    );
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
    // The second number is times seen, not passkeys: one passkey may be seen often.
    expect(both.items[0]?.whatWeSee).toBe(
      '2 sign-ins passed the passkey step in a way we cannot explain. A passkey looked like a copy of another once.',
    );
    expect(
      buildPlatformSecurityBriefing(
        platformInput({ events: platformEvents({ passkeyCountersWentBack: 3 }) }),
      ).items[0]?.whatWeSee,
    ).toBe('A passkey looked like a copy of another 3 times.');
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
      'Second steps and reported sign-ins could not be checked.',
      'Blocked and flagged activity could not be checked.',
      'Admin and sign-in policy changes could not be checked.',
      'Passkey set-ups that need repair could not be checked.',
    ]);
    expect(b.bottomLine).toBe('The organizations could not be checked.');
    expect(b.organizationsChecked).toBe(false);
    expect(b.organizationsAllChecked).toBe(false);
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
              adminsAdded: 2,
              adminsDemotedOrRemoved: 3,
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
        // Each its own number: never 2 + 3 + 1 in one cell.
        adminsAdded: 2,
        adminsRemoved: 3,
        ownershipMoves: 1,
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
        adminsAdded: 0,
        adminsRemoved: 0,
        ownershipMoves: 0,
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
        adminsAdded: 0,
        adminsRemoved: 0,
        ownershipMoves: 0,
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
      // The admins added are the changes read's own number: still known.
      expect(row.adminsAdded).not.toBeNull();
      expect(row.name).toBeNull();
      expect(row.blockedThisWeek).not.toBeNull();
    }
    expect(noMembers.organizationsWithNothingToReport).toBeNull();

    const noChanges = buildPlatformSecurityBriefing({ ...three(), changes: null });
    for (const row of noChanges.organizations) {
      expect(row.adminsAdded).toBeNull();
      expect(row.adminsRemoved).toBeNull();
      expect(row.ownershipMoves).toBeNull();
      expect(row.policyChanges).toBeNull();
    }
    expect(noChanges.organizationsWithNothingToReport).toBeNull();
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
      adminsAdded: null,
      adminsRemoved: null,
      ownershipMoves: null,
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
      adminsAdded: 2,
    });
  });

  it('an organization with only low items is worth a look, and is listed after the pressing ones', () => {
    const added = {
      organizations: [{ organizationId: ORG_B, ...changes({ adminsAdded: 1 }) }],
      truncated: false,
    };
    const b = buildPlatformSecurityBriefing(
      platformInput({
        members: platformMembers([
          orgMembers(ORG_B, 'Example Bakery'),
          orgMembers(ORG_A, 'Example Academy', { withoutSecondStep: 1 }),
        ]),
        changes: added,
      }),
    );
    expect(b.organizations.map((r) => [r.name, r.attention])).toEqual([
      ['Example Academy', 'medium'],
      ['Example Bakery', 'low'],
    ]);
    const onlyLow = buildPlatformSecurityBriefing(
      platformInput({
        members: platformMembers([orgMembers(ORG_B, 'Example Bakery')]),
        changes: added,
      }),
    );
    expect(onlyLow.status).toBe('worth_a_look');
    expect(onlyLow.organizationsNeedingAttention).toBe(0);
    expect(onlyLow.organizations[0]).toMatchObject({ adminsAdded: 1, adminsRemoved: 0 });
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
