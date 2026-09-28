import { MAINTENANCE_MAX_PHOTOS } from '@stockpilot/core';

/**
 * The photo cap arithmetic, in a module with no native imports so pure
 * modules (exception-evidence.ts) and their node tests can use it. Moved from
 * maintenance-upload.ts (F1-4), which re-exports it unchanged.
 *
 * Pure cap check mirroring the web panel's (maintenance-photos-panel.tsx
 * `handleFiles`) "existing + already-queued + incoming > cap" arithmetic and
 * its exact copy. The server re-enforces this LIVE regardless, at both mint
 * and finalize (maintenance-attachments.ts, IMPORTANT 3) — this exists so
 * the screen can refuse an obviously-too-many selection BEFORE spending a
 * mint call on photo #9, with the same accurate message web already shows.
 */
export function checkPhotoCap(args: {
  existing: number;
  pending: number;
  incoming: number;
  max?: number;
}): { ok: true } | { ok: false; message: string } {
  const max = args.max ?? MAINTENANCE_MAX_PHOTOS;
  if (args.existing + args.pending + args.incoming > max) {
    return { ok: false, message: `A request can carry at most ${max} photos.` };
  }
  return { ok: true };
}
