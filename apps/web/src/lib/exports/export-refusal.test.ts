import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PERMISSION_META } from '@stockpilot/core';

import {
  EXPORT_FORBIDDEN_COPY,
  EXPORT_SESSION_ENDED_COPY,
  ExportRefusedError,
  isExportRefused,
} from './export-refusal';

/**
 * B68: what an export refused for good says. Members without items:export saw
 * "Could not load a sample of this export. You can still export the file."
 * with a Try again that failed again, then the bare code "forbidden"; an ended
 * session showed "unauthenticated". These are the words instead.
 */
describe('the export refusal sentences (B68)', () => {
  it('a member without the permission is told which one to ask an admin for', () => {
    expect(EXPORT_FORBIDDEN_COPY).toBe(
      'You do not have permission to export. Ask an admin for the Export items permission.',
    );
    // Named as Settings > Roles & permissions names it, from the same label.
    expect(EXPORT_FORBIDDEN_COPY).toContain(
      `Ask an admin for the ${PERMISSION_META['items:export'].label} permission.`,
    );
  });

  it("an ended session reads as the app's own sentence for it", () => {
    expect(EXPORT_SESSION_ENDED_COPY).toBe(
      'Your session has ended. Refresh the page to sign in again.',
    );
    // The component picker's 401 line (bundle-component-picker.tsx), word for word.
    const picker = readFileSync(
      resolve(__dirname, '../../components/bundles/bundle-component-picker.tsx'),
      'utf8',
    );
    expect(picker).toContain(`if (status === 401) return '${EXPORT_SESSION_ENDED_COPY}';`);
  });

  it('ExportRefusedError carries the sentence to show, and only it counts as a refusal', () => {
    const refused = new ExportRefusedError(EXPORT_FORBIDDEN_COPY);
    expect(refused).toBeInstanceOf(Error);
    expect(refused.name).toBe('ExportRefusedError');
    expect(refused.message).toBe(EXPORT_FORBIDDEN_COPY);
    expect(isExportRefused(refused)).toBe(true);

    expect(isExportRefused(new Error(EXPORT_FORBIDDEN_COPY))).toBe(false);
    expect(isExportRefused('forbidden')).toBe(false);
    expect(isExportRefused(null)).toBe(false);
    expect(isExportRefused(undefined)).toBe(false);
  });
});
