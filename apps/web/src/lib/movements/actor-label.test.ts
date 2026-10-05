import { describe, expect, it } from 'vitest';

import { movementActorLabel } from './actor-label';

/** The one movement-actor label (Movements page, recent-activity widget, AI tools). */
describe('movementActorLabel', () => {
  it('shows the full name, else the email', () => {
    expect(
      movementActorLabel({ user_id: 'u1', actor: { fullName: 'Marissa Lopez', email: 'm@x.org' } }),
    ).toBe('Marissa Lopez');
    expect(movementActorLabel({ user_id: 'u1', actor: { fullName: null, email: 'm@x.org' } })).toBe(
      'm@x.org',
    );
  });

  it('says "Unknown" for a user the reader cannot see', () => {
    expect(movementActorLabel({ user_id: 'u1', actor: null })).toBe('Unknown');
  });

  it('says "Deleted user" for a stamped row with no user (0393)', () => {
    expect(movementActorLabel({ user_id: null, actor: null, actorDeleted: true })).toBe(
      'Deleted user',
    );
  });

  it('says "System" for an unstamped row with no user, and for rows from builds that never read the marker', () => {
    expect(movementActorLabel({ user_id: null, actor: null, actorDeleted: false })).toBe('System');
    expect(movementActorLabel({ user_id: null, actor: null })).toBe('System');
  });

  it('never lets a stale flag override a named actor', () => {
    expect(
      movementActorLabel({
        user_id: 'u1',
        actor: { fullName: 'Doua', email: null },
        actorDeleted: true,
      }),
    ).toBe('Doua');
  });
});
