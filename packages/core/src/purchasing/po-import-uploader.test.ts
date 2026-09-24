import { describe, expect, it } from 'vitest';

import {
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

  it('never returns the raw id', () => {
    const id = '11111111-0000-4000-8000-000000000001';
    for (const m of [null, profiles({}), profiles({ [id]: { full_name: null, email: null } })]) {
      expect(poImportUploaderLabel(m, id)).not.toContain(id);
    }
  });
});
