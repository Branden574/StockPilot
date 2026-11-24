import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  POLICY_ACK_METHOD_LABELS,
  POLICY_ADMIN_COPY,
  POLICY_CHANGE_LABELS,
  POLICY_KIND_LABELS,
  POLICY_MEMBER_COPY,
  POLICY_REFUSAL_COPY,
  POLICY_STARTERS,
  POLICY_STARTER_NOTE,
  POLICY_STATUS_LABELS,
  policyAcknowledgedCount,
  policyAcknowledgedLine,
  policyAcknowledgedVersionLine,
  policyBodyHasStarterNote,
  policyCorrectionNotice,
  policyNotice,
  policyOwedBanner,
  policyPersonLabel,
  policyRefusalWords,
  policyRemindNowTooSoon,
  policyRemindedLine,
  policyReminderEmail,
  policyVersionLabel,
} from './policy-copy';
import {
  normalizePolicyBody,
  normalizePolicyTitle,
  parsePolicyText,
  policyBodyProblem,
  policyTitleProblem,
} from './policy-text';

/** Every string the module exports, through objects and the functions' answers for sample inputs. */
function everyWord(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk([
    POLICY_KIND_LABELS,
    POLICY_STATUS_LABELS,
    POLICY_ACK_METHOD_LABELS,
    POLICY_CHANGE_LABELS,
    POLICY_MEMBER_COPY,
    POLICY_ADMIN_COPY,
    POLICY_REFUSAL_COPY,
    POLICY_STARTERS,
    POLICY_STARTER_NOTE,
  ]);
  walk([
    policyOwedBanner(1),
    policyOwedBanner(3),
    policyNotice('T', 'published'),
    policyNotice('T', 'reminder'),
    policyReminderEmail({ title: 'T', organizationName: 'O' }),
    policyAcknowledgedLine('d', 'web'),
    policyAcknowledgedCount(1, 2),
    policyRemindedLine(2, 'd'),
    policyRemindNowTooSoon('t'),
    policyCorrectionNotice('T'),
    policyAcknowledgedVersionLine(2, 3, true),
  ]);
  return out;
}

describe('the words', () => {
  it('pin the labels', () => {
    expect(POLICY_KIND_LABELS).toEqual({
      acceptable_use: 'Acceptable use',
      data_handling: 'Data handling',
      other: 'Other',
    });
    expect(POLICY_STATUS_LABELS).toEqual({
      draft: 'Draft',
      published: 'Published',
      retired: 'Retired',
    });
    expect(POLICY_ACK_METHOD_LABELS).toEqual({ web: 'On the website', phone: 'In the phone app' });
    expect(POLICY_CHANGE_LABELS.new_version.label).toBe('Publish as a new version');
    expect(POLICY_CHANGE_LABELS.correction.explain).toBe(
      'For a small fix, such as a typo. Nobody is asked again, and acknowledgements of the version it corrects still count.',
    );
  });

  it('pin the member and admin sentences that make a claim', () => {
    expect(POLICY_MEMBER_COPY.agreeButton).toBe('I have read and agree');
    expect(POLICY_ADMIN_COPY.whatItRecords).toBe(
      'An acknowledgement records that a person pressed “I have read and agree” while signed in as themselves. It does not prove that they read or understood the policy, and StockPilot gives no legal opinion on its words.',
    );
    expect(POLICY_ADMIN_COPY.automaticReminders).toBe(
      'Members who have not acknowledged it are reminded after 3 days and 7 days, then once a week, at most 6 times.',
    );
    expect(POLICY_ADMIN_COPY.remindNowExplain).toBe(
      'Sends a reminder to everyone who has not acknowledged it. You can do this once a day.',
    );
    expect(POLICY_STARTER_NOTE).toBe(
      'A starting point, not legal advice. Edit every part to fit your organization, and remove this paragraph, before you publish.',
    );
  });

  it('build the variable sentences', () => {
    expect(policyOwedBanner(1)).toEqual({
      title: 'A policy needs your acknowledgement',
      body: 'Your organization asks you to read it and confirm that you agree. You can keep working in the meantime.',
      action: 'Read the policy',
    });
    expect(policyOwedBanner(2).title).toBe('2 policies need your acknowledgement');
    expect(policyAcknowledgedLine('24 Nov 2026', 'phone')).toBe(
      'You acknowledged this on 24 Nov 2026, in the phone app.',
    );
    expect(policyAcknowledgedCount(12, 15)).toBe('12 of 15 members have acknowledged it.');
    expect(policyAcknowledgedCount(0, 1)).toBe('0 of 1 member has acknowledged it.');
    expect(policyAcknowledgedCount(-1, Number.NaN)).toBe('0 of 0 members have acknowledged it.');
    expect(policyVersionLabel(3, true)).toBe('Version 3');
    expect(policyVersionLabel(4, false)).toBe('Version 4 (a correction)');
    expect(policyRemindedLine(0, null)).toBe('Not reminded yet.');
    expect(policyRemindedLine(1, '2 Nov')).toBe('Reminded once, last on 2 Nov.');
    expect(policyRemindedLine(3, '9 Nov')).toBe('Reminded 3 times, last on 9 Nov.');
    expect(policyRemindNowTooSoon('13:00')).toBe(
      'A reminder was sent less than a day ago. You can send another after 13:00.',
    );
    expect(policyNotice('Data handling', 'published')).toEqual({
      title: 'New policy to read: Data handling',
      body: 'Your organization published a policy. Read it and press “I have read and agree”.',
    });
    expect(
      policyReminderEmail({ title: 'Acceptable use', organizationName: 'Example Co' }).subject,
    ).toBe('Please read and acknowledge: Acceptable use');
  });

  it('say which version a person acknowledged and whether the current text corrects it', () => {
    expect(policyAcknowledgedVersionLine(2, 2, false)).toBe('Acknowledged version 2.');
    expect(policyAcknowledgedVersionLine(2, 3, true)).toBe(
      'Acknowledged version 2. The current text is version 3, a correction of it.',
    );
    expect(policyAcknowledgedVersionLine(3, 3, true)).toBe('Acknowledged version 3.');
    expect(policyCorrectionNotice('Data handling')).toEqual({
      title: 'A policy you acknowledged was corrected: Data handling',
      body: 'You do not need to acknowledge it again. You can read the corrected text and the text you agreed to.',
    });
    expect(POLICY_ADMIN_COPY.formerMemberNoName).toBe('Former member, no name on the account');
    expect(policyRefusalWords('mfa_required')).toBe(POLICY_ADMIN_COPY.authenticatorNeeded);
    expect(policyRefusalWords('aal2_required')).toBe(
      'Finish signing in with your second step, then try again.',
    );
    expect(policyRefusalWords('policy_correction_changes_title')).toBe(
      'A correction keeps the title. To change the title, publish a new version: everyone is asked again.',
    );
  });

  it('name a person as the record keeps them, with "Deleted user" for a deleted account', () => {
    expect(policyPersonLabel({ name: 'Jordan Example', accountDeleted: false })).toBe(
      'Jordan Example',
    );
    expect(policyPersonLabel({ name: 'Jordan Example', accountDeleted: true })).toBe(
      'Jordan Example (Deleted user)',
    );
    expect(policyPersonLabel({ name: null, accountDeleted: true })).toBe('Deleted user');
    expect(policyPersonLabel({ name: '  ', accountDeleted: false })).toBe('No name on the account');
  });

  it('have no exclamation mark, no emoji, and never "book"', () => {
    for (const w of everyWord()) {
      expect(w, w).not.toMatch(/!/);
      expect(w, w).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(w, w).not.toMatch(/\bbooks?\b/i);
    }
  });

  it('have words for every hint the migration raises to a caller, and a fallback', () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL('../../../../supabase/migrations/0482_org_policies.sql', import.meta.url),
      ),
      'utf8',
    );
    const hints = new Set([...sql.matchAll(/hint = '([a-z0-9_]+)'/g)].map((m) => m[1]!));
    // The guards', the preflight's and the rollback block's hints reach no API role (only the tables' owner).
    const internal = [...hints].filter(
      (h) =>
        h.startsWith('org_policy') ||
        h === 'org_policies_preflight' ||
        h === 'org_policies_rollback_refused',
    );
    const forCallers = [...hints].filter((h) => !internal.includes(h)).sort();
    expect(forCallers.length).toBeGreaterThan(10);
    for (const h of forCallers) expect(Object.keys(POLICY_REFUSAL_COPY), h).toContain(h);
    expect(policyRefusalWords('nonsense')).toBe(POLICY_MEMBER_COPY.failed);
    expect(policyRefusalWords(undefined)).toBe(POLICY_MEMBER_COPY.failed);
    expect(policyRefusalWords('toString')).toBe(POLICY_MEMBER_COPY.failed);
    expect(policyRefusalWords('policy_text_changed')).toBe(POLICY_MEMBER_COPY.textChanged);
  });
});

describe('the starter texts', () => {
  it('are two, one per named kind, in normal form, within the limits, marked as a starting point', () => {
    expect(POLICY_STARTERS.map((s) => s.kind)).toEqual(['acceptable_use', 'data_handling']);
    for (const s of POLICY_STARTERS) {
      expect(normalizePolicyTitle(s.title)).toBe(s.title);
      expect(policyTitleProblem(s.title)).toBeNull();
      expect(normalizePolicyBody(s.body)).toBe(s.body);
      expect(policyBodyProblem(s.body)).toBeNull();
      expect(s.body.startsWith(`${POLICY_STARTER_NOTE}\n\n`)).toBe(true);
      expect(policyBodyHasStarterNote(s.body)).toBe(true);
      const blocks = parsePolicyText(s.body);
      expect(blocks.filter((b) => b.kind === 'heading').length).toBeGreaterThanOrEqual(4);
      expect(blocks.some((b) => b.kind === 'bullets')).toBe(true);
      expect(s.body.length).toBeLessThan(2000);
      // Generic: no address, link, number to call or organization name.
      expect(s.body).not.toMatch(/https?:|www\.|@|\d{3}/);
    }
    expect(policyBodyHasStarterNote('# Our own words')).toBe(false);
  });
});
