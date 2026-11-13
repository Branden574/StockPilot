// Types for install-scene.mjs, read by its vitest guards in apps/web and apps/mobile.
export type SceneScheme = 'light' | 'dark';
export interface SceneOutput {
  scheme: SceneScheme;
  app: 'web' | 'phone';
  /** Relative to the repository root. */
  path: string;
  kind: 'copy' | 'avif' | 'webp' | 'blurred-jpeg';
  width?: number;
}
export interface ImageInspection {
  format: 'jpeg' | 'webp' | 'avif';
  width: number | null;
  height: number | null;
  /** Every segment, chunk or box read, in file order. */
  blocks: string[];
  /** Every metadata block found (EXIF, XMP, IPTC, ICC, comment, JUMBF/C2PA, unknown); empty when none. */
  metadata: string[];
}
export declare const REPO_ROOT: string;
export declare const SCENE_SHA256: Record<SceneScheme, string>;
export declare const SCENE_SIZE: { width: number; height: number };
export declare const PHONE_BLUR_SIGMA: number;
export declare const SCENE_MANIFEST: string;
export declare const COMMITTED_SOURCES: Record<SceneScheme, string>;
export declare const SCENE_OUTPUTS: SceneOutput[];
export declare function expectedImage(output: SceneOutput): {
  format: ImageInspection['format'];
  width: number;
  height: number;
};
export declare function sha256(bytes: Uint8Array): string;
export declare function ignoredOutputs(root: string, outputs?: { path: string }[]): string[];
export declare function manifestText(entries: { path: string; sha: string }[]): string;
export declare function readManifest(root?: string): Map<string, string>;
export declare function inspectImage(bytes: Uint8Array): ImageInspection;
export declare function checkScene(options?: {
  root?: string;
  decode?: boolean;
  app?: SceneOutput['app'];
  expected?: Record<SceneScheme, string>;
}): Promise<string[]>;
export declare function installScene(options?: {
  source?: string | Record<SceneScheme, string>;
  fromCommitted?: boolean;
  root?: string;
  expected?: Record<SceneScheme, string>;
  requireCommittable?: boolean;
}): Promise<{ path: string; bytes: number; sha: string }[]>;
