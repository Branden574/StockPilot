// apps/web/src/components/team/remove-member-copy.test.ts
//
// B94: the Remove dialog says, before the press, how many cycle counts in
// progress, orders being picked and open deliveries removing the person
// releases (migration 0429 releases them in the same transaction as the
// removal). Maintenance requests and warehouses are named only when there
// are any; escalation claims (two-minute leases) and schedule events (they
// follow the deliveries) are never named.
import { describe, expect, it } from 'vitest';

import { openWorkLines, REMOVE_MEMBER_COPY, removeDialogText } from './remove-member-copy';

const none = {
  cycleCounts: 0,
  picks: 0,
  deliveries: 0,
  scheduleEvents: 0,
  maintenanceRequests: 0,
  escalationClaims: 0,
  warehouses: 0,
};

describe('openWorkLines (the Remove dialog)', () => {
  it('names counts, picks and deliveries, one each, in the singular', () => {
    expect(
      openWorkLines({ ...none, cycleCounts: 1, picks: 1, deliveries: 1 }, 'Warehouse'),
    ).toEqual([
      'Removing them releases 1 cycle count in progress, 1 order being picked and 1 open delivery, so others can take them over.',
    ]);
  });

  it('names them in the plural, and says 0 for a kind they have none of', () => {
    expect(
      openWorkLines({ ...none, cycleCounts: 2, picks: 0, deliveries: 3 }, 'Warehouse'),
    ).toEqual([
      'Removing them releases 2 cycle counts in progress, 0 orders being picked and 3 open deliveries, so others can take them over.',
    ]);
  });

  it('names a driver who holds only deliveries (never "nothing to release")', () => {
    expect(openWorkLines({ ...none, deliveries: 1 }, 'Warehouse')).toEqual([
      'Removing them releases 0 cycle counts in progress, 0 orders being picked and 1 open delivery, so others can take them over.',
    ]);
  });

  it('says there is nothing to release when they hold no count, pick or delivery', () => {
    expect(openWorkLines(none, 'Warehouse')).toEqual([
      'They have no cycle counts in progress, orders being picked or open deliveries to release.',
    ]);
  });

  it('never names escalation claims or schedule events', () => {
    const lines = openWorkLines({ ...none, scheduleEvents: 4, escalationClaims: 2 }, 'Warehouse');
    expect(lines).toEqual([
      'They have no cycle counts in progress, orders being picked or open deliveries to release.',
    ]);
    expect(lines.join(' ')).not.toMatch(/schedule|escalation|claim|event/i);
  });

  it("adds one line for maintenance requests and warehouses only when there are any, in the workspace's word for a warehouse", () => {
    expect(openWorkLines({ ...none, picks: 1, maintenanceRequests: 1 }, 'Warehouse')[1]).toBe(
      'It also clears them as the local owner of 1 maintenance request.',
    );
    expect(openWorkLines({ ...none, warehouses: 2 }, 'Site')[1]).toBe(
      'It also clears them as the manager of 2 sites.',
    );
    expect(openWorkLines({ ...none, maintenanceRequests: 3, warehouses: 1 }, 'Warehouse')[1]).toBe(
      'It also clears them as the local owner of 3 maintenance requests and as the manager of 1 warehouse.',
    );
    expect(openWorkLines({ ...none, cycleCounts: 1 }, 'Warehouse')).toHaveLength(1);
  });
});

describe('REMOVE_MEMBER_COPY', () => {
  it('no longer promises a re-invite gives the work back', () => {
    expect(REMOVE_MEMBER_COPY.description('Sam Staff')).toBe(
      'Sam Staff will lose access to this workspace immediately. Their activity history stays on the record. You can re-invite them later. Work released now stays released.',
    );
    expect(REMOVE_MEMBER_COPY.description('Sam Staff')).not.toMatch(/anytime/);
  });

  it('has the loading, could-not-check and refusal lines', () => {
    expect(REMOVE_MEMBER_COPY.checking).toBe('Checking their open work...');
    expect(REMOVE_MEMBER_COPY.failed).toBe(
      'Could not check their open work. Removing them still releases it.',
    );
    expect(REMOVE_MEMBER_COPY.forbidden).toBe('Only an owner or admin can remove a member.');
  });
});

// The dialog's whole text for each state of the read. "Work released now
// stays released." and "Removing them still releases it." are said only once
// the read shows the release exists: not while it is checking, and not when
// the read function is missing (before migration 0429 is pushed, or after a
// rollback that drops it together with the release trigger), when removing
// releases nothing.
describe('removeDialogText (the Remove dialog, per state of the read)', () => {
  const WITHOUT_RELEASE =
    'Sam Staff will lose access to this workspace immediately. Their activity history stays on the record. You can re-invite them later.';
  const WITH_RELEASE = `${WITHOUT_RELEASE} Work released now stays released.`;

  it('makes no claim about releasing while it checks', () => {
    expect(removeDialogText({ kind: 'loading' }, 'Sam Staff', 'Warehouse')).toEqual({
      description: WITHOUT_RELEASE,
      lines: ['Checking their open work...'],
    });
  });

  it('makes no claim about releasing when the read function is missing (nothing is released then)', () => {
    const text = removeDialogText({ kind: 'unavailable' }, 'Sam Staff', 'Warehouse');
    expect(text).toEqual({ description: WITHOUT_RELEASE, lines: [] });
    expect([text.description, ...text.lines].join(' ')).not.toMatch(/releas/i);
  });

  it('says what it releases when the read answers', () => {
    expect(
      removeDialogText(
        { kind: 'ok', counts: { ...none, cycleCounts: 1, picks: 2, deliveries: 1 } },
        'Sam Staff',
        'Warehouse',
      ),
    ).toEqual({
      description: WITH_RELEASE,
      lines: [
        'Removing them releases 1 cycle count in progress, 2 orders being picked and 1 open delivery, so others can take them over.',
      ],
    });
  });

  it('says it could not check, and that removing still releases the work, when the read failed', () => {
    expect(removeDialogText({ kind: 'failed' }, 'Sam Staff', 'Warehouse')).toEqual({
      description: WITH_RELEASE,
      lines: ['Could not check their open work. Removing them still releases it.'],
    });
  });

  it('says who may remove when the read is refused', () => {
    expect(removeDialogText({ kind: 'forbidden' }, 'Sam Staff', 'Warehouse')).toEqual({
      description: WITH_RELEASE,
      lines: ['Only an owner or admin can remove a member.'],
    });
  });
});
