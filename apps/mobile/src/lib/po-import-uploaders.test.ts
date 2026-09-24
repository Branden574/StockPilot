import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { poImportUploaderLabel } from '@stockpilot/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakePostgrest, inValues, rowsServer, uuid } from './__fixtures__/fake-postgrest';
import { IN_FILTER_MAX_VALUES } from './id-batches';
import { readPoImportUploaders } from './po-import-uploaders';

/**
 * Who uploaded each PO import on the phone (web parity, owner request
 * 2026-09-24): the imports list row and the review screen say "by <name>" /
 * "Uploaded by <name>", labelled by the same core poImportUploaderLabel as the
 * web pages.
 */

const NAMES: Record<string, { full_name: string | null; email: string | null }> = {
  [uuid(1)]: { full_name: 'Marissa Lopez', email: 'marissa@cvwest.org' },
  [uuid(2)]: { full_name: null, email: 'crystal@cvwest.org' },
};

/** A user_profiles "server" that returns the NAMES rows asked for. */
const profilesServer = () =>
  rowsServer((call) =>
    (inValues(call, 'id') ?? [])
      .map((id) => String(id))
      .filter((id) => NAMES[id])
      .map((id) => ({ id, ...NAMES[id] })),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readPoImportUploaders', () => {
  it('reads name and email from user_profiles; labels are name, email, then "Former member"', async () => {
    const client = fakePostgrest(profilesServer());
    const profiles = await readPoImportUploaders(client, [uuid(1), uuid(2), uuid(3), uuid(1)]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.table).toBe('user_profiles');
    expect(client.calls[0]!.select).toBe('id, full_name, email');
    expect(poImportUploaderLabel(profiles, uuid(1))).toBe('Marissa Lopez');
    expect(poImportUploaderLabel(profiles, uuid(2))).toBe('crystal@cvwest.org');
    expect(poImportUploaderLabel(profiles, uuid(3))).toBe('Former member');
  });

  it('batches a full list page of uploaders into lookups of at most 100 ids', async () => {
    const client = fakePostgrest(
      rowsServer((call) =>
        (inValues(call, 'id') ?? []).map((id) => ({ id, full_name: 'Someone', email: null })),
      ),
    );
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i));
    const profiles = await readPoImportUploaders(client, ids);
    expect(client.calls).toHaveLength(3);
    for (const c of client.calls) {
      expect(inValues(c, 'id')!.length).toBeLessThanOrEqual(IN_FILTER_MAX_VALUES);
    }
    expect(profiles?.size).toBe(250);
  });

  it('answers null and warns when the read fails, so every label is "—", never "Former member"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = fakePostgrest(() => ({
      data: null,
      error: { message: 'fetch failed' },
      status: 0,
    }));
    const profiles = await readPoImportUploaders(client, [uuid(1), uuid(2)]);
    expect(profiles).toBeNull();
    expect(poImportUploaderLabel(profiles, uuid(1))).toBe('—');
    expect(warn).toHaveBeenCalledWith('[po-imports] uploader names did not load', 'fetch failed');
  });

  it('makes no request when there is nobody to look up', async () => {
    const client = fakePostgrest(profilesServer());
    expect(await readPoImportUploaders(client, [null, undefined])).toEqual(new Map());
    expect(client.calls).toHaveLength(0);
  });
});

/**
 * WIRING PINS. Both screens import native modules, so vitest cannot render
 * them; these keep them on the batched reader and the shared label.
 */
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
const listScreen = read('../screens/po-imports.tsx');
const reviewScreen = read('../../app/po-import/[id].tsx');

describe('imports list: who uploaded each row', () => {
  it('reads uploaded_by and looks the names up through readPoImportUploaders', () => {
    expect(listScreen).toMatch(/approved_po_id, created_at, uploaded_by,/);
    expect(listScreen).toContain('const uploaders = await readPoImportUploaders(');
    expect(listScreen).not.toContain(".from('user_profiles')");
  });

  it('labels each row with poImportUploaderLabel and shows it on the date line', () => {
    expect(listScreen).toContain(
      'uploader: poImportUploaderLabel(uploaders, (r.uploaded_by as string | null) ?? null),',
    );
    expect(listScreen).toContain('{` · by ${row.uploader}`}');
  });
});

describe('import review: who uploaded it', () => {
  it('reads uploaded_by and looks the name up beside the lineage', () => {
    expect(reviewScreen).toMatch(/created_at, parsed_json, uploaded_by,/);
    expect(reviewScreen).toMatch(
      /const \[uploaders\] = await Promise\.all\(\[\s*readPoImportUploaders\(supabase, \[uploaderId\]\),\s*loadLineage\(/,
    );
    expect(reviewScreen).toContain('setUploadedBy(poImportUploaderLabel(uploaders, uploaderId));');
    expect(reviewScreen).not.toContain(".from('user_profiles')");
  });

  it('says "Uploaded by <name>" in the header card', () => {
    expect(reviewScreen).toContain('Uploaded by {uploadedBy}');
  });
});
