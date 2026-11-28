import { SECURITY_ALERTS_WORDS as W } from '@stockpilot/core';

/**
 * THE RECORD-ONLY BANNER, one copy for every state of the alerts page: the
 * loading line (the page's Suspense fallback), the refused and could-not-check
 * panels, and the loaded view. No hooks and no client code, so the server page
 * and the client component both render it. `channelOn` adds the note that a
 * channel switch is on while this release still sends nothing.
 */
export function SecurityAlertsRecordOnlyBanner({ channelOn = false }: { channelOn?: boolean }) {
  return (
    <div
      role="note"
      data-slot="security-alerts-record-only"
      className="border-warning/40 bg-warning-wash rounded-lg border px-4 py-3"
    >
      <p className="text-foreground text-[14px] font-semibold">{W.recordOnlyBanner}</p>
      <p className="text-ink-2 mt-1 text-[13px]">{W.recordOnlyNote}</p>
      {channelOn ? <p className="text-ink-2 mt-1 text-[13px]">{W.channelOnNote}</p> : null}
    </div>
  );
}
