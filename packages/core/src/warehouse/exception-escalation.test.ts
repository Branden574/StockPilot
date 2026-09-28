import { describe, expect, it } from 'vitest';

import { MAINTENANCE_CATEGORIES } from '../maintenance/constants';
import { maintenanceRequestFormSchema } from '../schemas/maintenance';

import * as escalation from './exception-escalation';
import {
  ESCALATE_MODULE_OFF_COPY,
  ESCALATE_NOT_PERMITTED_COPY,
  ESCALATE_OFFLINE_COPY,
  ESCALATE_RESOLVED_COPY,
  ESCALATION_DESCRIPTION_MIN,
  ESCALATION_DESCRIPTION_PREFILL_MAX,
  ESCALATION_SUBJECT_MAX,
  ESCALATION_SUBJECT_MIN,
  escalateDisabledReason,
  escalationAlreadyEscalatedCopy,
  escalationBadgeCopy,
  escalationDuplicateCopy,
  escalationPrefill,
  escalationRequestStateCopy,
  escalationSubject,
  type EscalationPrefillInput,
} from './exception-escalation';
import { describeOccurrenceEvent, EXCEPTION_RULE_IDS, type ExceptionRule } from './exceptions';

/**
 * F1-5: the escalation prefill and every sentence about an escalation, for
 * the web app and the phone.
 */

const NOW = '2026-09-27T12:00:00Z';

/** Realistic stored facts per rule (what exceptions_sync stores). */
const FACTS: Record<ExceptionRule, Record<string, unknown>> = {
  orphaned_stock: { itemName: 'Chromebook charger', sku: 'CB-65', units: 4, locationName: '40-C', locationKind: 'rack' },
  over_reserved: { itemName: 'Chromebook charger', sku: 'CB-65', promised: 12, onHand: 10 },
  stale_staging: { itemName: 'Chromebook charger', sku: 'CB-65', units: 12, locationName: 'Staging', locationKind: 'staging' },
  long_unplaced: { itemName: 'Chromebook charger', sku: 'CB-65', units: 1, locationName: 'Unplaced', locationKind: 'unplaced' },
  label_mismatch: { itemName: 'Chromebook charger', sku: 'CB-65', label: '40-C', stockOn: ['39-C'] },
  count_variance: {
    itemName: 'Chromebook charger',
    sku: 'CB-65',
    cycleCountId: '33333333-3333-4333-8333-333333333333',
    countNumber: 31,
    observedAt: NOW,
    completedAt: NOW,
    expected: 10,
    counted: 12,
    variance: 2,
    countedLocationName: '12-B',
    aiAssisted: false,
    capturedOfflineAt: null,
  },
};

function input(rule: ExceptionRule, o: Partial<EscalationPrefillInput> = {}): EscalationPrefillInput {
  return {
    rule,
    facts: FACTS[rule],
    itemName: 'Chromebook charger',
    sku: 'CB-65',
    locationName: ['orphaned_stock', 'stale_staging', 'long_unplaced'].includes(rule)
      ? (FACTS[rule].locationName as string)
      : null,
    reference: 'EX-000042',
    conditionSince: '2026-09-18T11:00:00Z',
    asOf: NOW,
    ...o,
  };
}

/** The request form's own verdict on a prefill, exactly as the server parses it. */
function formAccepts(p: { subject: string; description: string; category: string }): boolean {
  return maintenanceRequestFormSchema.safeParse({
    subject: p.subject,
    description: p.description,
    category: p.category,
    priority: 'normal',
  }).success;
}

describe('escalationPrefill: the words', () => {
  it('a Staging holding: rule title, units and age, location, reference, in that order', () => {
    const p = escalationPrefill(input('stale_staging'));
    expect(p.subject).toBe('Inventory issue: Chromebook charger (CB-65)');
    expect(p.description).toBe(
      'Sitting in Staging: 12 units in Staging for at least 9 days. Location: Staging. Ref EX-000042.',
    );
    expect(p.category).toBe('Inventory or equipment');
    expect(MAINTENANCE_CATEGORIES).toContain(p.category);
  });

  it('one unit reads "1 unit"; an archived location names it', () => {
    expect(escalationPrefill(input('long_unplaced')).description).toBe(
      'On hand but on no rack: 1 unit unplaced for at least 9 days. Location: Unplaced. Ref EX-000042.',
    );
    expect(escalationPrefill(input('orphaned_stock')).description).toBe(
      'Stock in an archived location: 4 units in 40-C, which is archived. Location: 40-C. Ref EX-000042.',
    );
  });

  it('item-level rules: no location unless the count recorded one', () => {
    expect(escalationPrefill(input('over_reserved')).description).toBe(
      'Promised more than is owned: 12 promised, 10 on hand. Ref EX-000042.',
    );
    expect(escalationPrefill(input('label_mismatch')).description).toBe(
      'Label will not lead to the stock: labelled 40-C, stock is on 39-C. Ref EX-000042.',
    );
    expect(escalationPrefill(input('count_variance')).description).toBe(
      'Count did not match the stock on record: found +2: counted 12, on record 10 (CC-000031). Location: 12-B. Ref EX-000042.',
    );
  });

  it('the live location name wins over the stored one', () => {
    expect(escalationPrefill(input('stale_staging', { locationName: 'Receiving dock' })).description).toContain(
      'Location: Receiving dock.',
    );
  });

  it('no SKU: the subject has no empty brackets; no reference: no "Ref"', () => {
    const p = escalationPrefill(input('label_mismatch', { sku: null, facts: { ...FACTS.label_mismatch, sku: null }, reference: null }));
    expect(p.subject).toBe('Inventory issue: Chromebook charger');
    expect(p.description).not.toContain('Ref');
    expect(p.description).not.toContain('()');
  });

  it('falls back to the stored name and SKU when the item is unreadable', () => {
    const p = escalationPrefill(input('label_mismatch', { itemName: null, sku: null }));
    expect(p.subject).toBe('Inventory issue: Chromebook charger (CB-65)');
  });

  it('no person, no cost, no link, and the item name only in the subject', () => {
    for (const rule of EXCEPTION_RULE_IDS) {
      const p = escalationPrefill(input(rule, { itemName: 'Zyxwv Unique Item' }));
      expect(p.description).not.toContain('Zyxwv');
      expect(`${p.subject} ${p.description}`).not.toMatch(/https?:|www\.|\$|\bcost\b|\bprice\b|\bvalue\b/i);
    }
  });
});

describe('escalationPrefill: the bounds the request form enforces', () => {
  const NASTY_NAMES = [
    'A'.repeat(500),
    'Line one\nLine two\r\nLine three',
    `Tabs${String.fromCharCode(9)}and${String.fromCharCode(0)}nulls${String.fromCharCode(7)}bells`,
    '🔋'.repeat(200),
    '   ',
    '',
    `${'x'.repeat(118)}🔋🔋🔋`,
  ];
  const NASTY_SKUS = [null, 'S', 'SKU-'.repeat(60), 'a\nb', '🔋'.repeat(80)];

  it('the subject is 5 to 120 characters, one line, and the form accepts it, for every name and SKU', () => {
    for (const name of NASTY_NAMES) {
      for (const sku of NASTY_SKUS) {
        const subject = escalationSubject(name, sku);
        expect(subject.length).toBeGreaterThanOrEqual(ESCALATION_SUBJECT_MIN);
        expect(subject.length).toBeLessThanOrEqual(ESCALATION_SUBJECT_MAX);
        expect(subject).not.toMatch(/[\r\n]/);
        // Never half a surrogate pair.
        expect(subject).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(formAccepts({ subject, description: 'A long enough description.', category: 'Other' })).toBe(true);
      }
    }
  });

  it('a long name is shortened before a short SKU, so the SKU survives', () => {
    const subject = escalationSubject('Very long item name '.repeat(20), 'CB-65');
    expect(subject.length).toBeLessThanOrEqual(ESCALATION_SUBJECT_MAX);
    expect(subject.endsWith('… (CB-65)')).toBe(true);
    expect(subject.startsWith('Inventory issue: Very long item name')).toBe(true);
  });

  it('exactly 120 is kept whole; 121 is shortened', () => {
    const prefix = 'Inventory issue: ';
    const exact = 'n'.repeat(ESCALATION_SUBJECT_MAX - prefix.length);
    expect(escalationSubject(exact, null)).toBe(`${prefix}${exact}`);
    expect(escalationSubject(`${exact}n`, null).length).toBe(ESCALATION_SUBJECT_MAX);
    expect(escalationSubject(`${exact}n`, null).endsWith('…')).toBe(true);
  });

  it('the description is 10 to 400 characters and the form accepts the whole prefill, for every rule and odd facts', () => {
    const oddFacts: unknown[] = [
      {},
      null,
      'not an object',
      { label: 'L'.repeat(100), stockOn: Array.from({ length: 10 }, (_, i) => `${'R'.repeat(99)}${i}`), stockOnMore: 40 },
      { units: 1e9, locationName: 'Z'.repeat(300) },
      { expected: 0.0001, counted: 999999.9999, countNumber: 1, countedLocationName: `${'C'.repeat(300)}\n\nx` },
    ];
    for (const rule of EXCEPTION_RULE_IDS) {
      for (const facts of oddFacts) {
        for (const name of NASTY_NAMES) {
          const p = escalationPrefill(input(rule, { facts, itemName: name, locationName: rule === 'long_unplaced' ? 'Q'.repeat(400) : null }));
          expect(p.description.length).toBeGreaterThanOrEqual(ESCALATION_DESCRIPTION_MIN);
          expect(p.description.length).toBeLessThanOrEqual(ESCALATION_DESCRIPTION_PREFILL_MAX);
          expect(formAccepts(p)).toBe(true);
        }
      }
    }
  });

  it('the reference survives even the longest detail and location (the short part is never cut off)', () => {
    const p = escalationPrefill(
      input('label_mismatch', {
        facts: { label: 'L'.repeat(100), stockOn: Array.from({ length: 10 }, () => 'R'.repeat(100)), stockOnMore: 9 },
      }),
    );
    expect(p.description.endsWith('Ref EX-000042.')).toBe(true);
  });
});

describe('the escalation wording (web and phone): honest about what StockPilot records', () => {
  /** Words that would claim something StockPilot cannot observe. */
  const DISHONEST = /\bsent\b|\bsend\b|\bsending\b|ticket|notif|\bemailed\b|\bdelivered\b|\bsubmitted\b|\breceived\b/i;
  /** The recorded quantity is "stock on record", never "book". */
  const BOOK = /\bbooks?\b/i;

  /** Every sentence the module can produce, over the inputs that matter. */
  function everySentence(): string[] {
    const out: string[] = [];
    for (const [name, value] of Object.entries(escalation)) {
      if (typeof value === 'string') out.push(`${name}: ${value}`);
    }
    for (const ref of ['MR-2026-000014', null, '']) {
      out.push(escalationBadgeCopy(ref), escalationDuplicateCopy(ref), escalationAlreadyEscalatedCopy(ref));
      for (const reason of ['module_disabled', 'not_permitted', 'resolved', 'already_escalated', null] as const) {
        for (const online of [true, false]) {
          const s = escalateDisabledReason({ reason, reference: ref, online });
          if (s) out.push(s);
        }
      }
    }
    for (const request of [null, { draftOpened: true, cancelled: false }, { draftOpened: false, cancelled: false }, { draftOpened: true, cancelled: true }]) {
      const s = escalationRequestStateCopy(request);
      if (s) out.push(s);
    }
    for (const rule of EXCEPTION_RULE_IDS) {
      const p = escalationPrefill(input(rule));
      out.push(p.subject, p.description);
    }
    out.push(describeOccurrenceEvent({ kind: 'escalated', actorLabel: 'Pat Lee' }));
    out.push(describeOccurrenceEvent({ kind: 'escalated', actorLabel: null }));
    out.push(describeOccurrenceEvent({ kind: 'escalated', actorLabel: 'Pat Lee', maintenanceRequestReference: 'MR-2026-000014' }));
    return out;
  }

  it('the audit sees the whole module (guards the collection above)', () => {
    const all = everySentence();
    expect(all.length).toBeGreaterThan(40);
    expect(all.some((s) => s.includes('Escalated: MR-2026-000014'))).toBe(true);
    expect(all.some((s) => s.startsWith('ESCALATE_TO_MAINTENANCE_HELP'))).toBe(true);
  });

  it('never "sent", "ticket", "notified", "emailed", "delivered", "submitted" or "received"', () => {
    const offenders = everySentence().filter((s) => DISHONEST.test(s));
    expect(offenders).toEqual([]);
  });

  it('never "book" for the recorded quantity', () => {
    expect(everySentence().filter((s) => BOOK.test(s))).toEqual([]);
  });

  it('the badge says Escalated with the MR handle, and nothing about acknowledging or resolving', () => {
    expect(escalationBadgeCopy('MR-2026-000014')).toBe('Escalated: MR-2026-000014');
    expect(escalationBadgeCopy(null)).toBe('Escalated to maintenance');
    expect(escalationBadgeCopy('MR-2026-000014')).not.toMatch(/acknowledg|resolv/i);
  });

  it('the request line: only what StockPilot records, and nothing for a reader who cannot open the request', () => {
    expect(escalationRequestStateCopy(null)).toBeNull();
    expect(escalationRequestStateCopy({ draftOpened: true, cancelled: false })).toBe('Email draft opened');
    expect(escalationRequestStateCopy({ draftOpened: false, cancelled: false })).toBe('Email draft not yet opened');
    expect(escalationRequestStateCopy({ draftOpened: true, cancelled: true })).toBe('Request cancelled');
  });

  it('the help says escalating neither acknowledges nor resolves, and that the email opens only by choice', () => {
    expect(escalation.ESCALATE_TO_MAINTENANCE_HELP).toContain('does not acknowledge or resolve');
    expect(escalation.ESCALATE_TO_MAINTENANCE_HELP).toContain('opens only if you choose it');
  });

  it('why Escalate is unavailable: reasons reconnecting would not change come before offline', () => {
    expect(escalateDisabledReason({ reason: 'module_disabled', online: false })).toBe(ESCALATE_MODULE_OFF_COPY);
    expect(escalateDisabledReason({ reason: 'not_permitted', online: false })).toBe(ESCALATE_NOT_PERMITTED_COPY);
    expect(escalateDisabledReason({ reason: 'resolved', online: false })).toBe(ESCALATE_RESOLVED_COPY);
    expect(escalateDisabledReason({ reason: 'already_escalated', reference: 'MR-2026-000014', online: false })).toBe(
      'Already escalated to MR-2026-000014. A new request can be made only if that one is cancelled.',
    );
    expect(escalateDisabledReason({ reason: null, online: false })).toBe(ESCALATE_OFFLINE_COPY);
    expect(escalateDisabledReason({ reason: null, online: true })).toBeNull();
  });

  it('offline copy says nothing is saved to try later (online only, never queued)', () => {
    expect(ESCALATE_OFFLINE_COPY).toContain('not saved to try later');
  });
});

describe('the escalated timeline event', () => {
  it('names the request when the reader knows it, and the person', () => {
    expect(
      describeOccurrenceEvent({ kind: 'escalated', actorLabel: 'Pat Lee', maintenanceRequestReference: 'MR-2026-000014' }),
    ).toBe('Escalated to maintenance request MR-2026-000014 by Pat Lee');
    expect(describeOccurrenceEvent({ kind: 'escalated', actorLabel: 'Pat Lee' })).toBe(
      'Escalated to a maintenance request by Pat Lee',
    );
  });
});
