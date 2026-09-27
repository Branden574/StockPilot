/**
 * What the phone says when a request got no answer from the server at all:
 * offline, a dropped connection, a server that could not be reached. One
 * sentence for every screen (the rental screens, the recount sheet, the
 * verification card and the location screen), so the same failure never
 * reads two ways.
 *
 * The network layer's own text is never shown. On iOS, expo fetch rejects
 * with "fetch failed: UnexpectedException: Could not connect to the server.
 * (at ExpoModulesCore/Promise.swift:56)", and api() re-throws it unchanged;
 * the simulator walks of 2026-09-25 (rentals) and 2026-09-27 (verification)
 * both found it on screen.
 *
 * Dependency-free on purpose: most tests mock ./api, and these words must
 * stay importable under that mock.
 */
export const CONNECTION_FAILURE_COPY =
  'Could not reach the server. Check your connection and try again.';

/** api()'s own sentence when its timeout aborted the request (api.ts). */
export const REQUEST_TIMED_OUT_COPY = 'Request timed out. Check your connection and try again.';
