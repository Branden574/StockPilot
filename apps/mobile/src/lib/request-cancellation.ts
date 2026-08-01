/**
 * Registry of the AbortControllers behind in-flight protected requests.
 *
 * Exists for one job: when an account is evicted, requests ALREADY on the wire
 * have to be cancelled. One that lands after the credentials are cleared would
 * repopulate a cache the eviction just wiped, with data the account may no
 * longer be allowed to read — and it would do so behind the disabled screen,
 * where nothing is watching.
 *
 * Pure (no react-native imports) so it is unit-testable; api.ts registers each
 * request's controller and releases it in its `finally`.
 */

const inFlight = new Set<AbortController>();

/** Registers a controller; returns the release to call when the request settles. */
export function registerInFlight(controller: AbortController): () => void {
  inFlight.add(controller);
  return () => {
    inFlight.delete(controller);
  };
}

/** Aborts every in-flight request. Returns how many were aborted. */
export function abortAllInFlight(): number {
  let aborted = 0;
  for (const controller of inFlight) {
    if (!controller.signal.aborted) {
      try {
        controller.abort();
        aborted += 1;
      } catch {
        /* an abort must never be the thing that fails an eviction */
      }
    }
  }
  inFlight.clear();
  return aborted;
}

export function inFlightCount(): number {
  return inFlight.size;
}
