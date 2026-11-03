/**
 * The phone's Liquid Glass kill switch (plan D12, 5.5): EXPO_PUBLIC_LIQUID_GLASS,
 * inlined when the bundle (or the OTA) is built. Only '1' turns Liquid Glass on.
 *
 * With it off:
 *   - the Appearance screen does not offer Liquid Glass;
 *   - a stored 'liquid-glass' renders as classic System (core effectiveAppearance)
 *     and is KEPT, not rewritten, so turning the flag back on restores it;
 *   - nothing loads the glass module.
 *
 * Read through `process.env.EXPO_PUBLIC_LIQUID_GLASS` written out in full: Expo
 * inlines only that literal member access, never a computed one.
 */
export function isLiquidGlassEnabled(): boolean {
  return process.env.EXPO_PUBLIC_LIQUID_GLASS === '1';
}
