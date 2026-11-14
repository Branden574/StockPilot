import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODULE_REGISTRY,
  PERMISSIONS,
  releaseSchema,
  type ModuleId,
  type Release,
  type ReleaseViewer,
} from '@stockpilot/core';

import { visibleReleases } from './logic';
import { RELEASES } from './registry';

/**
 * Added by docs/whats-new-2026-11-13 (2026-11-13): the AI Assistant release
 * (#509), published at the top, below the Release count release and above the
 * not found release. These tests pin its id, place, date, who each entry
 * reaches, and the code its words rest on.
 */
const ID = 'ai-assistant-plain-words-2026-11';
const SENTENCES = 'ai-assistant-plain-failure-sentences';
const REFUSED = 'ai-assistant-says-why-refused';
const release = () => RELEASES.find((r) => r.id === ID)!;
const entry = (id: string) => release().entries.find((e) => e.id === id)!;

const viewer = (
  role: ReleaseViewer['role'],
  permissions: ReleaseViewer['permissions'],
  enabledModules: ReleaseViewer['enabledModules'],
): ReleaseViewer => ({ role, permissions, enabledModules });
const owner = viewer('owner', [...PERMISSIONS], Object.keys(MODULE_REGISTRY) as ModuleId[]);
const told = (v: ReleaseViewer) =>
  visibleReleases(RELEASES, v)
    .find((r) => r.id === ID)
    ?.entries.map((e) => e.id);

/** A source file under apps/web/src, as written. */
const web = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');

function readerText(r: Release): string[] {
  return [
    r.title,
    r.summary,
    ...r.entries.flatMap((e) => [
      e.title,
      e.area ?? '',
      e.whatChanged,
      e.whyItMatters,
      e.howItAffectsYou,
      e.whatToDo,
      e.link?.label ?? '',
    ]),
  ];
}

describe('the AI Assistant release', () => {
  it('is published once, as revision 1, directly below the Release count release, on a whole minute after #509 went live', () => {
    expect(RELEASES.filter((r) => r.id === ID)).toHaveLength(1);
    expect(release().status).toBe('published');
    expect(release().revision).toBe(1);
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(RELEASES[5]?.id).toBe('cycle-count-already-released-2026-11');
    expect(RELEASES[6]?.id).toBe(ID);
    expect(RELEASES[7]?.id).toBe('changes-that-did-not-happen-2026-11');
    // #509 went live at 07:07:42Z.
    expect(release().publishedAt).toBe('2026-11-13T07:08:00Z');
    // Re-pinned by docs/whatsnew-emailed-links-1113 (2026-11-13; was: every pinned position one place higher): the emailed links release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    // Re-pinned by docs/whatsnew-phone-code-and-access-check (2026-11-13; was: every pinned position two places higher): the phone authenticator code and access check releases are published at the top, below the Liquid Glass draft, so every position below them moves down by two.
    // Re-pinned by docs/whats-new-phone-screens-by-access (2026-11-14; was: every pinned position one place higher): the phone screens by access release is published at the top, below the Liquid Glass draft, so every position below it moves down by one.
    expect(Date.parse(release().publishedAt)).toBeLessThan(Date.parse(RELEASES[5]!.publishedAt));
    expect(Date.parse(release().publishedAt)).toBeGreaterThan(Date.parse(RELEASES[7]!.publishedAt));
  });

  it('parses under the shared schema, with two AI Assistant entries in plain text only', () => {
    expect(releaseSchema.safeParse(release()).success).toBe(true);
    expect(release().entries.map((e) => [e.id, e.category, e.area])).toEqual([
      [SENTENCES, 'fixed', 'AI Assistant'],
      [REFUSED, 'fixed', 'AI Assistant'],
    ]);
    for (const text of readerText(release())) expect(text).not.toMatch(/[<>]/);
  });

  it('reaches who can open the AI Assistant, and nobody else', () => {
    for (const id of [SENTENCES, REFUSED]) {
      expect(entry(id).audience, id).toEqual({ anyPermission: ['items:update'], modules: ['ai'] });
    }
    for (const e of release().entries) {
      expect(e.link, e.id).toEqual({ href: '/dashboard/ai', label: 'Open AI Assistant' });
    }
    expect(told(owner)).toEqual([SENTENCES, REFUSED]);
    expect(told(viewer('admin', ['items:update'], ['ai']))).toEqual([SENTENCES, REFUSED]);
    expect(told(viewer('staff', ['items:update'], ['ai']))).toEqual([SENTENCES, REFUSED]);
    expect(told(viewer('admin', ['items:update'], []))).toBeUndefined();
    expect(told(viewer('staff', ['items:read'], ['ai']))).toBeUndefined();
  });

  it('does not say the assistant searches by name, SKU or barcode by itself', () => {
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/SKU|barcode|instead/i);
    }
    expect(entry(SENTENCES).whatChanged).toContain(
      'it says why in one sentence (not set up, not available right now, or could not finish)',
    );
  });

  it('carries no entry about filling in search data, and no field names the authenticator', () => {
    expect(release().entries.some((e) => e.id === 'ai-assistant-search-data-multi-factor')).toBe(
      false,
    );
    for (const text of readerText(release())) {
      expect(text).not.toMatch(/authenticator|re-authenticate/i);
    }
  });

  it('rests on the fixed sentences and the classifier', () => {
    const toolErrors = web('lib/ai/tool-errors.ts');
    expect(toolErrors).toContain(
      "export type ToolFailureKind = 'not_set_up' | 'unavailable' | 'failed';",
    );
    for (const tool of ['searchInventorySemantic', 'backfillEmbeddings', 'identifyFromPhoto']) {
      expect(toolErrors).toContain(`  ${tool}: {`);
    }
    const chat = web('lib/ai/chat.ts');
    expect(chat).toContain(
      "export const TOOL_PERMISSION_MESSAGE = 'You do not have permission to run that action.';",
    );
    expect(chat).toContain("export const TOOL_NOT_FOUND_MESSAGE = 'That record was not found.';");
    expect(chat).toContain(
      "aal2_required: 'Re-authenticate with MFA before performing this action.',",
    );
    expect(chat).toContain('if (err instanceof UntrustedWriteRefusedError) {');
    expect(web('server/services/inventory.ts')).toContain(
      "throw new ServiceError('validation_error', 'Insufficient stock for this adjustment');",
    );
  });
});
