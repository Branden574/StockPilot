import { parseRollout, type GlassRollout } from '@stockpilot/core';

/**
 * The phone's Liquid Glass kill switch (plan D12, 5.5; revision R5):
 * EXPO_PUBLIC_LIQUID_GLASS, inlined when the bundle (or the OTA) is built.
 *
 *   off      classic for everyone, exactly today's phone: the Settings row is
 *            the old "Theme / Auto" alert, the appearance layer reads and saves
 *            nothing, and every stored choice is kept (not shown, not rewritten),
 *            so turning the flag back on restores it;
 *   opt-in   classic unless the person chose Liquid Glass;
 *   default  Liquid Glass unless the person chose Classic.
 *
 * Anything else, unset, empty and the stage 2 value '1' included, is 'off'
 * (core parseRollout). Read through `process.env.EXPO_PUBLIC_LIQUID_GLASS`
 * written out in full: Expo inlines only that literal member access, never a
 * computed one.
 */
export function glassRollout(): GlassRollout {
  return parseRollout(process.env.EXPO_PUBLIC_LIQUID_GLASS);
}
