import path from 'node:path';

/**
 * `PERF_ROLE` is a LABEL for the account (and names its session file). The role
 * written into the results is the one the server reports after sign-in; see
 * auth.setup.ts. There is no default: an unlabelled run is refused at sign-in.
 */
export function roleLabel(): string {
  return (process.env.PERF_ROLE ?? '').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'unlabelled';
}

const AUTH_DIR = path.join('tests', 'perf', '.auth');

/** Session cookies. Gitignored, mode 0600, deleted by the teardown: a storage state IS a signed-in session. */
export function authStatePath(): string {
  return path.join(AUTH_DIR, `${roleLabel()}.json`);
}

/** What the server said about the signed-in account (its role). No email, no ids. */
export function identityPath(): string {
  return path.join(AUTH_DIR, `${roleLabel()}.identity.json`);
}

/** Per-machine secret that keys the URL fingerprints. Never leaves this directory. */
export function fingerprintKeyPath(): string {
  return path.join(AUTH_DIR, 'fingerprint.key');
}

/** Gitignored. A results folder holds timings and image CLASSES only, never a URL. */
export function resultsRoot(): string {
  return process.env.PERF_RESULTS_DIR ?? path.join('perf-results');
}

export function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}
