/**
 * The identity of THE BUNDLE THIS CODE WAS COMPILED INTO. See "Build identity"
 * in next.config.ts for why it is baked in at build time and why it is a hash.
 *
 * The accesses below are LITERAL on purpose: Next only inlines
 * `process.env.NEXT_PUBLIC_*` when it sees the full property access in source.
 * A destructure or a computed key would read the runtime environment instead,
 * which is exactly the lie this file exists to avoid.
 *
 * Both are '' outside a Vercel build (local dev, tests), and an empty build
 * means "unknown": the update detector stays silent rather than guessing.
 */
export const LOADED_BUILD: string = process.env.NEXT_PUBLIC_SP_BUILD ?? '';
export const LOADED_BUILT_AT: string = process.env.NEXT_PUBLIC_SP_BUILT_AT ?? '';
