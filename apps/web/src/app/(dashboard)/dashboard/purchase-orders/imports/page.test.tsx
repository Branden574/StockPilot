import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Fast-follow fix wave (2026-08-06) — latent-sibling of the maintenance list's
 * Task 25 BUG 1 (see docs/superpowers/reports/2026-08-05-maintenance-requests-verification.md,
 * "Latent-sibling triage"). This page is a SERVER component rendering the
 * 'use client' Pagination; a function prop (`hrefForPage`) crashes any
 * non-empty render because RSC refuses to serialize functions (digest
 * 3969804129). It never surfaced here in normal use because the pager is
 * hidden under 30 imports — it fires once an org holds more than PAGE_SIZE
 * imports or anyone deep-links `?page=2`.
 *
 * This is a source-text pin (the repo's wiring-pin idiom, see
 * dashboard/maintenance/page.test.tsx's "RSC serialization guard" and
 * maintenance-onboarding.test.ts): it asserts the page never spells the
 * function-prop flavor and does wire the serializable basePath/baseParams
 * flavor.
 *
 * HONEST LIMITS: a source-text assertion proves what the file SAYS, not what
 * React does — RSC serialization is only truly proven by an authed browser
 * walk over a non-empty, over-30-row imports list (not exercised here; the
 * maintenance page's equivalent fix was re-verified that way in Task 25).
 */
describe('RSC serialization guard — the pager gets serializable props only (fast-follow, PO-imports sibling)', () => {
  const src = readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf8');

  it('never passes the function-prop flavor (hrefForPage=) from this server component', () => {
    expect(src).not.toMatch(/hrefForPage=/);
  });

  it('wires the pager via serializable basePath + baseParams matching the status/q query contract', () => {
    expect(src).toMatch(/basePath="\/dashboard\/purchase-orders\/imports"/);
    expect(src).toMatch(/baseParams=\{importsBaseParams\}/);
  });

  it('baseParams always carries the active tab (status) and only adds q when set — same contract as the tab links', () => {
    expect(src).toMatch(
      /const importsBaseParams: Record<string, string> = \{ status: tab \};\s*\n\s*if \(q\) importsBaseParams\.q = q;/,
    );
  });
});
