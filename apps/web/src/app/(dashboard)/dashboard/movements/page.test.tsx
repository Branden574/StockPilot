import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Fast-follow fix wave (2026-08-06) — latent-sibling of the maintenance list's
 * Task 25 BUG 1 (see docs/superpowers/reports/2026-08-05-maintenance-requests-verification.md,
 * "Latent-sibling triage"). This page is a SERVER component rendering the
 * 'use client' Pagination at TWO sites (the filter-bar row and the
 * below-table row); a function prop (`hrefForPage`) crashes any non-empty
 * server-mode render because RSC refuses to serialize functions (digest
 * 3969804129). It never surfaced here because movements defaults to
 * instant/client mode under MOVEMENTS_INSTANT_CAP — it fires only once an
 * org's unfiltered movement count exceeds the cap.
 *
 * This is a source-text pin (the repo's wiring-pin idiom, see
 * dashboard/maintenance/page.test.tsx's "RSC serialization guard" and
 * maintenance-onboarding.test.ts): it asserts the page never spells the
 * function-prop flavor and does wire the serializable basePath/baseParams
 * flavor at BOTH pager sites.
 *
 * HONEST LIMITS: a source-text assertion proves what the file SAYS, not what
 * React does — RSC serialization is only truly proven by an authed browser
 * walk over a non-empty, over-cap movements ledger (not exercised here; the
 * maintenance page's equivalent fix was re-verified that way in Task 25).
 */
describe('RSC serialization guard — the pager gets serializable props only (fast-follow, movements sibling)', () => {
  const src = readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf8');

  it('never passes the function-prop flavor (hrefForPage=) from this server component', () => {
    expect(src).not.toMatch(/hrefForPage=/);
  });

  it('wires both pager sites via serializable basePath + baseParams derived from the shared filter builder', () => {
    const basePathHits = src.match(/basePath="\/dashboard\/movements"/g) ?? [];
    const baseParamsHits = src.match(/baseParams=\{movementsBaseParams\}/g) ?? [];
    expect(basePathHits.length).toBe(2);
    expect(baseParamsHits.length).toBe(2);
  });

  it('derives baseParams from buildMovementsQueryString so the pager and the Export CSV link cannot drift', () => {
    expect(src).toMatch(
      /const movementsBaseParams = Object\.fromEntries\(\s*new URLSearchParams\(buildMovementsQueryString\(activeFilters\)\),?\s*\);/,
    );
  });
});
