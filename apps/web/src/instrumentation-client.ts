import { recordRouterTransitionStart } from '@/lib/navigation/router-navigation';

/**
 * Next calls this for every App Router navigation it starts: Link clicks,
 * router.push / router.replace and Back/Forward (not refresh or prefetch).
 * It only records the start for the dashboard's progress bar and late
 * skeleton (lib/navigation/router-navigation.ts). No telemetry, nothing sent.
 * Keep this file free of anything else: it runs before hydration on every page.
 */
export function onRouterTransitionStart(
  url: string,
  navigationType: 'push' | 'replace' | 'traverse',
): void {
  recordRouterTransitionStart(url, navigationType);
}
