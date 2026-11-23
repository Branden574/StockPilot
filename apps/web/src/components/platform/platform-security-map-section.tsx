import { readPlatformSecurityMap } from '@/server/services/platform/security-map';

import { SecurityMapIsland } from './security-map/security-map-island';

/**
 * THE ATTACK MAP SECTION (server component): the frame of the map and its
 * first values. One read of the whole window (server/services/platform/
 * security-map.ts, the service client; the read is "could not check" on any
 * failure and never throws), handed to the island as its first values. That
 * read cannot carry the viewer's midnight, so the day's counter says "Not
 * counted yet" until the island's own first read, which it sends at once.
 *
 * Rendered only by the gated page /platform/security/map, after
 * requirePlatformAdmin() has answered (security-map.callers.test.ts pins
 * both). What leaves the server is core's view of the answer, never the
 * database's document: a category the map does not show is not in it.
 */
export async function PlatformSecurityMapSection() {
  const initial = await readPlatformSecurityMap({ scope: 'whole', dayStart: null });
  return (
    <section aria-label="Attack map" data-slot="platform-security-map" className="min-w-0">
      <SecurityMapIsland initial={initial} />
    </section>
  );
}
