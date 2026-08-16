/**
 * The recipients notice, as ONE template shared by both compose features.
 *
 * Replaces two hand-written sentences (2026-08-16, per-org email routing):
 * "The DC4 address creates the delivery-request ticket..." and "The DC4
 * address creates the maintenance ticket in the email system...". Both stated
 * L4L-Zendesk-specific knowledge — that mail to the intake address becomes a
 * ticket — which the platform cannot truthfully claim for an arbitrary org's
 * configured mailbox, and both hardcoded "DC4", one tenant's warehouse name.
 * Now that the recipients are per-org data, the notice must be a pure
 * function of them, and it may only claim what StockPilot can observe about
 * ANY mailbox: where the mail is addressed. No "ticket", no "assigned", no
 * "notified" — the accuracy posture the original notices established, kept.
 *
 * ONE template rather than two near-copies (recurring pattern #26): the
 * feature-named wrappers (`deliveryRequestCcNotice`, `maintenanceCcNotice`)
 * exist so call sites read clearly and so each feature's wrapper can be typed
 * against its own recipients shape, but the sentence itself is defined once.
 */
export function ccNotice(recipients: { to: string; cc: string }): string {
  return `This request will be emailed to ${recipients.to}. A copy will also be sent to ${recipients.cc}.`;
}
