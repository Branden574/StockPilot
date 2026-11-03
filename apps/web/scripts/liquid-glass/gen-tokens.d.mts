// Types for gen-tokens.mjs, read by the vitest guards in src/styles/liquid-glass.
export declare const ROOT: string;
export declare const ROOT_DARK: string;
export declare const ROOT_REDUCED: string;
export declare const ROOT_REDUCED_DARK: string;
export declare const EXEMPT: string;
export declare const SCENE_IMAGE: string;
export declare const OUTPUT_PATH: string;
export declare const TRIPLETS: Record<string, string | { light: string; dark: string }>;
export declare const COLOUR_PROPERTIES: Record<string, string>;
export declare const EDITORIAL: Record<string, string>;
export declare function parseColour(value: string): [number, number, number, number] | null;
export declare function over(
  top: [number, number, number, number],
  ground: [number, number, number, number],
): [number, number, number, number];
export declare function toTriplet(
  rgb: [number, number, number, number] | [number, number, number],
): string;
export declare function readClassicTokens(globalsCss: string): {
  light: Map<string, string>;
  dark: Map<string, string>;
  formulas: Map<string, string>;
};
export declare function generateTokensCss(
  source: unknown,
  options?: { globalsCss?: string },
): string;
export declare function readSource(): unknown;
