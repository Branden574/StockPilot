// Types for generate-world.mjs, read by its tests in apps/web.
export type Position = readonly [lon: number, lat: number];
export type Ring = Position[];
export type Polygon = Ring[];
export interface OutlineFeature {
  code: string | null;
  polygons: Polygon[];
}
export interface LandBits {
  rows: number;
  cells: number;
  count: number;
  bytes: Uint8Array;
  /** One per land cell: 0 for none, else 1 + the place of its country's code in ownerCodes. */
  owners: Uint8Array;
  ownerCodes: string[];
}
export interface CountryPointsResult {
  points: Record<string, [number, number]>;
  fromFallback: string[];
  notInList: string[];
  withoutCode: number;
  how: Record<string, 'centre' | 'widest stretch' | 'fallback table'>;
}
export declare const REPO_ROOT: string;
export declare const OUTPUT_DIR: string;
export declare const OUTPUT_FILES: { worldDots: string; countryPoints: string };
export declare const OUTLINE_SHA256: string;
export declare const OUTLINE_SOURCE: string;
export declare const COMMAND: string;
export declare const DOT_STEP: number;
export declare const BUDGET_GZIP_BYTES: number;
export declare const ISO_3166_ALPHA2: readonly string[];
export declare const FALLBACK_POINTS: Readonly<Record<string, readonly [number, number]>>;
export declare const HAND_ONLY_CODES: readonly string[];
export declare function readOutline(text: string): OutlineFeature[];
export declare function countryCodeOf(properties: unknown): string | null;
export declare function ringContains(ring: readonly Position[], lon: number, lat: number): boolean;
export declare function polygonContains(
  polygon: readonly (readonly Position[])[],
  lon: number,
  lat: number,
): boolean;
export declare function ringAreaAndCentre(ring: readonly Position[]): {
  area: number;
  centre: [number, number];
};
export declare function insidePointOf(
  polygon: readonly (readonly Position[])[],
): { point: [number, number]; how: 'centre' | 'widest stretch' } | null;
export declare function dotRows(step: number): Array<{ lat: number; cells: number }>;
export declare function cellLongitude(j: number, cells: number): number;
export declare function landBits(
  outline: OutlineFeature[],
  step: number,
  codes?: readonly string[],
): LandBits;
export declare function oneDecimal(n: number): number;
export declare function countryPoints(
  outline: OutlineFeature[],
  codes: readonly string[],
  fallback: Readonly<Record<string, readonly [number, number]>>,
  handOnly?: readonly string[],
): CountryPointsResult;
export declare function renderWorldDots(dots: LandBits, step: number): string;
export declare function renderCountryPoints(result: CountryPointsResult): string;
export declare function generateWorld(
  text: string,
  options?: {
    step?: number;
    codes?: readonly string[];
    fallback?: Readonly<Record<string, readonly [number, number]>>;
    handOnly?: readonly string[];
  },
): {
  worldDots: string;
  countryPoints: string;
  dots: LandBits;
  points: CountryPointsResult;
};
export declare function sha256(buffer: Uint8Array | string): string;
export declare function gzipBytes(text: string): number;
