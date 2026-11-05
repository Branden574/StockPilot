// Types for install-scene.mjs, read by its vitest guard in apps/web/src/styles/liquid-glass.
export type SceneScheme = 'light' | 'dark';
export interface SceneOutput {
  scheme: SceneScheme;
  app: 'web' | 'phone';
  /** Relative to the repository root. */
  path: string;
  kind: 'copy' | 'avif' | 'webp' | 'blurred-jpeg';
  width?: number;
}
export declare const REPO_ROOT: string;
export declare const SCENE_SHA256: Record<SceneScheme, string>;
export declare const SCENE_SIZE: { width: number; height: number };
export declare const PHONE_BLUR_SIGMA: number;
export declare const SCENE_OUTPUTS: SceneOutput[];
export declare function sha256(bytes: Uint8Array): string;
export declare function trackedOutputs(root: string, outputs?: SceneOutput[]): string[];
export declare function installScene(options?: {
  source?: string;
  root?: string;
  expected?: Record<SceneScheme, string>;
  requireIgnored?: boolean;
}): Promise<{ path: string; bytes: number }[]>;
