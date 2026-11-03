// Types for gen-tokens.mjs, read by the vitest guards in src/styles/liquid-glass.
export declare const ROOT: string;
export declare const ROOT_DARK: string;
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
export declare function generateTokensCss(
  source: unknown,
  options?: { sceneFiles?: string[] },
): string;
export declare function readSource(): unknown;
export declare function presentSceneFiles(): string[];
