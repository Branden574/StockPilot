import { PERMISSION_META } from '@stockpilot/core';

/**
 * What an Items or Books export says when it is refused for good (B68): no
 * permission to export, or the session ended. Trying again cannot help either,
 * so the Customize export dialog says why instead of offering Try again, and
 * never shows the server's bare code ("forbidden", "unauthenticated").
 *
 * Read by the export routes (their 403 body), lib/download-export.ts (which
 * turns those answers into ExportRefusedError), the dialog, and the AI
 * assistant's exportInventory tool. Plain TypeScript, neither 'use client' nor
 * 'server-only', so route handlers and client components can both import it
 * (a 'use client' module's plain exports cannot be called on the server). Not
 * inside lib/download-export.ts: thirteen test files mock that module with a
 * partial factory.
 */

/**
 * A member without items:export. Names the permission as Settings > Roles &
 * permissions names it, from the same label, so the two cannot drift apart.
 */
export const EXPORT_FORBIDDEN_COPY = `You do not have permission to export. Ask an admin for the ${PERMISSION_META['items:export'].label} permission.`;

/** A 401: the session ended. The app's own words for it (the component picker's). */
export const EXPORT_SESSION_ENDED_COPY =
  'Your session has ended. Refresh the page to sign in again.';

/** A refusal Try again cannot fix. Its message is the sentence to show. */
export class ExportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportRefusedError';
  }
}

export function isExportRefused(e: unknown): e is ExportRefusedError {
  return e instanceof ExportRefusedError;
}
