import { describe, expect, it } from 'vitest';

import { changeEmailSchema } from './auth';

describe('changeEmailSchema', () => {
  it('trims and lowercases a valid address, and keeps plus-addressing and dots', () => {
    const r = changeEmailSchema.safeParse({
      newEmail: '  First.Last+ops@Example.COM ',
      currentPassword: 'x',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.newEmail).toBe('first.last+ops@example.com');
  });

  it('rejects a malformed address, a blank one, and an overlong one', () => {
    for (const bad of ['not-an-email', '', '   ', `${'a'.repeat(250)}@x.io`]) {
      const r = changeEmailSchema.safeParse({ newEmail: bad, currentPassword: 'x' });
      expect(r.success, bad).toBe(false);
    }
  });

  it('requires the current password', () => {
    const r = changeEmailSchema.safeParse({ newEmail: 'a@b.io', currentPassword: '' });
    expect(r.success).toBe(false);
  });
});
