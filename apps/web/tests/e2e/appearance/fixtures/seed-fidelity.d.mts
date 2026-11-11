// Types for seed-fidelity.mjs (apps/web has allowJs off; the unit test imports the runner's guards).
export declare function urlRefusal(url: string | undefined): string | null;
export declare function dockerRefusal(input: {
  dockerHost: string | undefined;
  portLines: string;
  port: string;
}): string | null;
