// Types for appearance-compare.mjs (apps/web has allowJs off; this file lets the
// TypeScript unit test import the plain JavaScript module the lab tool also runs).

export declare const TIMING_METRICS: readonly ['ttfb', 'fcp', 'lcp', 'useful'];
export declare const BYTE_METRICS: readonly [
  'jsBytes',
  'cssBytes',
  'imgBytes',
  'classicGlassCssBytes',
  'sceneBytes',
];
export declare const NOISE_FLOOR_MS: number;
export declare const GLASS_LCP_FACTOR: number;
export declare const LANDING_LCP_MS: number;
export declare const LANDING_CLS: number;
export declare const FRAME_BUDGET_MS: Record<string, number>;
export declare const INP_BUDGET_MS: number;
export declare const SWITCH_BUDGET_MS: number;
export declare const MARGIN_FACTOR: number;
export declare const SCROLL_ROUTES: string[];

export interface LoadSample {
  build: string;
  profile: string;
  route: string;
  mode: 'cold' | 'warm';
  run: number;
  metrics: Record<string, number | null>;
}
export interface ScrollSample {
  build: string;
  profile: string;
  route: string;
  cpu: number;
  material: 'normal' | 'reduced';
  run: number;
  maxFrameMs: number;
  over50: number;
  over100: number;
  loafCount: number;
}
export interface InteractionSample {
  build: string;
  profile: string;
  interaction: string;
  run: number;
  inpMs: number | null;
}
export interface SwitchSample {
  build: string;
  profile: string;
  route: string;
  run: number;
  latencyMs: number | null;
  dataRequests: number;
}
export interface BuildSamples {
  loads: LoadSample[];
  scrolls: ScrollSample[];
  interactions: InteractionSample[];
  switches: SwitchSample[];
}
export interface Verdict {
  check: string;
  route?: string;
  pass: boolean;
  detail: string;
}

export declare function median(values: readonly number[]): number | null;
export declare function spread(values: readonly number[]): number;
export declare function sorted(values: readonly number[]): number[];
export declare function valuesOf(
  s: BuildSamples,
  route: string,
  mode: 'cold' | 'warm',
  metric: string,
  profile?: string,
): number[];
export declare function noiseAllowance(b: readonly number[], bRepeat: readonly number[]): number;
export declare function judge(builds: {
  B: BuildSamples;
  'B-repeat': BuildSamples;
  'branch-classic': BuildSamples;
  'branch-glass': BuildSamples;
}): { verdicts: Verdict[]; table: Array<Record<string, unknown>> };
export declare function allPass(verdicts: readonly Verdict[]): boolean;
