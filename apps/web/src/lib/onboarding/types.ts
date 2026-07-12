import type { Role } from '@stockpilot/core';

/**
 * Tour registry types — the reusable infrastructure the owner PRD requires
 * (spec §16, docs/superpowers/specs/2026-07-11-onboarding-system-design.md).
 * Tours are DATA, not page code: pages mount <PageTour tourId=… /> and the
 * engine does the rest. Anchors are CSS selectors; steps whose target never
 * renders (missing module, no permission, responsive layout) are skipped, so
 * one definition serves many org configurations.
 */
export interface TourStep {
  /** CSS selector for the element to spotlight. Omit for a centered step. */
  target?: string;
  title: string;
  body: string;
  /** Card placement relative to target (default: auto by available space). */
  placement?: 'top' | 'bottom';
  /**
   * Skip silently when the target is absent (default true — dynamic data,
   * disabled modules, or missing permission must never break a tour).
   */
  optional?: boolean;
}

export interface TourDefinition {
  id: string;
  /** Bump when steps change materially — completion is per-version. */
  version: number;
  name: string;
  /** Roles allowed to see this tour. Empty/undefined = everyone. */
  roles?: Role[];
  steps: TourStep[];
}
