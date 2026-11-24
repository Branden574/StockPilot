import { readPlatformViewerTimeZone } from '@/lib/platform/viewer-time-zone';
import { readPlatformSecurityMap } from '@/server/services/platform/security-map';

import { SecurityMapIsland } from './security-map/security-map-island';

/**
 * THE ATTACK MAP SECTION (server component): the frame of the map and its
 * first values. One read of the whole window (server/services/platform/
 * security-map.ts, the service client; the read is "could not check" on any
 * failure and never throws), handed to the island as its first values. That
 * read cannot carry the viewer's midnight, so the island reads the whole
 * window once more as soon as it mounts, with the viewer's day start: the
 * day's counter says "Not counted yet" only until that read lands
 * (QUESTIONS Q22: two reads of the whole window on open).
 *
 * Rendered only by the gated page /platform/security/map, after
 * requirePlatformAdmin() has answered (security-map.callers.test.ts pins
 * both). What leaves the server is core's view of the answer, never the
 * database's document: a category the map does not show is in no drawing
 * and no plain feed, and its flagged entries are listed with no category,
 * no source and no organization.
 */
export async function PlatformSecurityMapSection() {
  // The zone the viewer chose (their organization's Timezone setting), read
  // beside the map's first read: the page's gate ran before either.
  const [initial, timeZone] = await Promise.all([
    readPlatformSecurityMap({ scope: 'whole', dayStart: null }),
    readPlatformViewerTimeZone(),
  ]);
  return (
    <section aria-label="Attack map" data-slot="platform-security-map" className="min-w-0">
      <SecurityMapIsland initial={initial} timeZone={timeZone} />
    </section>
  );
}
