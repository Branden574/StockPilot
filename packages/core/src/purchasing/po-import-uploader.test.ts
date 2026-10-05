import { describe, expect, it } from 'vitest';

import {
  PO_IMPORT_UPLOADER_DELETED,
  PO_IMPORT_UPLOADER_FORMER_MEMBER,
  PO_IMPORT_UPLOADER_UNAVAILABLE,
  PO_IMPORT_UPLOADER_UNKNOWN,
  poImportUploaderLabel,
  type PoImportUploaderProfile,
} from './po-import-uploader';

/**
 * The one mapping from a user_profiles lookup to the "Uploaded by" label, run
 * by the web pages and the phone alike (see the module doc for why a missing
 * profile means a former member).
 */
const profiles = (entries: Record<string, PoImportUploaderProfile>) =>
  new Map(Object.entries(entries));

describe('poImportUploaderLabel', () => {
  it('shows the full name', () => {
    const m = profiles({ u1: { full_name: 'Marissa Lopez', email: 'marissa@cvwest.org' } });
    expect(poImportUploaderLabel(m, 'u1')).toBe('Marissa Lopez');
  });

  it('falls back to the email when there is no name, and when the name is blank', () => {
    const m = profiles({
      u1: { full_name: null, email: 'crystal@cvwest.org' },
      u2: { full_name: '   ', email: ' doua@cvwest.org ' },
    });
    expect(poImportUploaderLabel(m, 'u1')).toBe('crystal@cvwest.org');
    expect(poImportUploaderLabel(m, 'u2')).toBe('doua@cvwest.org');
  });

  it('says "Former member" when the lookup worked but no profile came back', () => {
    expect(poImportUploaderLabel(profiles({}), 'gone')).toBe(PO_IMPORT_UPLOADER_FORMER_MEMBER);
    expect(PO_IMPORT_UPLOADER_FORMER_MEMBER).toBe('Former member');
  });

  it('says "Unknown" for a profile with neither name nor email, or no uploader id', () => {
    const m = profiles({ u1: { full_name: null, email: null } });
    expect(poImportUploaderLabel(m, 'u1')).toBe(PO_IMPORT_UPLOADER_UNKNOWN);
    expect(poImportUploaderLabel(m, null)).toBe(PO_IMPORT_UPLOADER_UNKNOWN);
  });

  it('says "—" when the lookup failed, never "Former member" for everyone', () => {
    expect(poImportUploaderLabel(null, 'u1')).toBe(PO_IMPORT_UPLOADER_UNAVAILABLE);
    expect(PO_IMPORT_UPLOADER_UNAVAILABLE).toBe('—');
  });

  // 0394: an uploader who deleted their account leaves the import with
  // uploaded_by null and a deleted_users stamp for that column.
  it("says 'Deleted user' for a null uploader stamped in the row's deleted_users, before every other branch", () => {
    const marks = { uploaded_by: '2026-11-04T18:22:05+00:00' };
    expect(poImportUploaderLabel(profiles({}), null, marks)).toBe(PO_IMPORT_UPLOADER_DELETED);
    expect(poImportUploaderLabel(null, null, marks)).toBe('Deleted user');
    expect(PO_IMPORT_UPLOADER_DELETED).toBe('Deleted user');
  });

  it('ignores a stamp for another column, a malformed marker, and a marker on a row that still names someone', () => {
    const m = profiles({ u1: { full_name: 'Doua Vang', email: null } });
    expect(poImportUploaderLabel(m, null, { approved_by: '2026-11-04T18:22:05+00:00' })).toBe(PO_IMPORT_UPLOADER_UNKNOWN);
    expect(poImportUploaderLabel(m, null, ['uploaded_by'])).toBe(PO_IMPORT_UPLOADER_UNKNOWN);
    expect(poImportUploaderLabel(m, 'u1', { uploaded_by: '2026-11-04T18:22:05+00:00' })).toBe('Doua Vang');
  });

  it('never returns the raw id', () => {
    const id = '11111111-0000-4000-8000-000000000001';
    for (const m of [null, profiles({}), profiles({ [id]: { full_name: null, email: null } })]) {
      expect(poImportUploaderLabel(m, id)).not.toContain(id);
    }
  });
});
