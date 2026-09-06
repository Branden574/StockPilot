import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { POST_CYCLE_COUNT_ERROR_COPY, postCycleCountErrorMessage } from './cycle-count-post-errors';

/**
 * post_cycle_count v4 (migration 0339) added two fail-closed refusals. The
 * mobile screen posts through the RPC directly, so without this mapper the
 * alert showed the raw code. Pins: every code maps to the SAME sentence the
 * web service shows, and the screen is wired to the mapper.
 */
describe('postCycleCountErrorMessage — post_cycle_count raise codes (0079 + 0339)', () => {
  it('cycle_count_stale_line (0339) -> recount copy, identical to the web string', () => {
    expect(postCycleCountErrorMessage('cycle_count_stale_line')).toBe(
      'A line was counted before its stock changed and cannot be posted safely. Clear and recount that line, then post again.',
    );
  });

  it('cycle_count_negative_result (0339) -> recount copy, identical to the web string', () => {
    expect(postCycleCountErrorMessage('cycle_count_negative_result')).toBe(
      'Posting would take an item below zero because stock moved out after it was counted. Recount that line, then post again.',
    );
  });

  it('matches the code inside a PostgREST-wrapped message', () => {
    expect(postCycleCountErrorMessage('P0001: cycle_count_stale_line')).toContain(
      'Clear and recount that line',
    );
  });

  it('carries the 0079 codes too (not_found, not_open, forbidden, item_out_of_scope)', () => {
    expect(postCycleCountErrorMessage('cycle_count_not_found')).toBe('Cycle count not found.');
    expect(postCycleCountErrorMessage('cycle_count_not_open')).toContain('no longer open');
    expect(postCycleCountErrorMessage('forbidden')).toContain('permission');
    expect(postCycleCountErrorMessage('item_out_of_scope')).toContain(
      'moved to a different warehouse mid-count',
    );
  });

  it('unknown messages pass through; empty falls back to a generic sentence', () => {
    expect(postCycleCountErrorMessage('network request failed')).toBe('network request failed');
    expect(postCycleCountErrorMessage('')).toBe('Could not post the cycle count. Try again.');
    expect(postCycleCountErrorMessage(null)).toBe('Could not post the cycle count. Try again.');
  });

  it('web and mobile copy do not drift: every mobile string appears verbatim in the web service', () => {
    const web = readFileSync(
      path.resolve(__dirname, '../../../web/src/server/services/cycle-counts.ts'),
      'utf8',
    );
    for (const [, copy] of POST_CYCLE_COUNT_ERROR_COPY) {
      expect(web, `web service lacks: ${copy}`).toContain(copy);
    }
  });
});

describe('cycle-count/[id].tsx — post error wiring (0339)', () => {
  const screen = readFileSync(
    path.resolve(__dirname, '../../app/cycle-count/[id].tsx'),
    'utf8',
  );

  // SP-055 moved posting off `supabase.rpc('post_cycle_count')` and onto the
  // Bearer twin, so the failure now arrives as a thrown ApiError rather than an
  // `{ error }` envelope. The route already returns mapped copy; this mapper
  // stays as the FALLBACK for a raw code, and the pin follows the new call
  // shape — the property under test (never the raw message straight to the
  // alert) is unchanged.
  it('the post alert goes through the mapper, not the raw error message', () => {
    expect(screen).toContain("import { postCycleCountErrorMessage } from '@/lib/cycle-count-post-errors';");
    expect(screen).toContain(
      "postCycleCountErrorMessage(e instanceof Error ? e.message : null),",
    );
    expect(screen).not.toContain("Alert.alert('Could not post', error.message);");
    expect(screen).not.toContain("Alert.alert('Could not post', e.message);");
  });

  it('the list explains what Expected means under the 0339 rule', () => {
    expect(screen).toContain('Expected is the system quantity when the line was counted');
  });
});
