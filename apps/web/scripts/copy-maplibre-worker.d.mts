// Hand-written types for the build-time worker copy (the script stays plain
// .mjs so `next build` on Vercel can run it with no TypeScript runtime).
export declare const MAPLIBRE_PUBLIC_DIR: 'maplibre';
export declare const MAPLIBRE_WORKER_FILES: readonly ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];
export declare function copyMaplibreWorker(publicRoot?: string): string;
