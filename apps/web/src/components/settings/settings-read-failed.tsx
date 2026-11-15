import { TryAgainButton } from '@/components/dashboard/try-again-button';
import { StatePanel } from '@/components/patterns/state-panel';

/**
 * Drawn by a settings page in place of its form when the stored settings it
 * seeds that form from could not be read. A form seeded from defaults would
 * show values that are not what is stored, and its Save sends the whole
 * setting, so saving it would write those defaults over the stored values.
 * The page shows this instead and offers nothing to save. No stored row at
 * all (never configured) is not a failed read: that page shows its defaults.
 *
 * The words and look are the settings error boundary's (settings/error.tsx):
 * the failed-read StatePanel under the page's own header, with Try again,
 * which asks the server for the page again.
 */
export function SettingsReadFailed() {
  return (
    <StatePanel
      kind="failed"
      live="assertive"
      headingLevel={null}
      title="We couldn't load this settings page"
      description="Something went wrong reading it. This is usually temporary, so try again in a moment. The other settings pages still work."
      action={<TryAgainButton size="sm" />}
    />
  );
}
