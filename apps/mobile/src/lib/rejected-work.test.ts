import { describe, expect, it } from 'vitest';

import {
  pendingActionLabel,
  REJECTED_KEEP_MAX,
  REJECTED_RETENTION_DAYS,
  REJECTED_RETENTION_MS,
  rejectedPruneCutoff,
  rejectedWhen,
} from './rejected-work';

/**
 * The vocabulary and the retention policy for TERMINALLY REJECTED offline work.
 *
 * A rejected row is a write the operator believed they had saved and which will
 * never be sent — today, only work that was queued when the account was
 * disabled. The branch kept those rows deliberately (wipeForSignOut spares
 * them) but nothing read them and nothing ever deleted them: invisible to the
 * operator, invisible to support, and accumulating for the life of the install
 * on a shared warehouse device.
 *
 * This module is the pure half of the fix — what a row is CALLED, when it is
 * old enough to drop, and how many are worth keeping. The SQL that applies it
 * lives in queue.ts and the surface that renders it in settings/rejected-work.
 */

const KINDS = [
  'adjust_stock',
  'receive_po_line',
  'record_count',
  'create_book',
  'distribute_bundle',
  'upload_image',
  'size_count_event',
] as const;

describe('pendingActionLabel', () => {
  it('names every queue kind in the operator’s own words', () => {
    for (const kind of KINDS) {
      const label = pendingActionLabel(kind);
      expect(label.length).toBeGreaterThan(0);
      // The raw column value is a developer word; a screen must never show it.
      expect(label).not.toContain('_');
    }
  });

  it('gives each kind a distinct label', () => {
    const labels = KINDS.map(pendingActionLabel);
    expect(new Set(labels).size).toBe(KINDS.length);
  });

  it('never renders blank for a kind added after this build', () => {
    // A row written by a newer OTA bundle must still be explainable.
    const label = pendingActionLabel('some_future_kind');
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toContain('_');
  });
});

describe('the retention policy', () => {
  it('keeps rejected work long enough to be investigated, not forever', () => {
    expect(REJECTED_RETENTION_DAYS).toBeGreaterThanOrEqual(14);
    expect(REJECTED_RETENTION_DAYS).toBeLessThanOrEqual(90);
    expect(REJECTED_RETENTION_MS).toBe(REJECTED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  });

  it('caps the number kept, so one bad eviction cannot fill the device', () => {
    expect(REJECTED_KEEP_MAX).toBeGreaterThan(0);
    expect(REJECTED_KEEP_MAX).toBeLessThanOrEqual(1_000);
  });

  it('prunes strictly by age, measured backwards from now', () => {
    const now = 1_800_000_000_000;
    expect(rejectedPruneCutoff(now)).toBe(now - REJECTED_RETENTION_MS);
    expect(rejectedPruneCutoff(now)).toBeLessThan(now);
  });

  it('never produces a cutoff in the future — a clock jump must not wipe the record', () => {
    expect(rejectedPruneCutoff(0)).toBeLessThanOrEqual(0);
  });
});

describe('rejectedWhen', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;

  it('reads as recency, not as a timestamp, for anything fresh', () => {
    expect(rejectedWhen(now, now)).toBe('Today');
    expect(rejectedWhen(now - DAY - 1, now)).toBe('Yesterday');
    expect(rejectedWhen(now - 3 * DAY, now)).toBe('3 days ago');
  });

  it('falls back to a plain date once "N days ago" stops meaning anything', () => {
    expect(rejectedWhen(now - 400 * DAY, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not claim the future when the device clock has moved backwards', () => {
    expect(rejectedWhen(now + 5 * DAY, now)).toBe('Today');
  });
});
