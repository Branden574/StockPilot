/**
 * Industry pack PRESETS — the friendly, investor-facing catalog behind the
 * one-click "set up as this industry" template apply (Phase 3 T3).
 *
 * Each preset is PURE metadata: a stable `id` (the DomainPack token), a
 * human label, a one-line blurb, and optional terminology defaults that the
 * apply action merges over the org's existing terminology WITHOUT clobbering
 * any value the org already customized.
 *
 * The actual module SET turned on for a pack still comes from the registry's
 * `modulesForPack(pack)` (a pack's `defaultOnFor` membership) — presets never
 * re-declare which modules belong to a pack, so the two can never drift.
 *
 * Pure types + a pure lookup — no React, no platform imports — so the admin
 * UI, the server action, and tests all read the same catalog.
 */

import type { OrgTerminology } from '../constants/terminology';
import { type DomainPack, modulesForPack } from './registry';

export interface PackPreset {
  /** The DomainPack token; also `organizations.domain_pack`. */
  id: DomainPack;
  /** Friendly, customer-facing label shown on the industry cards. */
  label: string;
  /** One-line description of what the pack sets up. */
  blurb: string;
  /**
   * Terminology defaults this pack suggests. MERGED over the org's existing
   * terminology by the apply action — only keys the org has NOT already
   * customized are filled in, so a preset never clobbers an org's labels.
   * Omitted/empty means "keep the platform default terminology".
   */
  terminology?: Partial<OrgTerminology>;
}

/**
 * The five shipped domain packs, in the order the admin UI lists them.
 * Labels deliberately use the customer-facing vertical name (e.g. "Apparel /
 * Retail backroom") rather than the internal token.
 */
export const PACK_PRESETS: Record<DomainPack, PackPreset> = {
  charter_school: {
    id: 'charter_school',
    label: 'Books / School',
    blurb:
      'Curriculum books, rentals, bundles, and the AI assistant — the full charter-school setup.',
    terminology: {
      charter_singular: 'Charter',
      charter_plural: 'Charters',
    },
  },
  distribution: {
    id: 'distribution',
    label: 'Distribution',
    blurb:
      'Orders, bundles, purchasing, receiving, and suppliers for a distribution warehouse.',
    terminology: {
      charter_singular: 'Account',
      charter_plural: 'Accounts',
    },
  },
  retail_backroom: {
    id: 'retail_backroom',
    label: 'Apparel / Retail',
    blurb:
      'Cycle counts and backroom stock control tuned for apparel and retail stores.',
    terminology: {
      charter_singular: 'Store',
      charter_plural: 'Stores',
      warehouse_singular: 'Backroom',
      warehouse_plural: 'Backrooms',
    },
  },
  agriculture_food: {
    id: 'agriculture_food',
    label: 'Food & Ag',
    blurb:
      'Lot & serial tracking, purchasing, and cycle counts for food and agriculture operations.',
    terminology: {
      charter_singular: 'Grower',
      charter_plural: 'Growers',
    },
  },
  light_3pl: {
    id: 'light_3pl',
    label: 'Light 3PL',
    blurb:
      'Multi-client orders, purchasing, and receiving for a light third-party logistics operation.',
    terminology: {
      charter_singular: 'Client',
      charter_plural: 'Clients',
    },
  },
};

/** The preset catalog as an ordered list for rendering. */
export const PACK_PRESET_LIST: readonly PackPreset[] = Object.values(PACK_PRESETS);

/** Look up the preset for a domain pack. Total over the DomainPack union. */
export function presetForPack(pack: DomainPack): PackPreset {
  return PACK_PRESETS[pack];
}

/**
 * Re-export of the registry-derived module set for a pack, so callers that
 * already have a preset don't need to import the registry separately. The
 * registry remains the single source of truth for pack membership.
 */
export function modulesForPreset(pack: DomainPack): ReturnType<typeof modulesForPack> {
  return modulesForPack(pack);
}
