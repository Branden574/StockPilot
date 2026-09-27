/**
 * Location grouping: the ONE classifier (system / rack-shelf / site) now lives
 * in @stockpilot/core (inventory/location-groups.ts), so the words core writes
 * about a location use the same rule as the web's pickers and tabs. This module
 * re-exports it so every existing import keeps working.
 */
export {
  isRackShelfLocation,
  isSiteLocation,
  isSystemLocation,
  locationGroup,
  PLACEMENT_KINDS,
  PLACEMENT_TYPES,
  SYSTEM_KINDS,
  type LocationGroup,
  type LocationLike,
} from '@stockpilot/core';
