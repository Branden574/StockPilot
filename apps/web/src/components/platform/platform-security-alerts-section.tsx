import { readPlatformViewerTimeZone } from '@/lib/platform/viewer-time-zone';
import { readPlatformSecurityAlerts } from '@/server/services/platform/security-alerts';

import { SecurityAlertsClient } from './security-alerts/security-alerts-client';

/**
 * THE SECURITY ALERTS SECTION (server component): one read of the alerts
 * (server/services/platform/security-alerts.ts, the service client; "could
 * not check" on any failure, never throwing), handed to the client as its
 * first values with the zone the viewer chose. Rendered only by the gated
 * page /platform/security/alerts, after requirePlatformAdmin() has answered
 * (security-alerts.callers.test.ts pins both). What leaves the server is
 * core's view of the answer, each change's actor as an email, and nothing
 * else.
 */
export async function PlatformSecurityAlertsSection() {
  const [initial, timeZone] = await Promise.all([
    readPlatformSecurityAlerts(),
    readPlatformViewerTimeZone(),
  ]);
  return (
    <section aria-label="Security alerts" data-slot="platform-security-alerts" className="min-w-0">
      <SecurityAlertsClient initial={initial} timeZone={timeZone} />
    </section>
  );
}
