import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inviteExpiredDescription } from './invite-copy';

/**
 * A3 review 2026-10-05: an account deletion expires every pending invite the
 * person sent (0393), so the usual reader of "Invite expired" now has an
 * inviter who no longer exists. Point them at the organization instead.
 */
describe('inviteExpiredDescription', () => {
  it('asks someone at the organization when its name is known', () => {
    expect(inviteExpiredDescription('Learn4Life')).toBe('Ask someone at Learn4Life to invite you again.');
  });

  it('keeps the old sentence when the organization is unknown', () => {
    expect(inviteExpiredDescription(null)).toBe('Ask the inviter to send a new one.');
    expect(inviteExpiredDescription('   ')).toBe('Ask the inviter to send a new one.');
  });

  it('is what the invite page shows for an expired invite', () => {
    const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(page).toContain('<CardDescription>{inviteExpiredDescription(orgKnown ? orgName : null)}</CardDescription>');
    expect(page).not.toContain('<CardDescription>Ask the inviter to send a new one.</CardDescription>');
  });
});
