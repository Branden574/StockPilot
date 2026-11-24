import { cleanup, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildPlatformSecurityBriefing,
  buildSecurityBriefing,
  type BriefingMembersInput,
  type PlatformSecurityBriefingInput,
} from '@stockpilot/core';

/**
 * The security briefing section of the platform console.
 *
 * Security invariant. Pinned: the all-organizations part shows counts only
 * (no person's name, no email) and reads nothing about one organization
 * unless one is asked for; a number whose read failed says "Could not check",
 * never a zero; every link to an organization's briefing or console page is
 * never prefetched (opening either writes an audit row). For one
 * organization: the organization is found first, then the viewed_org row is
 * written, then the detail is read. An id that names no organization writes
 * no row and reads nothing, and neither does a row that could not be
 * written. Made-up people and organizations only.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  platform: vi.fn(),
  find: vi.fn(),
  detail: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      prefetch,
      children,
      className,
    }: {
      href: string;
      prefetch?: boolean | null;
      children: React.ReactNode;
      className?: string;
    }) =>
      React.createElement('a', { href, className, 'data-prefetch': String(prefetch) }, children),
  };
});
vi.mock('@/server/services/platform/security-briefing', () => ({
  readPlatformSecurityBriefing: (...a: unknown[]) => {
    h.order.push('platform');
    return h.platform(...a);
  },
  findBriefingOrganization: (...a: unknown[]) => {
    h.order.push('find');
    return h.find(...a);
  },
  readOrganizationSecurityBriefing: (...a: unknown[]) => {
    h.order.push('detail');
    return h.detail(...a);
  },
}));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: (...a: unknown[]) => {
    h.order.push('audit');
    return h.audit(...a);
  },
}));

import { PlatformSecurityBriefingSection } from './platform-security-briefing-section';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const OLD_ENOUGH = '2026-11-01T00:00:00+00:00';
const ORG_A = '5eed0000-0001-4000-8000-00000000000a';
const ORG_B = '5eed0000-0001-4000-8000-00000000000b';
const ACTOR = { userId: 'p1', email: 'owner@example.com' };

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

function platformInput(
  over: Partial<PlatformSecurityBriefingInput> = {},
): PlatformSecurityBriefingInput {
  return {
    now: NOW,
    members: {
      organizations: [
        {
          organizationId: ORG_A,
          name: 'Example Academy',
          ...members({ withoutSecondStep: 5, adminsWithoutSecondStep: 1 }),
        },
        { organizationId: ORG_B, name: 'Example Bakery', ...members() },
      ],
      truncated: false,
      totalOrganizations: 40,
      accounts: 1204,
      accountsWithoutSecondStep: 310,
      adminAccountsWithoutSecondStep: 4,
    },
    events: {
      organizations: [
        {
          organizationId: ORG_A,
          thisWeek: { password_guessing: { blocked: 1250, flagged: 1, allowed: 0 } },
          lastWeek: { password_guessing: { blocked: 4, flagged: 0, allowed: 0 } },
        },
        {
          organizationId: ORG_B,
          thisWeek: { bots: { blocked: 2, flagged: 0, allowed: 0 } },
          lastWeek: {},
        },
      ],
      truncated: false,
      noOrganization: {
        thisWeek: { exploit: { blocked: 7, flagged: 0, allowed: 0 } },
        lastWeek: {},
      },
      passkeyUnexplainedSignIns: 1,
      passkeyCountersWentBack: 0,
      oldestEventAt: OLD_ENOUGH,
    },
    changes: {
      organizations: [
        {
          organizationId: ORG_A,
          adminsAdded: 2,
          adminsDemotedOrRemoved: 0,
          ownershipMoved: 0,
          policyLoosened: 1,
          policyTightened: 0,
          policyChangedOther: 0,
        },
      ],
      truncated: false,
    },
    passkeyRepair: { accounts: 0, capped: false },
    ...over,
  };
}

function organizationBriefing() {
  return {
    briefing: buildSecurityBriefing({
      now: NOW,
      members: members({
        withoutSecondStep: 5,
        adminsWithoutSecondStep: 1,
        membersWithIdleSignIns: 2,
        idleSignIns: 3,
      }),
      events: {
        thisWeek: { password_guessing: { blocked: 25, flagged: 1, allowed: 0 } },
        lastWeek: { password_guessing: { blocked: 4, flagged: 0, allowed: 0 } },
        oldestEventAt: OLD_ENOUGH,
      },
      changes: {
        adminsAdded: 1,
        adminsDemotedOrRemoved: 0,
        ownershipMoved: 0,
        policyLoosened: 0,
        policyTightened: 0,
        policyChangedOther: 0,
      },
    }),
    detail: {
      people: [
        {
          userId: 'u1',
          fullName: 'Alex Example',
          email: 'alex@example.com',
          role: 'admin',
          notes: ['No second step', '2 sign-ins not used in 30 days, the oldest since 3 Oct'],
        },
        {
          userId: 'u2',
          fullName: null,
          email: 'sam@example.com',
          role: 'staff',
          notes: ['No second step'],
        },
      ],
      peopleTruncated: false,
      idleAfterDays: 30,
      changes: [
        {
          at: '2026-11-22T18:04:11.52+00:00',
          text: 'Alex Example (alex@example.com) was made an admin by Dana Example (dana@example.com).',
        },
      ],
      changesTruncated: false,
      changesRowsRead: 1,
    },
  };
}

async function renderSection(organizationId: string | null = null) {
  render(await PlatformSecurityBriefingSection({ organizationId, actor: ACTOR }));
  return screen.getByRole('region', { name: 'Security briefing' });
}

const cells = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    );

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.platform.mockResolvedValue(buildPlatformSecurityBriefing(platformInput()));
  h.find.mockResolvedValue({ found: true, id: ORG_A, name: 'Example Academy' });
  h.audit.mockResolvedValue(true);
  h.detail.mockResolvedValue(organizationBriefing());
});

describe('all organizations', () => {
  it('the bottom line, the totals, the platform items and the table of counts', async () => {
    const section = await renderSection();
    expect(
      within(section).getByRole('heading', { name: 'This week across all organizations' }),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        '1 platform check needs attention. 1 organization needs attention this week.',
      ),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        '1,204 accounts in 40 organizations. 310 have no second step, 4 of them an owner or admin.',
      ),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        'With no organization: 7 blocked this week, 0 last week, 0 flagged this week.',
      ),
    ).toBeInTheDocument();
    // An item: its severity in a word, its headline and the three labelled lines.
    expect(
      within(section).getByText('1 passkey sign-in did not look right this week'),
    ).toBeInTheDocument();
    for (const label of ['What we see:', 'Why it matters:', 'What to do:', 'Who can fix it:']) {
      expect(within(section).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(within(section).getByText('In good shape')).toBeInTheDocument();

    const table = within(section).getByRole('region', {
      name: 'Security briefing by organization',
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual([
      'Organization',
      'Attention',
      'Blocked this week',
      'Blocked last week',
      'Flagged this week',
      'Admins without a second step',
      'Members without a second step',
      'Sign-ins reported',
      // Each its own number: admins added is never summed with another.
      'Admins added',
      'Admins removed or changed role',
      'Ownership moves',
      'Policy changes',
    ]);
    expect(cells(table)).toEqual([
      ['Example Academy', 'High', '1,250', '4', '1', '1', '4', '0', '2', '0', '0', '1'],
      ['Example Bakery', 'None', '2', '0', '0', '0', '0', '0', '0', '0', '0', '0'],
    ]);
    expect(within(section).getByText('38 organizations have nothing to report.')).toBeTruthy();
  });

  it('a sign-in alert kind is named "Sign-in alert", never Phishing or Malware, across all organizations and in one (lab walk 3, F1)', async () => {
    const alerts = { phishing: { blocked: 0, flagged: 4, allowed: 0 } };
    h.platform.mockResolvedValue(
      buildPlatformSecurityBriefing(
        platformInput({
          events: {
            organizations: [{ organizationId: ORG_A, thisWeek: alerts, lastWeek: {} }],
            truncated: false,
            noOrganization: { thisWeek: alerts, lastWeek: {} },
            passkeyUnexplainedSignIns: 0,
            passkeyCountersWentBack: 0,
            oldestEventAt: OLD_ENOUGH,
          },
        }),
      ),
    );
    const one = organizationBriefing();
    h.detail.mockResolvedValue({
      ...one,
      briefing: buildSecurityBriefing({
        now: NOW,
        members: members(),
        events: { thisWeek: alerts, lastWeek: {}, oldestEventAt: OLD_ENOUGH },
        changes: {
          adminsAdded: 0,
          adminsDemotedOrRemoved: 0,
          ownershipMoved: 0,
          policyLoosened: 0,
          policyTightened: 0,
          policyChangedOther: 0,
        },
      }),
    });
    const section = await renderSection();
    expect(section.textContent).not.toMatch(/phishing|malware/i);
    cleanup();
    const org = await renderSection(ORG_A);
    expect(org.textContent).toContain('Sign-in alert');
    expect(org.textContent).not.toMatch(/phishing|malware/i);
  });

  it('the Organization column keeps a width of its own, and a long name or an id breaks inside it', async () => {
    const section = await renderSection();
    const table = within(section).getByRole('region', {
      name: 'Security briefing by organization',
    });
    const head = within(table).getByRole('columnheader', { name: 'Organization' });
    const firstCells = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[0]!);
    expect(firstCells.length).toBeGreaterThan(0);
    // The head and every cell of the column, so neither appearance can
    // squeeze it to the width of its header.
    expect(head.className.split(/\s+/)).toContain('min-w-[14rem]');
    for (const cell of firstCells) {
      const classes = cell.className.split(/\s+/);
      expect(classes).toContain('min-w-[14rem]');
      // A long unbroken word, or an id in place of a name, wraps too.
      expect(classes).toContain('[overflow-wrap:anywhere]');
      expect(classes).not.toContain('whitespace-nowrap');
    }
    // No other column is given a minimum: the numbers stay as narrow as they are.
    const others = within(table).getAllByRole('columnheader').slice(1);
    expect(others.some((h) => /min-w-/.test(h.className))).toBe(false);
    // The table's own floor: below the card's width on a 1360 screen in Classic.
    expect((table.querySelector('table') as HTMLTableElement).style.minWidth).toBe('1200px');
  });

  it("each organization's name links to its briefing, never prefetched", async () => {
    h.platform.mockResolvedValue(
      buildPlatformSecurityBriefing({ ...platformInput(), members: null }),
    );
    const section = await renderSection();
    const links = within(section).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `/platform/security?org=${ORG_A}`,
      `/platform/security?org=${ORG_B}`,
    ]);
    // Opening one organization's briefing writes an audit row.
    expect(links.map((a) => a.getAttribute('data-prefetch'))).toEqual(['false', 'false']);
    // The members read names the organizations: without it, the id is shown.
    expect(links.map((a) => a.textContent)).toEqual([ORG_A, ORG_B]);
  });

  it('a read that failed: "Could not check" in its columns of every row, never a zero', async () => {
    h.platform.mockResolvedValue(
      buildPlatformSecurityBriefing({ ...platformInput(), events: null, changes: null }),
    );
    const section = await renderSection();
    const table = within(section).getByRole('region', {
      name: 'Security briefing by organization',
    });
    expect(cells(table)).toEqual([
      [
        'Example Academy',
        'High',
        'Could not check',
        'Could not check',
        'Could not check',
        '1',
        '4',
        '0',
        'Could not check',
        'Could not check',
        'Could not check',
        'Could not check',
      ],
    ]);
    expect(
      within(section).getByText('Blocked and flagged activity could not be checked.'),
    ).toBeInTheDocument();
    expect(
      within(section).getByText('Admin and sign-in policy changes could not be checked.'),
    ).toBeInTheDocument();
  });

  it('the members read failed: its columns say so, and no "nothing to report" count is made up', async () => {
    h.platform.mockResolvedValue(
      buildPlatformSecurityBriefing({ ...platformInput(), members: null }),
    );
    const section = await renderSection();
    const rows = cells(
      within(section).getByRole('region', { name: 'Security briefing by organization' }),
    );
    for (const row of rows) {
      expect(row.slice(5, 8)).toEqual(['Could not check', 'Could not check', 'Could not check']);
    }
    // The admins added are the changes read's own number: still shown.
    expect(rows[0]?.slice(8)).toEqual(['2', '0', '0', '1']);
    expect(within(section).queryByText(/nothing to report/)).toBeNull();
  });

  it('no read answered: "Could not check this week\'s summary.", and no table', async () => {
    h.platform.mockResolvedValue(
      buildPlatformSecurityBriefing({
        now: NOW,
        members: null,
        events: null,
        changes: null,
        passkeyRepair: null,
      }),
    );
    const section = await renderSection();
    expect(within(section).getByText("Could not check this week's summary.")).toBeInTheDocument();
    expect(
      within(section).queryByRole('region', { name: 'Security briefing by organization' }),
    ).toBeNull();
    expect(within(section).queryByText('In good shape')).toBeNull();
    expect(within(section).getByText('Could not check')).toBeInTheDocument();
  });

  it('a quiet week: the words, and no table', async () => {
    h.platform.mockResolvedValue(
      buildPlatformSecurityBriefing({
        ...platformInput(),
        members: { ...platformInput().members!, organizations: [], totalOrganizations: 1 },
        events: { ...platformInput().events!, organizations: [], passkeyUnexplainedSignIns: 0 },
        changes: { organizations: [], truncated: false },
      }),
    );
    const section = await renderSection();
    expect(
      within(section).getByText('No organization has anything to report this week.'),
    ).toBeInTheDocument();
    expect(within(section).getByText('1 organization has nothing to report.')).toBeTruthy();
  });

  it.each([
    ['members', 'Second steps and reported sign-ins could not be checked.'],
    ['events', 'Blocked and flagged activity could not be checked.'],
    ['changes', 'Admin and sign-in policy changes could not be checked.'],
  ] as const)(
    'the %s read failed and the other two are quiet: never "nothing to report", and the part is named',
    async (failed, part) => {
      const quiet = {
        ...platformInput(),
        members: { ...platformInput().members!, organizations: [], totalOrganizations: 12 },
        events: { ...platformInput().events!, organizations: [], passkeyUnexplainedSignIns: 0 },
        changes: { organizations: [], truncated: false },
      };
      h.platform.mockResolvedValue(buildPlatformSecurityBriefing({ ...quiet, [failed]: null }));
      const section = await renderSection();
      expect(
        within(section).queryByText('No organization has anything to report this week.'),
      ).toBeNull();
      expect(section.textContent).not.toMatch(/nothing to report/i);
      expect(section.textContent).not.toContain('No organization needs attention this week');
      // What is said instead, with the part that could not be checked.
      const table = within(section)
        .getByRole('heading', { name: 'Organizations with something to report' })
        .closest('div');
      expect(table?.textContent).toContain('Nothing to list from what could be checked.');
      expect(table?.textContent).toContain(part);
      expect(
        within(section).getByText(
          'No organization needs attention in what could be checked. Some checks could not be made.',
        ),
      ).toBeInTheDocument();
    },
  );

  it('more organizations than the table lists, and a read cut short, are said', async () => {
    const base = platformInput();
    const many = Array.from({ length: 51 }, (_, i) => ({
      organizationId: `5eed0000-0009-4000-8000-${String(i).padStart(12, '0')}`,
      name: `Example Organization ${String(i).padStart(2, '0')}`,
      ...members({ withoutSecondStep: 1 }),
    }));
    h.platform.mockResolvedValue(
      buildPlatformSecurityBriefing({
        ...base,
        members: {
          ...base.members!,
          organizations: many,
          truncated: true,
          totalOrganizations: 900,
        },
        events: { ...base.events!, organizations: [] },
        changes: { organizations: [], truncated: false },
      }),
    );
    const section = await renderSection();
    expect(
      within(section).getByText('1 more organization has something to report and is not listed.'),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(/There are more organizations than one read returns\./),
    ).toBeInTheDocument();
  });

  it('counts only: no email and no person, and nothing about one organization is read', async () => {
    const section = await renderSection();
    expect(section.textContent).not.toContain('@');
    expect(section.textContent).not.toMatch(/Alex|Dana/);
    expect(h.order).toEqual(['platform']);
    expect(h.find).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.detail).not.toHaveBeenCalled();
  });
});

describe('one organization (?org=)', () => {
  it('found, then the viewed_org row, then the detail: the row is written before the read starts', async () => {
    let written!: (landed: boolean) => void;
    h.audit.mockReturnValue(
      new Promise<boolean>((resolve) => {
        written = resolve;
      }),
    );
    const pending = PlatformSecurityBriefingSection({ organizationId: ORG_A, actor: ACTOR });
    await vi.waitFor(() => expect(h.audit).toHaveBeenCalledTimes(1));
    // The audit row is still being written: the detail has not been asked for.
    expect(h.detail).not.toHaveBeenCalled();
    expect(h.order.filter((s) => s !== 'platform')).toEqual(['find', 'audit']);
    written(true);
    render(await pending);
    expect(h.order.filter((s) => s !== 'platform')).toEqual(['find', 'audit', 'detail']);

    expect(h.find).toHaveBeenCalledWith(ORG_A);
    expect(h.audit).toHaveBeenCalledWith({
      actorUserId: 'p1',
      actorEmail: 'owner@example.com',
      action: 'viewed_org',
      targetOrganizationId: ORG_A,
      detail: { name: 'Example Academy', tab: 'security' },
    });
    expect(h.detail).toHaveBeenCalledWith(ORG_A);
  });

  it('an id that names no organization: no audit row, no read', async () => {
    h.find.mockResolvedValue({ found: false, failed: false });
    const section = await renderSection(ORG_B);
    expect(within(section).getByText('No organization has that id.')).toBeInTheDocument();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.detail).not.toHaveBeenCalled();
    // The all-organizations part is still shown.
    expect(
      within(section).getByRole('region', { name: 'Security briefing by organization' }),
    ).toBeInTheDocument();
  });

  it('the organization could not be looked up: no audit row, no read', async () => {
    h.find.mockResolvedValue({ found: false, failed: true });
    const section = await renderSection(ORG_A);
    expect(
      within(section).getByText(
        'Could not check that organization. Reload this page to try again.',
      ),
    ).toBeInTheDocument();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.detail).not.toHaveBeenCalled();
  });

  it('the audit row could not be written: nothing is read and nothing is shown', async () => {
    h.audit.mockResolvedValue(false);
    const section = await renderSection(ORG_A);
    expect(
      within(section).getByText(
        'This view of Example Academy could not be recorded, so its briefing is not shown. Reload this page to try again.',
      ),
    ).toBeInTheDocument();
    expect(h.detail).not.toHaveBeenCalled();
    expect(section.textContent).not.toContain('@');
  });

  it('the briefing: the bottom line, the items, the activity, the people with their email, the changes', async () => {
    const section = await renderSection(ORG_A);
    expect(
      within(section).getByRole('heading', { name: 'Security briefing: Example Academy' }),
    ).toBeInTheDocument();
    expect(within(section).getByText('3 things need attention this week.')).toBeInTheDocument();
    expect(within(section).getByText('1 admin has no second step')).toBeInTheDocument();
    expect(
      within(section).getByText('Password guessing: 25 blocked this week, up from 4'),
    ).toBeInTheDocument();

    expect(
      cells(
        within(section).getByRole('region', {
          name: 'Blocked and flagged activity: Example Academy',
        }),
      ),
    ).toEqual([['Password guessing', '25', '4', 'up from 4', '1', '0']]);

    expect(cells(within(section).getByRole('region', { name: 'People: Example Academy' }))).toEqual(
      [
        [
          'Alex Example',
          'alex@example.com',
          'Admin',
          'No second step2 sign-ins not used in 30 days, the oldest since 3 Oct',
        ],
        ['No name', 'sam@example.com', 'Staff', 'No second step'],
      ],
    );
    expect(
      within(section).getByText(
        '2 members have 3 sign-ins not used in 30 days. For information only.',
      ),
    ).toBeInTheDocument();

    expect(
      cells(
        within(section).getByRole('region', {
          name: 'Admin and sign-in policy changes: Example Academy',
        }),
      ),
    ).toEqual([
      [
        '22 Nov 2026, 6:04 PM UTC',
        'Alex Example (alex@example.com) was made an admin by Dana Example (dana@example.com).',
      ],
    ]);
  });

  it('a member who named themselves "StockPilot support": their email is beside the name, in People and in the changes', async () => {
    const base = organizationBriefing();
    h.detail.mockResolvedValue({
      ...base,
      detail: {
        ...base.detail,
        people: [
          {
            userId: 'u1',
            fullName: 'StockPilot support',
            email: 'alex@example.com',
            role: 'admin',
            notes: ['No second step'],
          },
        ],
        changes: [
          {
            at: '2026-11-22T18:04:11+00:00',
            text: 'The sign-in policy was loosened: Required for everyone to Optional by StockPilot support (alex@example.com).',
          },
          {
            at: '2026-11-21T18:04:11+00:00',
            text: 'The sign-in policy was tightened: Optional to Required for everyone by StockPilot support.',
          },
        ],
      },
    });
    const section = await renderSection(ORG_A);
    expect(cells(within(section).getByRole('region', { name: 'People: Example Academy' }))).toEqual(
      [['StockPilot support', 'alex@example.com', 'Admin', 'No second step']],
    );
    const lines = cells(
      within(section).getByRole('region', {
        name: 'Admin and sign-in policy changes: Example Academy',
      }),
    ).map((row) => row[1]);
    // The member's line carries their email; the real label carries none.
    expect(lines[0]).toMatch(/by StockPilot support \(alex@example\.com\)\.$/);
    expect(lines[1]).toMatch(/by StockPilot support\.$/);
  });

  it('a list cut at 200 rows that hides a loosened policy: the page still says it was loosened, and says the list is not whole', async () => {
    const zero = {
      adminsAdded: 0,
      adminsDemotedOrRemoved: 0,
      ownershipMoved: 0,
      policyLoosened: 0,
      policyTightened: 0,
      policyChangedOther: 0,
    };
    const base = organizationBriefing();
    h.detail.mockResolvedValue({
      // The week as the database counted it, from every audit row.
      briefing: buildSecurityBriefing({
        now: NOW,
        members: members(),
        events: { thisWeek: {}, lastWeek: {}, oldestEventAt: OLD_ENOUGH },
        changes: { ...zero, policyLoosened: 1 },
      }),
      // The list: 200 rows read, none of them an admin or policy change.
      detail: { ...base.detail, changes: [], changesTruncated: true, changesRowsRead: 200 },
    });
    const section = await renderSection(ORG_A);
    expect(
      within(section).getByText('The sign-in policy was loosened once this week'),
    ).toBeInTheDocument();
    expect(within(section).getByText('1 thing needs attention this week.')).toBeInTheDocument();
    expect(within(section).queryByText('No admin or sign-in policy change this week.')).toBeNull();
    // Never "none in the last 30 days" from a list that was cut.
    expect(
      within(section).queryByText('No admin or sign-in policy change in the last 30 days.'),
    ).toBeNull();
    expect(
      within(section).getByText(
        /^This list is made from the newest 200 audit entries, and none of them is an admin or sign-in policy change\. Older ones in the 30 days are not listed\./,
      ),
    ).toBeInTheDocument();
  });

  it("the link to the organization's console page is never prefetched", async () => {
    const section = await renderSection(ORG_A);
    const link = within(section).getByRole('link', { name: 'Open this organization' });
    expect(link.getAttribute('href')).toBe(`/platform/orgs/${ORG_A}`);
    expect(link.getAttribute('data-prefetch')).toBe('false');
    // Every link in the section: none is prefetched.
    for (const a of within(section).getAllByRole('link')) {
      expect(a.getAttribute('data-prefetch')).toBe('false');
    }
  });

  it('the all-organizations part shows no email even beside an organization that does', async () => {
    const section = await renderSection(ORG_A);
    const table = within(section).getByRole('region', {
      name: 'Security briefing by organization',
    });
    expect(table.textContent).not.toContain('@');
    const summary = within(section)
      .getByRole('heading', { name: 'This week across all organizations' })
      .closest('section');
    expect(summary?.textContent).not.toContain('@');
    expect(summary?.textContent).not.toMatch(/Alex|Dana/);
  });

  it('the detail could not be read: "Could not check", never an empty list', async () => {
    h.detail.mockResolvedValue({
      briefing: buildSecurityBriefing({ now: NOW, members: null, events: null, changes: null }),
      detail: null,
    });
    const section = await renderSection(ORG_A);
    expect(
      within(section).getByText('Nothing needs attention, but some checks could not be made.'),
    ).toBeInTheDocument();
    expect(within(section).getAllByText('Could not check.')).toHaveLength(3);
    expect(within(section).queryByRole('region', { name: /^People/ })).toBeNull();
    expect(within(section).queryByText(/Every member has a second step/)).toBeNull();
  });

  it('nothing to list: the words for each empty part, and the lists that were cut short', async () => {
    const quiet = organizationBriefing();
    h.detail.mockResolvedValue({
      briefing: buildSecurityBriefing({
        now: NOW,
        members: members(),
        events: { thisWeek: {}, lastWeek: {}, oldestEventAt: OLD_ENOUGH },
        changes: {
          adminsAdded: 0,
          adminsDemotedOrRemoved: 0,
          ownershipMoved: 0,
          policyLoosened: 0,
          policyTightened: 0,
          policyChangedOther: 0,
        },
      }),
      detail: {
        people: [],
        peopleTruncated: false,
        idleAfterDays: 30,
        changes: [],
        changesTruncated: false,
        changesRowsRead: 0,
      },
    });
    const section = await renderSection(ORG_A);
    expect(within(section).getAllByText('Everything we checked is in good shape.')).toHaveLength(1);
    expect(
      within(section).getByText('Nothing was blocked or flagged in the two weeks.'),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        'Every member has a second step, and no sign-in has gone unused for 30 days.',
      ),
    ).toBeInTheDocument();
    expect(
      within(section).getByText('No admin or sign-in policy change in the last 30 days.'),
    ).toBeInTheDocument();

    h.detail.mockResolvedValue({
      ...quiet,
      detail: {
        ...quiet.detail,
        peopleTruncated: true,
        changesTruncated: true,
        changesRowsRead: 200,
      },
    });
    cleanup();
    const cut = await renderSection(ORG_A);
    expect(within(cut).getByText('And more: only the first 2 are listed.')).toBeInTheDocument();
    // The number is the rows read, never the number of lines listed (1 here).
    expect(
      within(cut).getByText(
        /^This list is made from the newest 200 audit entries\. Older ones in the 30 days are not listed\./,
      ),
    ).toBeInTheDocument();
    expect(cut.textContent).not.toMatch(/newest 1 audit/);
  });
});
